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
  fileDelivery:{allowedRoots:['/workspace/output'],maxBytes:32,maxTotalBytes:48,maxFiles:2}});
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
let providerCalls = 0;
const upstream = createServer(async(req,res)=>{
  for await(const _ of req) {}
  providerCalls++;
  assert.equal(req.headers.authorization,'Bearer fixture-host-only');
  const message={id:'msg_'+randomUUID(),type:'message',role:'assistant',status:'completed',
    content:[{type:'output_text',text:'fixture reply',annotations:[]}]};
  const response={id:'resp_'+randomUUID(),object:'response',model:'gpt-5.5',
    status:'completed',output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const event of [
    {type:'response.created',response:{...response,status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}},
    {type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'fixture reply'},
    {type:'response.output_item.done',output_index:0,item:message},
    {type:'response.completed',response},
  ]) res.write('data: '+JSON.stringify(event)+'\n\n');
  res.end();
});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const upstreamUrl='http://127.0.0.1:'+(upstream.address() as {port:number}).port;
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
      ...(enabled ? {fileDelivery:{description:'Deliver fixture files',bind:()=>async(input:unknown,execution:AbortSignal)=>{
        grants.push(execution);return files.send(input,execution);
      }}} : {}),
    });
    adapters.push(adapter);
    const rpc = new AppServerRpcClient({spawn:adapter.spawn as AppServerSpawnFn,cwd:'/workspace'});
    clients.push(rpc);rpc.start();
    await rpc.request('initialize',{clientInfo:{name:'file-smoke',version:'1'},capabilities:{experimentalApi:true}});
    rpc.notify('initialized');
    await rpc.authenticateExecution();
    const thread = await rpc.request<{thread:{id:string}}>(resume ? 'thread/resume' : 'thread/start',{...(resume ? {threadId:resume} : {}),cwd:'/workspace',sandbox:'danger-full-access',approvalPolicy:'never'});
    const inventory = await rpc.request<any>('mcpServerStatus/list',{threadId:thread.thread.id});
    const server = inventory.data.find((s:any)=>s.name==='_vb-send-file');
    assert.equal(Boolean(server),enabled,JSON.stringify(inventory));
    if(enabled) assert.ok(Object.values(server.tools).some((t:any)=>t.name==='send_file'),JSON.stringify(server));
    const call = (path:string) => rpc.request<any>('mcpServer/tool/call',{
      threadId:thread.thread.id,server:'_vb-send-file',tool:'send_file',arguments:{path},
    });
    return {rpc,files,call,signal,threadId:thread.thread.id};
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
  const again=await a.call('/workspace/output/fixture.bin');
  assert.notEqual(again.isError,true,JSON.stringify(again));
  assert.equal((await a.call('/workspace/output/fixture.bin')).isError,true);
  // A completed turn persists a real rollout so the next app-server can resume.
  const completed=new Promise<any>(resolve=>a.rpc.onNotification((method,params)=>{
    if(method==='turn/completed')resolve(params);
  }));
  await a.rpc.request('turn/start',{threadId:a.threadId,input:[{type:'text',text:'fixture'}]});
  assert.equal((await completed).turn.status,'completed');
  a.rpc.kill();await a.rpc.waitForClose();await a.files.settle();
  assert.ok(grants.some(s=>s.aborted));
  b.rpc.kill();await b.rpc.waitForClose();await b.files.settle();
  assert.ok(grants.every(s=>s.aborted),'all completed grants must be revoked');
  const resumed=await start(0,'alice-resumed',true,a.threadId);
  assert.notEqual((await resumed.call('/workspace/output/fixture.bin')).isError,true);
  assert.equal(frames.at(-1)?.type,'task.artifact');
  assert.equal((frames.at(-1) as any).taskId,'alice-resumed');
  resumed.rpc.kill();await resumed.rpc.waitForClose();
  const disabled=await start(0,'disabled',false);
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
    checks:['native MCP registration','native tool invocation','actual file bytes','concurrent callers','path/symlink/size/count errors','disabled delivery','execution grant revocation','process cleanup','native thread resume','local mock inference only']}));
} finally {
  for(const rpc of clients)rpc.kill();
  await Promise.all(clients.map(c=>c.waitForClose()));
  for(const a of adapters)a.close();
  for(const id of await pool.store.scopes())await pool.remove(id,true);
  await pool.close();await rm(directory,{recursive:true,force:true});
  upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));
}
