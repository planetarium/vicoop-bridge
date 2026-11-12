// Full local A2A -> compiled client -> Codex protocol fixture -> Docker file
// reader -> Postgres -> A2A task retrieval. Requires a disposable DATABASE_URL,
// VICOOP_CLIENT_BIN and the pinned caller-backends fixture VICOOP_SMOKE_IMAGE.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import postgres from 'postgres';
import { serve } from '@hono/node-server';
import { ensureSchema } from '../src/db.js';
import { Registry } from '../src/registry.js';
import { createHttpApp } from '../src/http.js';
import { attachWsServer } from '../src/ws.js';
import { hashToken } from '../src/token.js';
import { issueSessionToken } from '../src/auth/caller-token.js';
import { SIWE_BEARER_AUTH_EXTENSION_URI } from '@vicoop-bridge/protocol';
import { scopeDigest } from '../../client/src/caller-runtime-store.js';
import { runDockerCommand } from '../../client/src/docker-command.js';
import { CallerRuntimeConfig } from '../../client/src/caller-runtime-config.js';
import { DockerCallerRuntimePool } from '../../client/src/caller-runtime-docker.js';

const {DATABASE_URL,VICOOP_CLIENT_BIN:binary,VICOOP_SMOKE_IMAGE:image}=process.env;
assert.ok(DATABASE_URL && binary && image);
const sql=postgres(DATABASE_URL,{onnotice(){}});
const directory=await mkdtemp(join(tmpdir(),'a2a-codex-files-'));
const agentId='files-'+randomUUID(),token=randomUUID(),principal='apikey:files-'+randomUUID();
const runtime=CallerRuntimeConfig.parse({image,stateDirectory:join(directory,'state'),fileDelivery:{allowedRoots:['/workspace/output']}});
const registry=new Registry();
const app=createHttpApp({registry,db:sql,publicUrl:'http://localhost'});
const server=serve({fetch:app.fetch,port:0,hostname:'127.0.0.1'});
attachWsServer(server as any,{registry,db:sql});
await once(server,'listening');
const url='http://127.0.0.1:'+(server.address() as any).port;
let child: ReturnType<typeof spawn>|undefined;
let closed: Promise<unknown>|undefined;
let logs='';
const deadline=Date.now()+120000;
async function waitFor(fn:()=>boolean) {
  while(!fn()){assert.ok(Date.now()<deadline,'client startup deadline: '+logs);await new Promise(r=>setTimeout(r,50));}
}
try {
  await ensureSchema(sql);
  await sql`INSERT INTO agents (id,owner_principal,name,token_hash,allowed_callers)
    VALUES (${agentId},'eth:0xowner','Codex file smoke',${hashToken(token)},${[principal]})`;
  const caller=await issueSessionToken(sql,{principalId:principal,provider:'apikey',audience:'caller'});
  const configPath=join(directory,'config.json');
  await writeFile(configPath,JSON.stringify({server_url:url.replace('http:','ws:'),server_token:token,agent_id:agentId,
    backend:'codex',backends:{codex:{runtime:'container',caller_runtime:runtime}}}),{mode:0o600});
  const env={...process.env,VICOOP_HOME:join(directory,'home'),OPENAI_API_KEY:'fixture-host-secret'};
  delete env.OPENAI_BASE_URL;
  child=spawn(binary,['start','--config',configPath],{env,stdio:['ignore','pipe','pipe']});
  closed=once(child,'close');
  child.stdout!.on('data',c=>logs+=c);child.stderr!.on('data',c=>logs+=c);
  await waitFor(()=>Boolean(registry.getAgent(agentId)));
  const rpc=async(method:string,params:unknown)=>{
    const response=await fetch(url+'/agents/'+agentId,{method:'POST',
      headers:{'Content-Type':'application/json','A2A-Extensions':SIWE_BEARER_AUTH_EXTENSION_URI,Authorization:'Bearer '+caller.rawToken},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(60000)});
    assert.equal(response.status,200);
    const body=await response.json() as any;assert.equal(body.error,undefined,JSON.stringify(body));
    return body.result;
  };
  let contextId:string|undefined;
  for(let turn=1;turn<=2;turn++) {
    const task=await rpc('message/send',{message:{messageId:randomUUID(),role:'user',contextId,
      parts:[{kind:'text',text:'hello'}]},configuration:{blocking:true}});
    assert.equal(task.status.state,'completed',JSON.stringify(task));
    contextId=task.contextId;
    const fetched=await rpc('tasks/get',{id:task.id});
    const files=fetched.artifacts.flatMap((a:any)=>a.parts).filter((p:any)=>p.kind==='file');
    assert.equal(files.length,1,JSON.stringify(fetched));
    const downloaded=Buffer.from(files[0].file.bytes,'base64');
    const record=JSON.parse(downloaded.toString());
    assert.equal(record.turn,turn);
    assert.equal(record.resumed,turn===2);
    assert.equal(files[0].file.name,'result.bin');
    const containers=await runDockerCommand(['ps','--filter','label=vicoop.scope='+scopeDigest(agentId,principal),'--format','{{.ID}}']);
    assert.equal(containers.exitCode,0);
    assert.match(containers.stdout.trim(),/^[a-f0-9]+$/);
    const source=await runDockerCommand(['exec',containers.stdout.trim(),
      'sha256sum','/workspace/output/result.bin']);
    assert.equal(source.exitCode,0);
    assert.equal(createHash('sha256').update(downloaded).digest('hex'),source.stdout.split(' ')[0]);
  }
  console.log(JSON.stringify({result:'PASS',checks:['real HTTP A2A consumer','compiled client','Docker file delivery',
    'authenticated caller scope','Postgres task retrieval','decoded attachment bytes','resumed context delivery'],
    backend:'deterministic Codex protocol fixture (native Codex separately tested)'}));
} finally {
  child?.kill('SIGTERM');await closed;
  const pool=new DockerCallerRuntimePool('codex',runtime,agentId);
  await pool.initialize(false);for(const id of await pool.store.scopes())await pool.remove(id,true);await pool.close();
  for(const a of registry.listAgents())a.ws.close();
  await new Promise<void>(r=>server.close(()=>r()));
  await sql`DELETE FROM infra.a2a_tasks WHERE owner_agent=${agentId}`;
  await sql`DELETE FROM agents WHERE id=${agentId}`;
  await sql`DELETE FROM callers WHERE principal_id=${principal}`;
  await sql.end();await rm(directory,{recursive:true,force:true});
}
