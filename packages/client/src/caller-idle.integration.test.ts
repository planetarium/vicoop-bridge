import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskAssignFrame, UpFrame } from '@vicoop-bridge/protocol';
import { createCallerRuntime } from './caller-runtime.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';
import { DockerCallerRuntimePool } from './caller-runtime-docker.js';
import { scopeDigest } from './caller-runtime-store.js';
import { runDockerCommand } from './docker-command.js';

// Real Docker, production worker/broker/supervisor/file reader, deterministic CLI
// protocols. No provider calls or real credentials. Optional fixed-storage image
// exercises the privileged storage helper using an isolated disposable pool.
const imageRef = process.env.VICOOP_IDLE_TEST_IMAGE;
const storageImage = process.env.VICOOP_IDLE_TEST_STORAGE_IMAGE;
const docker = async (args: string[]) => {
  const result = await runDockerCommand(args, { timeoutMs: 30000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
};
const claudeFixture = String.raw`#!/usr/local/bin/node
const fs = require('fs'), crypto = require('crypto');
(async () => {
 const resume = process.argv.indexOf('--resume');
 const session = process.argv[(resume < 0 ? process.argv.indexOf('--session-id') : resume) + 1];
 fs.appendFileSync('/workspace/conversations', (resume < 0 ? 'start ' : 'resume ') + session + '\n');
 console.log(JSON.stringify({type:'system',subtype:'init',session_id:session}));
 const config = JSON.parse(process.argv[process.argv.indexOf('--mcp-config')+1]);
 const args = config.mcpServers['_vb-send-file'].args;
 const response = await fetch(args[2], {method:'POST', headers:{authorization:'Bearer '+args[3]},body:JSON.stringify({path:'/workspace/output/retained.txt'})});
 if (!response.ok) throw Error('file delivery failed');
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'idle fixture reply'}]}}));
 console.log(JSON.stringify({type:'result',subtype:'success',result:'idle fixture reply'}));
})().catch(() => process.exit(9));
`;
const codexFixture = String.raw`#!/usr/local/bin/node
const fs = require('fs'), crypto = require('crypto');
const send = data => console.log(JSON.stringify(data));
let thread;
require('readline').createInterface({input:process.stdin}).on('line', line => {
 const {id,method,params} = JSON.parse(line);
 if (method === 'initialize') send({id,result:{userAgent:'idle-fixture',codexHome:'/data/sessions/codex',platformFamily:'unix',platformOs:'linux'}});
 else if (method === 'account/login/start') send({id,result:{type:'apiKey'}});
 else if (method === 'thread/start' || method === 'thread/resume') {
  thread = method === 'thread/start' ? crypto.randomUUID() : params.threadId;
  fs.appendFileSync('/workspace/conversations', (method === 'thread/start' ? 'start ' : 'resume ') + thread + '\n');
  send({id,result:{thread:{id:thread}}});
 } else if (method === 'turn/start') {
  const turn = crypto.randomUUID();
  send({id,result:{turn:{id:turn,status:'inProgress'}}});
  setTimeout(() => {
   send({method:'item/agentMessage/delta',params:{itemId:'reply',threadId:thread,turnId:turn,delta:'idle fixture reply'}});
   send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{type:'agentMessage',id:'reply',text:'idle fixture reply'}}});
   send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[],error:null}}});
  },25);
 } else if (id !== undefined) send({id,result:{}});
});
`;

for (const kind of ['claude', 'codex'] as const) {
  test(`real Docker ${kind}: idle stop/resume retains storage and resets the actual worker conversation`, {
    skip: !imageRef, timeout: 120000,
  }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'caller-idle-'));
    const agentId = `idle-${randomUUID()}`, principal = 'alice';
    const id = scopeDigest(agentId, principal), bob = scopeDigest(agentId, 'bob');
    const sessionMarker = `/data/sessions/${kind}/marker`, sessionSentinel = randomUUID();
    const shared = `idle-shared-${randomUUID()}`, storagePool = `idle-storage-${randomUUID()}`;
    const image = await docker(['image', 'inspect', '--format', '{{.Id}}', imageRef!]);
    const options = CallerRuntimeConfig.parse({
      image, stateDirectory: join(directory, 'state'), idleTimeoutMs: 2000, maxScopes: 2,
      sharedVolumes: [{ name: 'materials', volume: shared }],
      ...(kind === 'claude' ? { fileDelivery: { allowedRoots: ['/workspace/output'] } } : {}),
      ...(storageImage ? { storageMiB: 64, fixedImageStorage: {
        image: storageImage, poolVolume: storagePool, capacityMiB: 128, reserveMiB: 64,
        reservationBoundary: 'docker-filesystem',
      } } : {}),
    });
    const keys = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env.ANTHROPIC_API_KEY = process.env.OPENAI_API_KEY = 'fixture-no-provider-call';
    let backend: Awaited<ReturnType<typeof createCallerRuntime>> | undefined;
    try {
      await docker(['volume', 'create', shared]);
      if (storageImage) await docker(['volume', 'create', '--label', 'vicoop.component=caller-storage-pool', storagePool]);
      const startBackend = () => createCallerRuntime({ kind, agentId, config: options,
        claude: { command: '/workspace/fixture-cli' }, codex: { command: '/workspace/fixture-cli' } });
      backend = await startBackend();
      const container = await backend.pool.acquire(id, undefined, principal);
      const other = await backend.pool.acquire(bob, undefined, 'bob');
      // Seed once outside the CLI fixtures: a later task must not repair lost
      // session contents before the persistence assertion can observe them.
      await docker(['exec', container.name, 'node', '-e',
        "const fs=require('fs');fs.writeFileSync('/workspace/fixture-cli',process.argv[1],{mode:0o755});fs.mkdirSync('/workspace/output');fs.writeFileSync('/workspace/output/retained.txt','retained-file');fs.writeFileSync(process.argv[2],process.argv[3],{flag:'wx'});",
        kind === 'claude' ? claudeFixture : codexFixture, sessionMarker, sessionSentinel]);
      await backend.pool.store.setPreparation(id, 'fixture-v1', true);
      const reservation = await backend.pool.store.fixedStorage(id);
      const records = await backend.pool.store.records();
      const run = async () => {
        const taskId = randomUUID(), frames: UpFrame[] = [];
        await backend!.handle({ type: 'task.assign', taskId, contextId: 'same-context', executionId: randomUUID(),
          executionScope: { policy: 'direct-principal-v1', agentId, principalId: principal, id },
          caller: { version: 2, principal: { id: principal }, attestations: [] },
          message: { role: 'user', messageId: randomUUID(), parts: [{ kind: 'text', text: 'fixture' }] },
        } as TaskAssignFrame, frame => frames.push(frame), new AbortController().signal);
        assert.equal(frames.at(-1)?.type, 'task.complete', JSON.stringify(frames));
        assert.ok(frames.every(frame => !('taskId' in frame) || frame.taskId === taskId));
        assert.match(JSON.stringify(frames), /idle fixture reply/);
        // Includes both idle resumes and the request after daemon restart.
        assert.equal(await docker(['exec', container.name, 'cat', sessionMarker]), sessionSentinel);
        if (kind === 'claude') {
          const files = frames.filter(frame => frame.type === 'task.artifact').flatMap(frame => frame.artifact.parts).filter(part => part.kind === 'file');
          assert.equal(files.length, 1);
          assert.equal(Buffer.from(files[0].file.bytes!, 'base64').toString(), 'retained-file');
        }
        return frames;
      };
      const first = await run();
      assert.doesNotMatch(JSON.stringify(first), /conversationReset/);
      const warm = await run();
      assert.doesNotMatch(JSON.stringify(warm), /conversationReset/);
      const memory = await docker(['stats', '--no-stream', '--format', '{{.MemUsage}} / {{.PIDs}} PIDs', container.name]);
      const waitIdle = async () => {
        const deadline = Date.now() + 20000;
        while ((await backend!.pool.store.lifecycle(id)).lastIdleStop?.at === lastStop) {
          assert.ok(Date.now() < deadline, 'idle stop deadline');
          await delay(50);
        }
        const lifecycle = await backend!.pool.store.lifecycle(id);
        assert.equal(lifecycle.lastIdleStop?.outcome, 'stopped');
        lastStop = lifecycle.lastIdleStop!.at;
        assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', container.name]), 'false');
      };
      let lastStop: string | undefined;
      await waitIdle();
      const stoppedStats = await docker(['stats', '--no-stream', '--format', '{{.MemUsage}} / {{.PIDs}} PIDs', container.name]);
      assert.equal(await docker(['inspect', '--format', '{{.State.Running}}', other.name]), 'true');
      assert.deepEqual(await backend.pool.store.records(), records);
      assert.deepEqual(await backend.pool.store.preparation(id), { version: 'fixture-v1', ready: true });
      assert.equal(await backend.pool.store.fixedStorage(id), reservation);
      const measurements: number[] = [];
      for (let cycle = 0; cycle < 2; cycle++) {
        const started = performance.now();
        const frames = await run();
        measurements.push(Math.round(performance.now() - started));
        assert.match(JSON.stringify(frames), /conversationReset/);
        assert.equal(await docker(['inspect', '--format', '{{.Id}}', container.name]), container.dockerId);
        assert.equal((await backend.pool.describe(id)).lifecycle.lastResume?.outcome, 'conversation-reset');
        await waitIdle();
      }
      await backend.close();
      backend = await startBackend();
      assert.match(JSON.stringify(await run()), /conversationReset/);
      const conversations = (await docker(['exec', container.name, 'cat', '/workspace/conversations'])).split('\n').map(line => line.split(' '));
      assert.deepEqual(conversations.map(line => line[0]), ['start', 'resume', 'start', 'start', 'start']);
      assert.equal(conversations[0][1], conversations[1][1]);
      assert.equal(new Set(conversations.slice(1).map(line => line[1])).size, 4);
      t.diagnostic(JSON.stringify({ kind, fixedStorage: !!storageImage, warmResources: memory, stoppedResources: stoppedStats, resumeTaskMs: measurements }));
    } finally {
      await backend?.close();
      const pool = new DockerCallerRuntimePool(kind, options, agentId);
      await pool.initialize(false);
      for (const scope of await pool.store.scopes()) await pool.remove(scope, true);
      await pool.close();
      await docker(['volume', 'rm', shared]);
      if (storageImage) await docker(['volume', 'rm', storagePool]);
      await rm(directory, { recursive: true, force: true });
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    }
  });
}
