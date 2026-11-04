import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CallerFileDeliveryConfig, createCallerFileDelivery } from './caller-file-delivery.js';
import { runDockerCommand } from './docker-command.js';
import type { TaskAssignFrame, UpFrame } from '@vicoop-bridge/protocol';

const image = process.env.VICOOP_FILE_TEST_IMAGE;
test('real Docker trusted reader confines paths and task budgets to each caller', {skip: !image, timeout:60000}, async () => {
  const names = [0,1].map(()=>`vicoop-file-test-${randomUUID()}`);
  const docker = async (args: string[]) => {
    const result=await runDockerCommand(args);assert.equal(result.exitCode,0,result.stderr);return result.stdout;
  };
  try {
    for (let i=0;i<names.length;i++) {
      await docker(['run','--detach','--name',names[i],'--network','none','--user','1000:1000','--entrypoint','/bin/sleep',image!,'infinity']);
      await docker(['exec',names[i],'/usr/local/bin/node','-e',`
        const fs=require('fs');fs.mkdirSync('/workspace/output');
        fs.writeFileSync('/workspace/private','secret');
        fs.writeFileSync('/workspace/output/한글.png',Buffer.from([137,80,78,71,${i}]));
        fs.writeFileSync('/workspace/output/audio.wav',Buffer.from([82,73,70,70,${i}]));
        fs.writeFileSync('/workspace/output/large',Buffer.alloc(2048));
        fs.symlinkSync('/workspace/private','/workspace/output/symlink');
        fs.symlinkSync('/workspace','/workspace/output/directory');
        fs.linkSync('/workspace/private','/workspace/output/hardlink');
      `]);
    }
    const config=CallerFileDeliveryConfig.parse({allowedRoots:['/workspace/output'],maxBytes:1024,maxTotalBytes:10,maxFiles:2});
    const signal=new AbortController().signal,frames:UpFrame[]=[];
    await Promise.all(names.map(async (name,i)=>{
      const delivery=createCallerFileDelivery(name,`task-${i}`,f=>frames.push(f),signal,config);
      for(const path of ['/workspace/private','/workspace/output/symlink','/workspace/output/directory/private','/workspace/output/hardlink','/workspace/output/large'])
        await assert.rejects(delivery.send({path},signal),path);
      await delivery.send({path:'/workspace/output/한글.png'},signal);
      await delivery.send({path:'/workspace/output/audio.wav'},signal);
      await assert.rejects(delivery.send({path:'/workspace/output/audio.wav'},signal),/count/);
      const next=createCallerFileDelivery(name,`next-${i}`,f=>frames.push(f),signal,config);
      await next.send({path:'/workspace/output/한글.png'},signal);
      const aggregate=createCallerFileDelivery(name,`agg-${i}`,f=>frames.push(f),signal,{...config,maxTotalBytes:6});
      await aggregate.send({path:'/workspace/output/한글.png'},signal);
      await assert.rejects(aggregate.send({path:'/workspace/output/audio.wav'},signal),/too-large/);
    }));
    for(const f of frames){
      if(f.type!=='task.artifact')throw Error('unexpected frame');
      const part=f.artifact.parts[0];if(part.kind!=='file')throw Error('unexpected part');
      const bytes=Buffer.from(part.file.bytes!,'base64');
      assert.equal(bytes.at(-1),Number(f.taskId.split('-').at(-1)));
    }
    assert.equal(frames.length,8);
  } finally { for(const name of names) await runDockerCommand(['rm','--force',name]); }
});

