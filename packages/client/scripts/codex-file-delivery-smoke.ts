// Real Codex app-server + MCP + Docker reader, with a local synthetic model response (no paid inference).
// Run with tsx, or bun build --compile this entrypoint. No real provider credentials are used.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createExecutionBrokerSpawn } from '../src/execution-broker-spawn.js';
import { createCodexAuthBroker } from '../src/codex-auth-broker.js';
import { AppServerRpcClient, type AppServerSpawnFn } from '../src/backends/codex-rpc.js';
import { CallerRuntimeConfig } from '../src/caller-runtime-config.js';
import { DockerCallerRuntimePool } from '../src/caller-runtime-docker.js';
import { scopeDigest } from '../src/caller-runtime-store.js';
import { createCallerFileDelivery } from '../src/caller-file-delivery.js';
import { runDockerCommand } from '../src/docker-command.js';
import type { UpFrame } from '@vicoop-bridge/protocol';

const image = process.env.VICOOP_FILE_TEST_IMAGE;
assert.ok(image, 'Set VICOOP_FILE_TEST_IMAGE to a pinned Node-equipped Codex caller image');
const directory = await mkdtemp(join(tmpdir(), 'codex-file-smoke-'));
const agentId = 'files-' + randomUUID();
const config = CallerRuntimeConfig.parse({image, stateDirectory:directory,
  fileDelivery:{allowedRoots:['/workspace/output','/workspace/out\u007fput'],maxBytes:32,maxTotalBytes:48,maxFiles:2}});
const pool = new DockerCallerRuntimePool('codex', config, agentId);
const frames: UpFrame[] = [];
const docker = async(args:string[]) => {
  const r = await runDockerCommand(args);
  assert.equal(r.exitCode,0,r.stderr);
  return r.stdout.trim();
};
const clients: AppServerRpcClient[] = [];
const adapters: ReturnType<typeof createExecutionBrokerSpawn>[] = [];
const grants: AbortSignal[] = [];
const approvalRequests: string[] = [];
let providerCalls = 0;
let firstNamespace: string | undefined;
let failProvider!: (error: unknown) => void;
const providerFailed=new Promise<never>((_,reject)=>{failProvider=reject;});
// Attach immediately so even an unexpected pre-turn request cannot produce an
// unhandled rejection. The main turn race below propagates failures to cleanup.
void providerFailed.catch(()=>{});
const upstream = createServer(async(req,res)=>{
  try {
  let body='';for await(const chunk of req)body+=chunk;
  const request=JSON.parse(body);
  providerCalls++;
  assert.equal(req.headers.authorization,'Bearer fixture-host-only');
  const message={id:'msg_'+randomUUID(),type:'message',role:'assistant',status:'completed',
    content:[{type:'output_text',text:'fixture reply',annotations:[]}]};
  // Drive the real model-facing deferred MCP surface, including discovery.
  // Calling mcpServer/tool/call directly cannot prove that this surface works.
  let output: object=message;
  if(providerCalls===4) {
    output={type:'function_call',id:'fc_stale',call_id:'call_stale',name:'send_file',namespace:firstNamespace,
      arguments:JSON.stringify({path:'/workspace/output/fixture.bin'}),status:'completed'};
  } else if(providerCalls===1 || providerCalls===5) {
    if(providerCalls===5) {
      assert.equal(frames.length,4,'stale namespace must not emit');
      const result=request.input.findLast((i:any)=>i.type==='function_call_output' && i.call_id==='call_stale');
      assert.ok(result, 'stale dispatch must produce a tool error');
      assert.match(JSON.stringify(result.output),/unsupported call/);
    }
    assert.ok(request.tools.some((t:any)=>t.type==='tool_search'));
    output={type:'tool_search_call',id:'search_fixture_'+providerCalls,call_id:'search_fixture_'+providerCalls,
      execution:'client',arguments:{query:'send_file',limit:1},status:'completed'};
  } else if(providerCalls===2 || providerCalls===6) {
    const search=request.input.findLast((i:any)=>i.type==='tool_search_output');
    const namespace=search.tools.find((t:any)=>t.tools?.some((tool:any)=>tool.name==='send_file'));
    assert.ok(namespace,'model must discover send_file');
    if(providerCalls===2) firstNamespace=namespace.name;
    else assert.notEqual(namespace.name,firstNamespace,'rediscovery must find new namespace');
    output={type:'function_call',id:'fc_fixture_'+providerCalls,call_id:'call_fixture_'+providerCalls,name:'send_file',
      namespace:namespace.name,arguments:JSON.stringify({path:'/workspace/output/fixture.bin'}),status:'completed'};
  }
  const response={id:'resp_'+randomUUID(),object:'response',model:'gpt-5.5',
    status:'completed',output:[output],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const event of [
    {type:'response.created',response:{...response,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...output,status:'in_progress'}},
    {type:'response.output_item.done',output_index:0,item:output},
    {type:'response.completed',response},
  ]) res.write('data: '+JSON.stringify(event)+'\n\n');
  res.end();
  } catch(error) {
    failProvider(error);
    res.destroy();
  }
});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const upstreamUrl='http://127.0.0.1:'+(upstream.address() as {port:number}).port;
async function runModelTurn(rpc:AppServerRpcClient,threadId:string,text:string) {
  let unsubscribe=()=>{};
  const completed=new Promise<any>(resolve=>{
    unsubscribe=rpc.onNotification((method,params)=>{
      if(method==='turn/completed')resolve(params);
    });
  });
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const outcome=await Promise.race([
      providerFailed,
      (async()=>{
        await rpc.request('turn/start',{threadId,input:[{type:'text',text}]});
        return completed;
      })(),
      rpc.waitForClose().then(()=>{throw Error('Codex closed before turn completion');}),
      new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(Error('Codex turn completion timed out')),30000);
      }),
    ]);
    assert.equal(outcome.turn.status,'completed');
  } finally {clearTimeout(timer);unsubscribe();}
}

