import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {RuntimeContainer} from '../../src/runtime-container.js';
import {createCodexCredentialReader,createCodexAuthBroker,loadCodexModelCatalog} from '../../src/codex-auth-broker.js';
import {createExecutionBrokerSpawn} from '../../src/execution-broker-spawn.js';
import {createCodexExecutionBackend} from '../../src/backends/codex-execution.js';
import type {UpFrame,TaskAssignFrame} from '@vicoop-bridge/protocol';

const name='codex-auth-'+randomBytes(5).toString('hex');
const runtime=new RuntimeContainer({backendKind:'codex',runtimeName:name,createIfMissing:true,failIfExists:true});
const container=runtime.getContainerName();
const docker=(args:string[])=>{
 const r=spawnSync('docker',args,{encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024});
 if(r.status!==0)throw new Error(`Docker ${args[0]} failed; output withheld`);
 return r.stdout;
};
const credential=createCodexCredentialReader();
const selected=await credential();
let executions=0;
const brokers:ReturnType<typeof createCodexAuthBroker>[]=[];
const codexCatalog=await loadCodexModelCatalog(credential,'0.153.4');
const adapter=createExecutionBrokerSpawn(container,{backend:'codex',codexCatalog,ttlMs:90000,createBroker:()=>{
 executions++;
 const b=createCodexAuthBroker({credential,authentication:selected.kind,ttlMs:90000});brokers.push(b);return b;
}});
const logger={info(){},warn(){},error(){},debug(){}};
const model=process.env.VICOOP_SMOKE_CODEX_MODEL;
assert.ok(model,'Set VICOOP_SMOKE_CODEX_MODEL to a model supported by the host account');
const backend=createCodexExecutionBackend({spawn:adapter.spawn,appServerArgs:['app-server','-c',`model=${JSON.stringify(model)}`],
 sandboxMode:'danger-full-access',approvalDecision:'accept',initializeTimeoutMs:15000,turnTimeoutMs:60000,logger,
 readCodexConfigToml:async()=>`model=${JSON.stringify(model)}`});
const task=(text:string,contextId='memory'):TaskAssignFrame=>({type:'task.assign',taskId:randomUUID(),contextId,message:{role:'user',messageId:randomUUID(),parts:[{kind:'text',text}]}});
async function run(text:string,context='memory') {
 const frames:UpFrame[]=[];
 await backend.handle(task(text,context),f=>frames.push(f),AbortSignal.timeout(70000));
 assert.ok(!JSON.stringify(frames).includes(selected.secret),'provider credential leaked into task frames');
 const last=frames.at(-1);
 console.log(JSON.stringify({brokerStats:brokers.map(b=>b.stats),terminal:last?.type,state:last?.type==='task.complete'?last.status.state:undefined,error:last?.type==='task.fail'?last.error:undefined}));
 assert.equal(last?.type,'task.complete');
 assert.equal((last as any).status.state,'completed');
 return frames.filter(f=>f.type==='task.artifact').flatMap(f=>f.artifact.parts).filter(p=>p.kind==='text').map(p=>(p as any).text).join('');
}
try {
 await runtime.start();
 docker(['exec','--user','0',container,'/bin/chown','-R','node:node','/data/agents/codex','/data/sessions/codex']);
 docker(['exec',container,'/usr/local/lib/vicoop-bridge/install-backend.sh','codex','--version','0.153.4']);
 console.log(JSON.stringify({version:docker(['exec',container,'/data/agents/codex/bin/codex','--version']).trim()}));
 const caps=await backend.resolveCapabilities!();console.log(JSON.stringify({models:caps.openaiCompatModels?.length}));
 const first=await run('Remember ORCHID. Reply only OK.');assert.match(first,/OK/);
 const second=await run('What word did I ask you to remember? Reply only that word.');assert.match(second,/ORCHID/);
 const result=await run('Use a shell tool to write CODEX_BROKER_OK to /data/sessions/codex/probe.txt and read it back. Reply only that text.','tools');
 assert.match(result,/CODEX_BROKER_OK/);
 assert.equal(docker(['exec',container,'/bin/cat','/data/sessions/codex/probe.txt']).trim(),'CODEX_BROKER_OK');
 assert.ok(executions>=4,'app-server was shared across executions');
 const parallel=await Promise.all([run('Reply only FIRST.','parallel-one'),run('Reply only SECOND.','parallel-two')]);
 assert.match(parallel[0],/FIRST/);assert.match(parallel[1],/SECOND/);
 const cancel=new AbortController();
 const canceledFrames:UpFrame[]=[];
 const pending=backend.handle(task('Execute this shell command exactly, then wait for it to finish: echo $$ > /data/sessions/codex/cancel.pid; sleep 45','cancel'),f=>canceledFrames.push(f),cancel.signal);
 let pid='';
 try {
  const deadline=Date.now()+45000;
  while(Date.now()<deadline) {
   pid=docker(['exec',container,'/bin/sh','-c','cat /data/sessions/codex/cancel.pid 2>/dev/null || true']).trim();
   if(pid)break;
   await new Promise(r=>setTimeout(r,300));
  }
  assert.match(pid,/^\d+$/,'cancel probe never reached its shell tool');
 } finally {cancel.abort();await pending;}
 assert.equal((canceledFrames.at(-1) as any)?.status?.state,'canceled');
 assert.equal(docker(['exec',container,'/bin/sh','-c',`test ! -e /proc/${pid} && echo clean`]).trim(),'clean','tool process survived terminal cancellation');
 const clean=docker(['exec',container,'/bin/sh','-c','test ! -f /data/creds/codex/auth.json && test ! -f /data/sessions/codex/config/auth.json && echo clean']);
 assert.match(clean,/clean/);
 console.log(JSON.stringify({success:true,mode:selected.kind,executions,inference:true,resume:true,tools:true,cancellationCleanup:true,credentialFilesAbsent:true}));
} finally {
 backend.stop?.();adapter.close();
 spawnSync('docker',['rm','-f',container],{stdio:'ignore'});
 for(const prefix of ['agents','sessions'])spawnSync('docker',['volume','rm',`vicoop-${prefix}-${name}`],{stdio:'ignore'});
}
