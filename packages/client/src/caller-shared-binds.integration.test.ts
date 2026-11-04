import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerCallerRuntimePool } from './caller-runtime-docker.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { createCallerRuntime } from './caller-runtime.js';
import { scopeDigest } from './caller-runtime-store.js';
import { runDockerCommand as docker } from './docker-command.js';
import type { TaskAssignFrame, UpFrame } from '@vicoop-bridge/protocol';

const image = process.env.VICOOP_SHARED_TEST_IMAGE;
// Also exercise #561 when testing a revision that contains fileDelivery.
const withFileDelivery = process.env.VICOOP_SHARED_TEST_FILE_DELIVERY === '1';
const run = async (args: string[]) => {
  const result = await docker(args);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
};

test('real Docker host corpus stays live/read-only across isolated callers and recreation', { skip: !image, timeout: 120000 }, async () => {
  // cwd is normally shared into macOS Docker VMs; OS temporary directories may not be.
  const directory = await realpath(await mkdtemp(join(process.cwd(), '.bind-integration-')));
  const source = join(directory, 'assets');
  await mkdir(source, { mode: 0o755 });
  await writeFile(join(source, 'corpus'), 'original');
  const agentId = `bind-test-${randomUUID()}`;
  const config = CallerRuntimeConfig.parse({image, stateDirectory:join(directory,'state'), sharedBinds:[{name:'assets',source}]});
  let pool = new DockerCallerRuntimePool('claude', config, agentId);
  const alice = scopeDigest(agentId, 'alice'), bob = scopeDigest(agentId, 'bob');
  try {
    await pool.initialize();
    const a = await pool.acquire(alice, undefined, 'alice'), b = await pool.acquire(bob, undefined, 'bob');
    for (const container of [a,b]) {
      assert.equal(await run(['exec',container.name,'cat','/shared/assets/corpus']), 'original');
      assert.notEqual((await docker(['exec',container.name,'touch','/shared/assets/forbidden'])).exitCode, 0);
    }
    await run(['exec',a.name,'/bin/sh','-c','echo private > /workspace/private; echo session > /data/sessions/claude/private']);
    for (const path of ['/workspace/private','/data/sessions/claude/private'])
      assert.notEqual((await docker(['exec',b.name,'cat',path])).exitCode, 0);
    await writeFile(join(source,'corpus'), 'updated');
    for (const container of [a,b])
      assert.equal(await run(['exec',container.name,'cat','/shared/assets/corpus']), 'updated');
    await pool.close();
    await rename(source, `${source}-retained`);
    pool = new DockerCallerRuntimePool('claude', config, agentId);
    await pool.initialize(false);
    await pool.remove(alice, false);
    await pool.close();
    await rename(`${source}-retained`, source);
    pool = new DockerCallerRuntimePool('claude', config, agentId);
    await pool.initialize();
    assert.equal((await pool.acquire(alice)).recreated, true);
    assert.equal(await run(['exec',a.name,'cat','/workspace/private']), 'private');
    assert.equal(await run(['exec',a.name,'cat','/data/sessions/claude/private']), 'session');
    await pool.remove(alice, true);
    await pool.remove(bob, true);
    assert.equal(await readFile(join(source,'corpus'),'utf8'), 'updated');
  } finally {
    for (const id of await pool.store.scopes()) await pool.remove(id,true);
    await pool.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('real caller worker stages operator and bridge prompts on initial, resumed and retried tasks', { skip: !image, timeout: 120000 }, async () => {
  const directory = await realpath(await mkdtemp(join(process.cwd(), '.prompt-integration-')));
  const agentId = `prompt-test-${randomUUID()}`, principal = 'alice', id = scopeDigest(agentId, principal);
  const config = CallerRuntimeConfig.parse({image, stateDirectory:directory, ...(withFileDelivery ? {fileDelivery:{allowedRoots:['/workspace/output']}} : {}), systemPrompt:'Search /shared/assets; keep sources unchanged. Write results into /workspace/output.'});
  // Deterministic workload fixture; no provider requests or real credentials.
  const keys = ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN'];
  const saved = Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.ANTHROPIC_API_KEY = 'fixture-no-provider-call';
  let backend: Awaited<ReturnType<typeof createCallerRuntime>> | undefined;
  try {
    backend = await createCallerRuntime({kind:'claude',agentId,config,claude:{command:'/workspace/fixture-claude',identity:{agentId,host:'bridge.example',httpOrigin:'https://bridge.example'}}});
    const container = await backend.pool.acquire(id,undefined,principal);
    const fixture = `#!/usr/local/bin/node
const fs=require('fs');
const args=process.argv.slice(2),flag='--append-system-prompt-file';
if(args.filter(a=>a===flag).length!==1 || args.some(a=>a==='--append-system-prompt'||a.startsWith('--append-system-prompt=')))process.exit(7);
const prompt=fs.readFileSync(args[args.indexOf(flag)+1],'utf8');
fs.appendFileSync('/workspace/prompts.jsonl',JSON.stringify({args,prompt})+'\\n');
process.stdin.resume();process.stdin.once('data',async()=>{
 const delivery=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers['_vb-send-file'];
 if(${withFileDelivery}){
  if(!delivery || !delivery.args[4].includes('/workspace/output'))process.exit(8);
  fs.mkdirSync('/workspace/output',{recursive:true});fs.writeFileSync('/workspace/output/result.txt','fixture attachment');
  const response=await fetch(delivery.args[2],{method:'POST',headers:{authorization:'Bearer '+delivery.args[3]},body:JSON.stringify({path:'/workspace/output/result.txt'})});
  if(!response.ok)process.exit(9);
 }

 console.log(JSON.stringify({type:'result',subtype:'success',result:'fixture completed'}));process.exit(0);
});
`;
    await run(['exec',container.name,'/usr/local/bin/node','-e',"require('fs').writeFileSync('/workspace/fixture-claude',process.argv[1],{mode:0o755})",fixture]);
    const contextId = randomUUID();
    // A redelivery/retry invokes the same worker with a new execution ID.
    for (const taskId of ['first','next','next']) {
      const frames: UpFrame[] = [];
      const task = {type:'task.assign',taskId,contextId,executionId:randomUUID(),
        executionScope:{policy:'direct-principal-v1',agentId,principalId:principal,id},
        caller:{principal:{id:principal},attestations:[]},
        message:{role:'user',messageId:randomUUID(),parts:[{kind:'text',text:'fixture'}]}} as TaskAssignFrame;
      await backend.handle(task,f=>frames.push(f),AbortSignal.timeout(15000));
      assert.equal(frames.at(-1)?.type, 'task.complete', JSON.stringify(frames));
      if (withFileDelivery) {
        const parts = frames.flatMap(f => f.type === 'task.artifact' ? f.artifact.parts : []);
        const file = parts.find(p => p.kind === 'file');
        assert.ok(file?.kind === 'file' && 'bytes' in file.file);
        assert.equal(Buffer.from(file.file.bytes!, 'base64').toString(), 'fixture attachment');
      }
    }
    const records = (await run(['exec',container.name,'cat','/workspace/prompts.jsonl'])).split('\n').map(line=>JSON.parse(line));
    assert.equal(records.length,3);
    assert.deepEqual(records.map(r=>r.args.includes('--resume')), [false,true,true]);
    for (const record of records) {
      assert.ok(record.prompt.includes(config.systemPrompt));
      assert.match(record.prompt,/inert attribution data/);
      assert.ok(record.prompt.includes(`@${agentId}@bridge.example`));
    }
  } finally {
    await backend?.close();
    const pool = new DockerCallerRuntimePool('claude',config,agentId);
    await pool.initialize(false);
    for (const scope of await pool.store.scopes()) await pool.remove(scope,true);
    await pool.close();
    await rm(directory,{recursive:true,force:true});
    for (const key of keys) { if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key]; }
  }
});