try {
  await pool.initialize();
  const containers = await Promise.all(['alice','bob'].map(p=>pool.acquire(scopeDigest(agentId,p),undefined,p)));
  for (const [i,c] of containers.entries()) {
    await docker(['exec',c.dockerId!,'node','-e',`
      const fs=require('fs');fs.mkdirSync('/workspace/output',{recursive:true});
      fs.writeFileSync('/workspace/output/fixture.bin',Buffer.from([0,255,128,${i}]));
      fs.writeFileSync('/workspace/private','secret');
      fs.symlinkSync('/workspace/private','/workspace/output/link');
      fs.writeFileSync('/workspace/output/large',Buffer.alloc(33));
    `]);
  }
  const version = await docker(['exec',containers[0].dockerId!,'codex','--version']);
  async function start(index:number,taskId:string,enabled=true,resume?:string) {
    const signal = new AbortController();
    const files = createCallerFileDelivery(containers[index].dockerId!,taskId,f=>frames.push(f),signal.signal,config.fileDelivery!);
    const adapter = createExecutionBrokerSpawn(containers[index].dockerId!, {
      backend:'codex',ttlMs:60000,
      createBroker:()=>createCodexAuthBroker({authentication:'api-key',upstream:upstreamUrl,
        credential:()=>({kind:'api-key',secret:'fixture-host-only'})}),
      ...(enabled ? {fileDelivery:{description:'Deliver fixture files from '+config.fileDelivery!.allowedRoots.join(', '),bind:()=>async(input:unknown,execution:AbortSignal)=>{
        grants.push(execution);return files.send(input,execution);
      }}} : {}),
    });
    adapters.push(adapter);
    const rpc = new AppServerRpcClient({spawn:adapter.spawn as AppServerSpawnFn,cwd:'/workspace'});
    clients.push(rpc);
    rpc.setServerRequestHandler(async(_id,method)=>{
      approvalRequests.push(method);return {decision:'decline'};
    });
    rpc.start();
    await rpc.request('initialize',{clientInfo:{name:'file-smoke',version:'1'},capabilities:{experimentalApi:true}});
    rpc.notify('initialized');
    await rpc.authenticateExecution();
    const thread = await rpc.request<{thread:{id:string}}>(resume ? 'thread/resume' : 'thread/start',{...(resume ? {threadId:resume} : {}),cwd:'/workspace',sandbox:'danger-full-access',approvalPolicy:'untrusted',model:'gpt-5.5'});
    // Thread startup can return while MCP reports 'starting', even after
    // tools have been enumerated. Wait for the final state before asserting.
    const inventoryDeadline=Date.now()+10000;
    let inventory:any,server:any;
    do {
      inventory=await rpc.request<any>('mcpServerStatus/list',{threadId:thread.thread.id});
      server=inventory.data.find((s:any)=>/^_vb-send-file-[a-f0-9]{24}$/.test(s.name) && s.runtimeStatus==='connected');
      if(!enabled || server || Date.now()>=inventoryDeadline)break;
      await new Promise(resolve=>setTimeout(resolve,25));
    } while(true);
    assert.equal(Boolean(server),enabled,JSON.stringify(inventory));
    if(enabled) assert.ok(Object.values(server.tools).some((t:any)=>t.name==='send_file'),JSON.stringify(server));
    const call = (path:string) => rpc.request<any>('mcpServer/tool/call',{
      threadId:thread.thread.id,server:server?.name ?? '_vb-send-file',tool:'send_file',arguments:{path},
    });
    return {rpc,files,call,signal,threadId:thread.thread.id,serverName:server?.name};
  }
  const [a,b] = await Promise.all([start(0,'alice-task'),start(1,'bob-task')]);
  for (const path of ['/workspace/private','/workspace/output/link','/workspace/output/large']) {
    const result=await a.call(path);
    assert.equal(result.isError,true,JSON.stringify(result));
  }
  await Promise.all([a.call('/workspace/output/fixture.bin'),b.call('/workspace/output/fixture.bin')]);
  assert.equal(frames.length,2);
  for(const f of frames) {
    assert.equal(f.type,'task.artifact');
    if(f.type!=='task.artifact')continue;
    const part=f.artifact.parts[0];assert.equal(part.kind,'file');
    if(part.kind==='file')assert.deepEqual(Buffer.from(part.file.bytes!,'base64'),
      Buffer.from([0,255,128,f.taskId==='alice-task'?0:1]));
  }
  // A completed turn persists a real rollout so the next app-server can resume.
  await runModelTurn(a.rpc,a.threadId,'fixture');
  assert.deepEqual(approvalRequests,[],'operator-enabled send_file must work under remote approvals');
  assert.equal(providerCalls,3,'search, discovered tool call, and final model response');
  assert.equal(frames.length,3,'model-dispatched call must deliver an actual artifact');
  const modelFile=frames.at(-1)!;
  assert.equal(modelFile.type,'task.artifact');
  if(modelFile.type==='task.artifact') {
    assert.equal(modelFile.taskId,'alice-task');
    const part=modelFile.artifact.parts[0];
    assert.equal(part.kind,'file');
    if(part.kind==='file')assert.deepEqual(Buffer.from(part.file.bytes!,'base64'),Buffer.from([0,255,128,0]));
  }
  assert.equal((await a.call('/workspace/output/fixture.bin')).isError,true,'model call consumes task file budget');
  a.rpc.kill();await a.rpc.waitForClose();await a.files.settle();
  assert.ok(grants.some(s=>s.aborted));
  b.rpc.kill();await b.rpc.waitForClose();await b.files.settle();
  assert.ok(grants.every(s=>s.aborted),'all completed grants must be revoked');
  // Old configurations must not collide with the next execution's server.
  // A legacy fixed name and the prior execution name both use HTTP transport;
  // merging either with our stdio command would make Codex reject the config.
  const staleConfig=['_vb-send-file',a.serverName].flatMap(name=>[
    '[mcp_servers.'+name+']',
    'url = "http://127.0.0.1:1/old-mcp"',
    'enabled = false',
    'enabled_tools = ["old_tool"]',
    'disabled_tools = ["send_file"]',
    '[mcp_servers.'+name+'.tools.send_file]',
    'approval_mode = "prompt"',
    '',
  ]).join('\n');
  await docker(['exec',containers[0].dockerId!,'node','-e',
    "require('fs').writeFileSync('/data/sessions/codex/config/config.toml',process.argv[1])",staleConfig]);
  const resumed=await start(0,'alice-resumed',true,a.threadId);
  assert.notEqual(resumed.serverName,a.serverName);
  assert.notEqual((await resumed.call('/workspace/output/fixture.bin')).isError,true);
  assert.equal(frames.at(-1)?.type,'task.artifact');
  assert.equal((frames.at(-1) as any).taskId,'alice-resumed');
  await assert.rejects(resumed.rpc.request('mcpServer/tool/call',{
    threadId:resumed.threadId,server:a.serverName,tool:'send_file',arguments:{path:'/workspace/output/fixture.bin'},
  }));
  await runModelTurn(resumed.rpc,resumed.threadId,'Send the fixture again');
  assert.equal(providerCalls,7);
  assert.equal(frames.length,5,'new namespace must deliver once');
  const resumedFile=frames.at(-1)!;
  assert.equal(resumedFile.type,'task.artifact');
  if(resumedFile.type==='task.artifact') {
    assert.equal(resumedFile.taskId,'alice-resumed');
    const part=resumedFile.artifact.parts[0];
    assert.equal(part.kind,'file');
    if(part.kind==='file')assert.deepEqual(Buffer.from(part.file.bytes!,'base64'),Buffer.from([0,255,128,0]));
  }
  assert.deepEqual(approvalRequests,[]);
  resumed.rpc.kill();await resumed.rpc.waitForClose();
  await docker(['exec',containers[0].dockerId!,'rm','/data/sessions/codex/config/config.toml']);
  const disabled=await start(0,'disabled',false,a.threadId);
  await assert.rejects(disabled.call('/workspace/output/fixture.bin'));
  disabled.rpc.kill();await disabled.rpc.waitForClose();
  assert.ok(providerCalls>0);
  for(const c of containers) {
    const remaining=await docker(['exec',c.dockerId!,'node','-e',`
      const fs=require('fs');const found=[];
      for(const p of fs.readdirSync('/proc')){if(!/^\\d+$/.test(p)||Number(p)===process.pid)continue;
        try{const s=fs.readFileSync('/proc/'+p+'/cmdline','utf8');
          if(s.includes('vicoop-caller-files')||s.includes('app-server'))found.push(p);}catch{}}
      console.log(JSON.stringify(found));
    `]);
    assert.equal(remaining,'[]','MCP helper or app-server survived cleanup');
  }
  console.log(JSON.stringify({result:'PASS',version,runtime:process.versions.bun?'Bun compiled':'Node',
    checks:['native MCP registration','native tool invocation','model tool search and namespaced dispatch under untrusted approvals','actual file bytes','concurrent callers','path/symlink/size/count errors','disabled delivery','execution grant revocation','process cleanup','native thread resume with persisted conflicting MCP transports and filters','stale namespace rejected and resumed model rediscovers tool','local mock inference only']}));
} finally {
  for(const rpc of clients)rpc.kill();
  await Promise.all(clients.map(c=>c.waitForClose()));
  for(const a of adapters)a.close();
  for(const id of await pool.store.scopes())await pool.remove(id,true);
  await pool.close();await rm(directory,{recursive:true,force:true});
  upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));
}