// Exercise the actual createCallerRuntime worker wrapper and scope lease, not
// just the reader in isolation. The fixture is a deterministic CLI process;
// it never calls the provider. It freezes the separate Docker reader before
// claiming success, or leaves it frozen until its 15-second read deadline.
for (const mode of ['process-exit','read-timeout'] as const) test(`real Docker ${mode} cannot retain a frozen reader into the next caller task`, {skip:!image,timeout:60000}, async () => {
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {createCallerRuntime}=await import('./caller-runtime.js');
  const {CallerRuntimeConfig}=await import('./caller-runtime-config.js');
  const {DockerCallerRuntimePool}=await import('./caller-runtime-docker.js');
  const {scopeDigest}=await import('./caller-runtime-store.js');
  const directory=await mkdtemp(join(tmpdir(),'caller-reader-cleanup-')),agentId=`reader-${randomUUID()}`,principal='alice';
  const config=CallerRuntimeConfig.parse({image,stateDirectory:directory,taskTimeoutMs:45000,fileDelivery:{allowedRoots:['/workspace/output']}});
  const scope=scopeDigest(agentId,principal),envKeys=['ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL'];
  const saved=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
  for(const key of envKeys)delete process.env[key];process.env.ANTHROPIC_API_KEY='fixture-no-provider-call';
  let backend:Awaited<ReturnType<typeof createCallerRuntime>>|undefined;
  const docker=async(args:string[])=>{const result=await runDockerCommand(args);assert.equal(result.exitCode,0,result.stderr);return result.stdout.trim();};
  try {
    backend=await createCallerRuntime({kind:'claude',agentId,config,claude:{command:'/workspace/fixture-claude'}});
    const container=await backend.pool.acquire(scope,undefined,principal);
    const fixture=String.raw`#!/usr/local/bin/node
const fs=require('fs');
const marker='const {file,roots,maxBytes}=JSON.parse(process.argv[1]);';
const result=()=>{console.log(JSON.stringify({type:'result',subtype:'success',result:'clean execution'}));process.exit(0);};
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fixture-session'}));
if(fs.existsSync('/workspace/stopped-reader')){
 for(const pid of fs.readdirSync('/proc')){if(!/^\d+$/.test(pid))continue;try{if(fs.readFileSync('/proc/'+pid+'/cmdline','utf8').includes(marker))throw Error('orphan reader');}catch(e){if(e.message==='orphan reader')process.exit(9);}}
 result();
}
fs.mkdirSync('/workspace/output',{recursive:true});fs.writeFileSync('/workspace/output/x','fixture');
const config=JSON.parse(process.argv[process.argv.indexOf('--mcp-config')+1]),args=config.mcpServers['_vb-send-file'].args;
const timer=setInterval(()=>{
 for(const pid of fs.readdirSync('/proc')){
  if(!/^\d+$/.test(pid)||Number(pid)===process.pid)continue;
  try{
   if(!fs.readFileSync('/proc/'+pid+'/cmdline','utf8').includes(marker))continue;
   process.kill(Number(pid),'SIGSTOP');fs.writeFileSync('/workspace/stopped-reader',pid);clearInterval(timer);
   if(${JSON.stringify(mode)}==='process-exit')setTimeout(result,25);
   return;
  }catch{}
 }
},1);
fetch(args[2],{method:'POST',headers:{authorization:'Bearer '+args[3]},body:JSON.stringify({path:'/workspace/output/x'})}).catch(()=>{});
setTimeout(()=>process.exit(8),30000);
`;
    await docker(['exec',container.name,'/usr/local/bin/node','-e',"require('fs').writeFileSync('/workspace/fixture-claude',process.argv[1],{mode:0o755})",fixture]);
    const run=async()=>{
      const taskId=randomUUID(),frames:UpFrame[]=[];
      await backend!.handle({type:'task.assign',taskId,contextId:randomUUID(),executionId:randomUUID(),
        executionScope:{policy:'direct-principal-v1',agentId,principalId:principal,id:scope},
        caller:{version:2,principal:{id:principal},attestations:[]},message:{role:'user',messageId:randomUUID(),parts:[{kind:'text',text:'fixture'}]}} as TaskAssignFrame,f=>frames.push(f),new AbortController().signal);
      return frames;
    };
    const first=await run();
    assert.equal(first.at(-1)?.type,'task.fail',JSON.stringify(first));
    assert.equal(await docker(['inspect','--format','{{.State.Running}}',container.name]),'false');
    const second=await run();
    assert.equal(second.at(-1)?.type,'task.complete',JSON.stringify(second));
    assert.match(JSON.stringify(second),/conversationReset/);
    assert.match(await docker(['exec',container.name,'cat','/workspace/stopped-reader']),/^\d+$/);
  } finally {
    await backend?.close();
    const pool=new DockerCallerRuntimePool('claude',config,agentId);await pool.initialize(false);
    for(const id of await pool.store.scopes())await pool.remove(id,true);await pool.close();
    await rm(directory,{recursive:true,force:true});
    for(const key of envKeys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
  }
});
