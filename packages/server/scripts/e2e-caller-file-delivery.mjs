// Compiled client + real Docker/Claude + HTTP/WS/Postgres file-delivery acceptance.
// Requires pnpm -r build, VICOOP_CLIENT_BIN, pinned VICOOP_FILE_TEST_IMAGE,
// authenticated host Claude, and a disposable DATABASE_URL. Makes model calls.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { serve } from '@hono/node-server';
import postgres from 'postgres';
import { ensureSchema } from '../dist/db.js';
import { createHttpApp } from '../dist/http.js';
import { Registry } from '../dist/registry.js';
import { hashToken } from '../dist/token.js';
import { attachWsServer } from '../dist/ws.js';
import { issueSessionToken } from '../dist/auth/caller-token.js';
import { DockerCallerRuntimePool } from '../../client/dist/caller-runtime-docker.js';
import { CallerRuntimeConfig } from '../../client/dist/caller-runtime-config.js';
import { scopeDigest } from '../../client/dist/caller-runtime-store.js';
import { runDockerCommand } from '../../client/dist/docker-command.js';

const binary=process.env.VICOOP_CLIENT_BIN,image=process.env.VICOOP_FILE_TEST_IMAGE;
assert.ok(binary && image && process.env.DATABASE_URL);
const sql=postgres(process.env.DATABASE_URL,{onnotice(){}}),agentId=`caller-files-${randomUUID()}`,token=randomUUID();
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'caller-file-e2e-'));
const runtime=CallerRuntimeConfig.parse({image,stateDirectory:path.join(directory,'state'),taskTimeoutMs:120000,
  fileDelivery:{allowedRoots:['/workspace/output']}});
