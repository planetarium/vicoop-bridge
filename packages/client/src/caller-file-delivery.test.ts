import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { createExecutionBrokerSpawn } from './execution-broker-spawn.js';
import { createCodexAuthBroker } from './codex-auth-broker.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createCallerFileDelivery, CallerFileDeliveryConfig } from './caller-file-delivery.js';
import { runBoundedCommand, type AsyncDockerRun } from './docker-command.js';
import type { UpFrame } from '@vicoop-bridge/protocol';
import { createClaudeBrokerSpawn } from './claude-broker-spawn.js';

const localRead: AsyncDockerRun = (args, options) => runBoundedCommand(process.execPath, args.slice(args.indexOf('/usr/local/bin/node') + 1), options);

test('file policy rejects non-workspace, traversal and trailing slash roots', () => {
  for (const root of ['/', '/workspace', '/workspace/', '/workspace/output/', '/workspace/../etc', '/workspace/a/../../etc'])
    assert.equal(CallerFileDeliveryConfig.safeParse({allowedRoots:[root]}).success, false, root);
  assert.ok(CallerFileDeliveryConfig.parse({allowedRoots:['/workspace/output']}));
});

// The descriptor traversal is Linux-specific, just like Docker caller runtimes.
test('trusted reader rejects escape links and enforces per-file/task budgets', {skip:process.platform !== 'linux'}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'caller-files-'));
  try {
    const output = join(dir, 'output'); await mkdir(output);
    await writeFile(join(output, 'a.png'), Buffer.from([137,80,78,71]));
    await writeFile(join(output, 'b.wav'), Buffer.from([82,73,70,70]));
    await writeFile(join(dir, 'private'), 'secret');
    await symlink(join(dir, 'private'), join(output, 'escape'));
    await symlink(dir, join(output, 'dir-escape'));
    await link(join(dir, 'private'), join(output, 'hardlink'));
    const frames: UpFrame[] = [], signal = new AbortController().signal;
    const config = {allowedRoots:[output],maxBytes:4,maxTotalBytes:6,maxFiles:2};
    const delivery = createCallerFileDelivery('caller-a', 'task-a', frame => frames.push(frame), signal, config, localRead);
    for (const path of [join(dir, 'private'), join(output, 'escape'), join(output,'dir-escape/private'), join(output,'hardlink')])
      await assert.rejects(delivery.send({path}, signal));
    await delivery.send({path:join(output, 'a.png')}, signal);
    await assert.rejects(delivery.send({path:join(output, 'b.wav')}, signal), /too-large/);
    assert.equal(frames.length, 1);
    if (frames[0].type !== 'task.artifact') throw Error('missing artifact');
    assert.equal(frames[0].taskId, 'task-a');
    assert.deepEqual(frames[0].artifact.parts, [{kind:'file',file:{name:'a.png',mimeType:'image/png',bytes:'iVBORw=='}}]);
    const count = createCallerFileDelivery('a','t',()=>{},signal,{...config,maxFiles:1,maxTotalBytes:20},localRead);
    await count.send({path:join(output,'a.png')},signal);
    await assert.rejects(count.send({path:join(output,'a.png')},signal),/count/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('revoked execution and canceled tasks cannot emit even when Docker read finishes late', async () => {
  for (const cancelTask of [false,true]) {
    const task = new AbortController(), execution = new AbortController(), frames: UpFrame[] = [];
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(r=>{entered=r;});
    const read = new Promise<void>(r=>{release=r;});
    const config = CallerFileDeliveryConfig.parse({allowedRoots:['/workspace/output']});
    const delivery = createCallerFileDelivery('a','old-task',f=>frames.push(f),task.signal,config,async()=>{
      entered(); await read; return {exitCode:0,stdout:'{"bytes":"eA=="}',stderr:''};
    });
    const result = delivery.send({path:'/workspace/output/x.png'},execution.signal);
    await started;
    (cancelTask?task:execution).abort(); release();
    await assert.rejects(result); assert.deepEqual(frames,[]);
    await assert.rejects(delivery.send({path:'/workspace/output/x.png'},execution.signal));
  }
});

const localSpawn: typeof spawn = ((_command: string,args: string[],options: object) => {
  const directory = mkdtempSync(join(tmpdir(), 'file-relay-'));
  const source = args[args.length-1].replace("env.CODEX_HOME='/data/sessions/codex/config'", 'env.CODEX_HOME='+JSON.stringify(directory));
  const child = spawn('/bin/sh',['-c','"$@"; exit 0','supervisor-stand-in',process.execPath,'-e',source],
    {...options,env:{PATH:process.env.PATH}});
  child.on('close',()=>rmSync(directory,{recursive:true,force:true}));
  return child;
}) as typeof spawn;

function fileAdapter(kind: 'claude' | 'codex', fileDelivery: NonNullable<Parameters<typeof createExecutionBrokerSpawn>[1]['fileDelivery']>) {
  return createExecutionBrokerSpawn('fixture', {backend:kind,spawnImpl:localSpawn,fileDelivery,
    createBroker:()=>createCodexAuthBroker({authentication:'api-key',credential:()=>({kind:'api-key',secret:'fixture'})})});
}

const helperLookup = String.raw`
const args=process.argv.slice(1);
const override=args.find(a=>a.startsWith('mcp_servers._vb-send-file='));
const helper=override
  ? {args:JSON.parse(override.match(/args=(\[.*\]),enabled=true}/s)[1])}
  : JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers['_vb-send-file'];
`;

for (const kind of ['claude','codex'] as const) test(`real ${kind} relay injects stdio MCP, captures executions, reports tool errors and revokes on exit`, async () => {
  const calls: unknown[] = [], executionSignals: AbortSignal[] = [];
  let generation = 0;
  const adapter = fileAdapter(kind,{description:'Send files \u007f',bind(){
    const bound = ++generation;
    return async (input,signal)=>{
      calls.push({bound,input});executionSignals.push(signal);
      if ((input as any).path === '/denied') throw Error('private host diagnostic');
      return {delivered:true};
    };
  }});
  try {
    for(let i=0;i<2;i++) {
      const script = `
      const {spawn}=require('node:child_process');const assert=require('node:assert/strict');
      ${helperLookup}
      assert.ok(helper.args[4].endsWith(String.fromCharCode(127)));
      if(override)assert.ok(!override.includes(String.fromCharCode(127)));
      const p=spawn(process.execPath,helper.args,{stdio:['pipe','pipe','inherit']});
      let text='';p.stdout.on('data',chunk=>{text+=chunk;const lines=text.split('\\n');text=lines.pop();for(const l of lines){if(!l)continue;const r=JSON.parse(l);
        if(r.id===1)p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'send_file',arguments:{path:'/denied'}}})+'\\n');
        if(r.id===2){assert.equal(r.result.isError,true);assert.ok(!JSON.stringify(r).includes('private host diagnostic'));p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'send_file',arguments:{path:'/workspace/output/file.png'}}})+'\\n');}
        if(r.id===3){console.log(JSON.stringify(r.result));p.kill();process.exit(r.result.isError?1:0);}
      }});
      p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}})+'\\n');
      `;
      const child = adapter.spawn(process.execPath,['-e',script,'--','--mcp-config','{"mcpServers":{}}'],{});
      const output: Buffer[]=[];child.stdout!.on('data',chunk=>output.push(chunk));
      child.stdin!.end();
      const code = await new Promise<number|null>(resolve=>child.on('close',resolve));
      assert.equal(code,0,Buffer.concat(output).toString());
      assert.match(Buffer.concat(output).toString(),/delivered/);
      assert.ok(executionSignals.at(-1)!.aborted);
    }
    assert.deepEqual(calls,[1,2].flatMap(bound=>['/denied','/workspace/output/file.png'].map(path=>({bound,input:{path}}))));
  } finally { adapter.close(); }
});

for (const split of [1,2]) test(`Docker stdout preserves send_file UTF-8 split after byte ${split}`, async () => {
  const received: unknown[]=[];
  const fixtureSpawn: typeof spawn=((_command:string,_args:string[],options:object)=>spawn(process.execPath,['-e',`
    let pending='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{pending+=chunk;let index;while((index=pending.indexOf('\\n'))>=0){const m=JSON.parse(pending.slice(0,index));pending=pending.slice(index+1);if(m.t==='start'){
      console.log(JSON.stringify({t:'ready'}));
      const frame=Buffer.from(JSON.stringify({t:'send-file',id:1,token:m.fileDelivery.token,input:{path:'/workspace/output/한.png'}})+'\\n');
      const split=frame.indexOf(Buffer.from('한'))+${split};process.stdout.write(frame.subarray(0,split));setTimeout(()=>process.stdout.write(frame.subarray(split)),10);
    }else if(m.t==='file-result'){console.log(JSON.stringify({t:'exit',code:0}));process.exit(0);}}});
  `],options)) as typeof spawn;
  const adapter=createClaudeBrokerSpawn('fixture',{spawnImpl:fixtureSpawn,credential:()=>({kind:'oauth',secret:'fixture'}),fileDelivery:{description:'files',bind:()=>async input=>{received.push(input);return {};}}});
  try{
    const child=adapter.spawn('unused',[],{});child.stdin!.end();
    assert.equal(await new Promise(resolve=>child.on('close',resolve)),0);
    assert.deepEqual(received,[{path:'/workspace/output/한.png'}]);
  }finally{adapter.close();}
});

for (const kind of ['claude','codex'] as const) test(`overlapping ${kind} relays reject wrong-scope and stale tokens and close canceled endpoints`, async () => {
  const calls: string[]=[];
  const make=(scope:string)=>fileAdapter(kind,{description:'files',bind:()=>async()=>{calls.push(scope);return {delivered:true};}});
  const a=make('a'),b=make('b'),children: Array<{child:ReturnType<typeof a.spawn>;closed:Promise<unknown>}> = [];
  async function start(adapter:typeof a){
    const script=`${helperLookup}console.log(JSON.stringify({url:helper.args[2],token:helper.args[3]}));setInterval(()=>{},1000);`;
    const child=adapter.spawn(process.execPath,['-e',script,'--','--mcp-config','{"mcpServers":{}}'],{});
    const closed=new Promise(resolve=>child.on('close',resolve));children.push({child,closed});
    let pending='';const endpoint=await new Promise<{url:string;token:string}>(resolve=>child.stdout!.on('data',chunk=>{pending+=chunk.toString();if(pending.includes('\n'))resolve(JSON.parse(pending.split('\n')[0]));}));
    child.stdin!.end();return {child,closed,...endpoint};
  }
  const send=(url:string,token:string)=>fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{"path":"/workspace/output/test.png"}',signal:AbortSignal.timeout(2000)});
  try{
    const [first,other]=await Promise.all([start(a),start(b)]);
    assert.equal((await send(first.url,'wrong-token')).status,403);
    assert.equal((await send(first.url,other.token)).status,403);
    assert.equal((await send(other.url,first.token)).status,403);
    assert.deepEqual(calls,[]);
    assert.deepEqual(await (await send(first.url,first.token)).json(),{delivered:true});
    assert.deepEqual(await (await send(other.url,other.token)).json(),{delivered:true});
    first.child.kill('SIGTERM');await first.closed;
    await assert.rejects(send(first.url,first.token));
    const next=await start(a);
    assert.notEqual(first.token,next.token);
    assert.equal((await send(next.url,first.token)).status,403);
    assert.deepEqual(await (await send(next.url,next.token)).json(),{delivered:true});
    assert.deepEqual(calls,['a','b','a']);
  }finally{
    for(const {child} of children)child.kill('SIGTERM');
    await Promise.all(children.map(({closed})=>closed));a.close();b.close();
  }
});

for (const failure of ['throw','nonzero'] as const) test(`uncertain Docker read (${failure}) poisons delivery and closes execution before reuse`, async () => {
  let calls=0,closed=0,entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const signal=new AbortController().signal;
  const delivery=createCallerFileDelivery('caller','task',()=>assert.fail('no artifact expected'),signal,
    CallerFileDeliveryConfig.parse({allowedRoots:['/workspace/output']}),async()=>{
      calls++;entered();await pending;
      if(failure==='throw')throw Error('local Docker CLI timed out');
      return {exitCode:137,stdout:'',stderr:''};
    },()=>{closed++;});
  const request=delivery.send({path:'/workspace/output/x'},signal);
  await started;
  let settled=false;const draining=delivery.settle().then(()=>{settled=true;});
  await Promise.resolve();assert.equal(settled,false);
  release();await assert.rejects(request);await draining;
  assert.equal(delivery.healthy(),false);assert.equal(closed,1);
  await assert.rejects(delivery.send({path:'/workspace/output/x'},signal),/cleanup is unconfirmed/);
  assert.equal(calls,1);assert.equal(closed,1);
});

test('clean reader policy rejection keeps execution reusable', async () => {
  const signal=new AbortController().signal;
  let calls=0;
  const delivery=createCallerFileDelivery('caller','task',()=>{},signal,
    CallerFileDeliveryConfig.parse({allowedRoots:['/workspace/output']}),async()=>({exitCode:0,stderr:'',
      stdout:++calls===1?'{"error":"outside-roots"}':'{"bytes":"eA=="}'}),()=>assert.fail('clean rejection must not stop caller'));
  await assert.rejects(delivery.send({path:'/workspace/private'},signal),/outside-roots/);
  await delivery.send({path:'/workspace/output/x'},signal);await delivery.settle();
  assert.equal(delivery.healthy(),true);
});