const principals=[0,1].map(()=>`apikey:${randomUUID()}`),issued=[];
let server,child,exited,logs='',registry;
async function waitFor(predicate,label){const end=Date.now()+30000;while(!await predicate()){if(Date.now()>end)throw Error(`${label}: ${logs}`);await new Promise(r=>setTimeout(r,50));}}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function wav(sample){const b=Buffer.alloc(46);b.write('RIFF');b.writeUInt32LE(38,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(2,40);b.writeInt16LE(sample,44);return b;}
try{
 await ensureSchema(sql);
 for(const principalId of principals)issued.push(await issueSessionToken(sql,{principalId,provider:'apikey',audience:'caller'}));
 await sql`INSERT INTO agents (id,owner_principal,name,token_hash,allowed_callers) VALUES (${agentId},'eth:0xowner','Container file test',${hashToken(token)},${principals})`;
 registry=new Registry();const app=createHttpApp({registry,db:sql,publicUrl:'http://localhost'});
 server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});attachWsServer(server,{registry,db:sql});
 if(!server.listening)await once(server,'listening');
 const address=`http://127.0.0.1:${server.address().port}`;
 const configPath=path.join(directory,'config.json');
 await fs.writeFile(configPath,JSON.stringify({server_url:address,server_token:token,agent_id:agentId,backend:'claude',backends:{claude:{runtime:'container',model:process.env.VICOOP_SMOKE_MODEL??'claude-haiku-4-5',settings:{sandbox:{failIfUnavailable:false}},caller_runtime:runtime}}}),{mode:0o600});
 child=spawn(binary,['start','--config',configPath],{stdio:['ignore','pipe','pipe'],env:{...process.env,VICOOP_HOME:path.join(directory,'home')}});
 child.stdout.on('data',b=>{logs+=b;});child.stderr.on('data',b=>{logs+=b;});exited=once(child,'close');
 await waitFor(()=>registry.getAgent(agentId),'compiled daemon registration');
 const card=await (await fetch(`${address}/agents/${agentId}/.well-known/agent-card.json`)).json();
 const requiredExtensions=(card.capabilities?.extensions??[]).filter(e=>e.required).map(e=>e.uri).join(', ');
 let maxActive=0;const active=new Set();
 function observe(){registry.getAgent(agentId).ws.on('message',raw=>{const frame=JSON.parse(raw.toString());if(frame.type==='task.status'&&frame.status.state==='working')active.add(frame.taskId);if(frame.type==='task.complete'||frame.type==='task.fail')active.delete(frame.taskId);maxActive=Math.max(maxActive,active.size);});}
 observe();
 const rpc=async(caller,v1,method,params)=>{
  const response=await fetch(`${address}/agents/${agentId}${v1?'/v1':''}`,{method:'POST',signal:AbortSignal.timeout(180000),headers:{'Content-Type':'application/json','A2A-Extensions':requiredExtensions,Authorization:`Bearer ${issued[caller].rawToken}`},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.ok(body.result,JSON.stringify(body));return body.result;
 };
 for(const v1 of [false,true]){
  const tasks=await Promise.all([0,1].map(async caller=>{
   const stem=`${v1?'v1':'v03'}-${caller}`,expected=new Map([[`${stem}.png`,png],[`${stem}.wav`,wav(caller+1)]]);
   const code=`const fs=require('fs');fs.mkdirSync('/workspace/output',{recursive:true});`+[...expected].map(([name,bytes])=>`fs.writeFileSync('/workspace/output/${name}',Buffer.from('${bytes.toString('base64')}','base64'));`).join('');
   const prompt=`Run this exact node command to create two binary fixtures: node -e ${JSON.stringify(code)}. Then invoke the send_file MCP tool once for each file: ${[...expected.keys()].map(name=>`/workspace/output/${name}`).join(', ')}. Do not claim delivery without successful tool results. Reply briefly when both are sent.`;
   const sent=await rpc(caller,v1,v1?'SendMessage':'message/send',{message:{messageId:randomUUID(),contextId:randomUUID(),role:'user',parts:v1?[{text:prompt}]:[{kind:'text',text:prompt}]},configuration:{blocking:true,returnImmediately:false}});
   for(const task of [sent,await rpc(caller,v1,v1?'GetTask':'tasks/get',{id:sent.id})]){
    assert.equal(task.status.state,v1?'TASK_STATE_COMPLETED':'completed',JSON.stringify(task.status));
    const parts=(task.artifacts??[]).flatMap(a=>a.parts).filter(p=>v1?p.raw:p.kind==='file');assert.equal(parts.length,2,JSON.stringify(task));
    for(const part of parts){const name=v1?part.filename:part.file.name,bytes=Buffer.from(v1?part.raw:part.file.bytes,'base64');assert.ok(expected.has(name));assert.deepEqual(bytes,expected.get(name));assert.equal(createHash('sha256').update(bytes).digest('hex'),createHash('sha256').update(expected.get(name)).digest('hex'));}
   }
   return sent.id;
  }));
  assert.notEqual(tasks[0],tasks[1]);
  console.log(`PASS A2A ${v1?'1.0':'0.3'}: concurrent isolated callers, real PNG/WAV hashes, completed-task lookup`);
  if(!v1){
   const ws=registry.getAgent(agentId).ws;
   const taskStarted=new Promise(resolve=>{const listener=raw=>{const frame=JSON.parse(raw.toString());if(frame.type==='task.artifact'&&frame.artifact.name==='send-file'){ws.off('message',listener);resolve(frame.taskId);}};ws.on('message',listener);});
   const sendPending=rpc(0,false,'message/send',{message:{messageId:randomUUID(),contextId:randomUUID(),role:'user',parts:[{kind:'text',text:'Use Bash to create /workspace/output/cancel.txt containing the text cancel. Then call the send_file MCP tool with path /workspace/output/cancel.txt. After the tool succeeds, write a detailed 2000 word review of PNG encoding in /workspace/review.md. Do not finish before writing the review.'}]},configuration:{blocking:false,returnImmediately:true}});
   sendPending.catch(()=>{});
   const cancelTaskId=await Promise.race([taskStarted,sendPending.then(result=>{throw Error('Task ended before cancellation probe file: '+JSON.stringify(result));})]);
   const pool=new DockerCallerRuntimePool('claude',{...runtime,stateDirectory:await fs.realpath(runtime.stateDirectory)},agentId);
   const container=pool.name(scopeDigest(agentId,principals[0]));
   const canceled=await rpc(0,false,'tasks/cancel',{id:cancelTaskId});assert.equal(canceled.status.state,'canceled');
   await sendPending;
   await waitFor(async()=> (await runDockerCommand(['inspect','--format','{{.State.Running}}',container])).stdout.trim()==='false','canceled caller container stopped');
   const previous=registry.getAgent(agentId).ws;previous.terminate();
   await waitFor(()=>registry.getAgent(agentId)?.ws&&registry.getAgent(agentId).ws!==previous,'compiled daemon reconnected');observe();
   console.log('PASS observed-file-tool cancellation and reconnect before new same-scope tasks');
  }
 }
 assert.ok(maxActive>=2,'real caller executions must overlap');
 console.log('PASS Bun-compiled daemon with real Claude/Docker: both A2A versions and same-scope sequential requests');
}catch(error){console.error(logs);throw error;}
finally{
 if(child){child.kill('SIGTERM');await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('shutdown timeout')),25000).unref())]);}
 const cleanup=new DockerCallerRuntimePool('claude',runtime,agentId);await cleanup.initialize(false);for(const scope of await cleanup.store.scopes())await cleanup.remove(scope,true);await cleanup.close();
 await new Promise(resolve=>server?server.close(resolve):resolve());
 await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent=${agentId}`;await sql`DELETE FROM agents WHERE id=${agentId}`;for(const caller of issued)await sql`DELETE FROM callers WHERE id=${caller.callerId}`;await sql.end();
 await fs.rm(directory,{recursive:true,force:true});
}
