// Compiled client + real Docker concurrent contexts. Deterministic backends; no provider calls.
// Build scripts/fixtures/caller-backends/Dockerfile and set the same env as caller-client-smoke.mjs.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { promisify } from 'node:util';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
const exec = promisify(execFile);
const binary = process.env.VICOOP_CLIENT_BIN;
const image = process.env.VICOOP_SMOKE_IMAGE;
if (!binary || !image)
  throw new Error(
    'set VICOOP_CLIENT_BIN (absolute compiled CLI path), VICOOP_SMOKE_IMAGE (pinned fixture image)',
  );
const kind = process.env.VICOOP_SMOKE_KIND || 'claude';
assert.ok(['claude', 'codex'].includes(kind));
const directory = await mkdtemp(join(tmpdir(), 'vicoop-caller-client-'));
const clientHome = join(directory, 'client-home');
await mkdir(clientHome, { mode: 0o700 });
const clientEnv = {
  ...process.env,
  VICOOP_HOME: clientHome,
  ANTHROPIC_API_KEY: 'fixture-host-secret',
  OPENAI_API_KEY: 'fixture-host-secret',
};
for (const key of [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
])
  delete clientEnv[key];
const key = join(directory, 'key');
const configPath = join(directory, 'config.json');
await writeFile(key, 'fixture-no-api-call', { mode: 0o600 });
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => server.once('listening', r));
const storagePool = `vb-concurrency-smoke-${randomUUID()}`;
const config = {
  server_url: `ws://127.0.0.1:${server.address().port}`,
  server_token: 'fixture',
  agent_id: 'smoke',
  backend: kind,
  backends: {
    [kind]: {
      runtime: 'container',
      caller_runtime: {
        image,
        stateDirectory: join(directory, 'state'),
        maxScopes: 2,
        storageMiB: 64,
        taskTimeoutMs: 120_000,
      },
    },
  },
};
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
let socket;
let hellos = 0;
let child;
let logs = '';
let exit;
const frames = [];
server.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === 'hello') {
      assert.ok(frame.protocolCapabilities.includes('caller-runtime-v1'));
      assert.equal(
        frame.agentCard?.capabilities?.extensions?.some((x) =>
          x.uri.includes('openai-compat'),
        ),
        false,
      );
      assert.ok(!frame.agentCard.defaultInputModes.includes('application/json'));
      assert.ok(frame.agentCard.defaultInputModes.includes('text/plain'));
      assert.equal(frame.agentCard.defaultInputModes.includes('application/pdf'), kind === 'claude');
      assert.ok(!/data.part.*inputs|serialized into the prompt/.test(JSON.stringify(frame.agentCard)));
      socket = ws;
      hellos++;
      ws.send(
        JSON.stringify({
          type: 'hello.ack',
          protocolCapabilities: [
            'task-replay-v1',
            'caller-context-v2',
            'execution-scope-v1',
            'caller-runtime-v1',
            'remote-tool-approval-v1',
          ],
          disconnectGraceMs: 30_000,
          maxFrameBytes: 1048576,
        }),
      );
    } else {
      frames.push(frame);
      if (frame.executionId && frame.seq)
        ws.send(
          JSON.stringify({
            type: 'task.ack',
            taskId: frame.taskId,
            executionId: frame.executionId,
            acceptedSeq: frame.seq,
          }),
        );
    }
  });
});
async function waitFor(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}\n${logs}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function start() {
  const previous = hellos;
  child = spawn(binary, ['start', '--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: clientEnv,
  });
  child.stdout.on('data', (x) => {
    logs += x;
  });
  child.stderr.on('data', (x) => {
    logs += x;
  });
  exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  await waitFor(() => hellos > previous, 'daemon hello');
}
function assign(
  principal,
  id,
  text = 'hello',
  contextId = 'identical-context',
) {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'vicoop-execution-scope',
        'direct-principal-v1',
        'smoke',
        principal,
      ]),
    )
    .digest('hex');
  socket.send(
    JSON.stringify({
      type: 'task.assign',
      taskId: id,
      executionId: `exec-${id}`,
      contextId,
      caller: { principal: { id: principal } },
      executionScope: {
        policy: 'direct-principal-v1',
        id: digest,
        agentId: 'smoke',
        principalId: principal,
      },
      message: {
        role: 'user',
        messageId: `m-${id}`,
        parts: [{ kind: 'text', text }, ...(text==='image-check' ? [{kind:'file',file:{mimeType:'image/png',bytes:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7LkAAAAASUVORK5CYII='}}] : [])],
      },
    }),
  );
}
async function completed(id) {
  await waitFor(
    () =>
      frames.some(
        (x) =>
          x.taskId === id && ['task.complete', 'task.fail'].includes(x.type),
      ),
    id,
  );
  const terminal = frames.find(
    (x) => x.taskId === id && ['task.complete', 'task.fail'].includes(x.type),
  );
  assert.equal(terminal.type, 'task.complete', JSON.stringify(terminal));
  const output = frames
    .filter((x) => x.taskId === id && x.type === 'task.artifact')
    .flatMap((x) => x.artifact.parts)
    .filter((x) => x.kind === 'text')
    .map((x) => x.text)
    .join('');
  return JSON.parse(output);
}
async function stop(signal = 'SIGTERM') {
  if (!child) return;
  child.kill(signal);
  const result = await Promise.race([
    exit,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('daemon shutdown timed out')),
        20_000,
      ).unref(),
    ),
  ]);
  child = undefined;
  if (signal === 'SIGTERM') assert.equal(result.code, 0, logs);
}

let namespace;
const principals = ['apikey:a', 'apikey:b'];
const scope = principal => createHash('sha256').update(JSON.stringify([
  'vicoop-execution-scope', 'direct-principal-v1', 'smoke', principal,
])).digest('hex');
const contextKey = (principal, context) => createHash('sha256').update(JSON.stringify([scope(principal), context])).digest('hex');
const contextName = (principal, context) => `vb-caller-${namespace.slice(0,16)}-${scope(principal)}-ctx-${contextKey(principal, context)}`;
const command = async args => (await exec('docker', args, {timeout:30000})).stdout.trim();
async function running(name, label) {
  try { const marker=JSON.parse(await command(['exec', name, 'cat', '/workspace/running'])); return Number.isInteger(marker.pid) && marker.prompt.includes(label); }
  catch { return false; }
}
async function awaitRunning(name, label) {
  const deadline = Date.now()+60000;
  while(!(await running(name, label))) {
    if(Date.now()>deadline) throw Error(`execution did not start: ${name}\n${logs}\n${JSON.stringify(frames)}`);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
}
let initialized = false;
try {
  await exec(binary, ['container', 'init', kind, '--config', configPath, '--image', image,
    '--storage-pool', storagePool, '--storage-mib', '64', '--storage-capacity-mib', '128', '--storage-reserve-mib', '64'],
    {env:clientEnv,cwd:directory,timeout:300000});
  const prepared = JSON.parse(await readFile(configPath,'utf8'));
  if(kind==='claude') prepared.backends[kind].remote_approvals=true;
  else prepared.backends[kind].approval_decision='remote';
  prepared.backends[kind].caller_runtime.fileDelivery={allowedRoots:['/workspace/output']};
  prepared.backends[kind].caller_runtime.concurrency = {perCaller:2,global:2,queuePerCaller:4,queueTimeoutMs:120000};
  await writeFile(configPath,JSON.stringify(prepared),{mode:0o600});
  initialized = true;
  namespace = createHash('sha256').update(JSON.stringify([hostname(),await realpath(config.backends[kind].caller_runtime.stateDirectory),'smoke'])).digest('hex');
  await start();
  assign('apikey:a','A1','wait-task A1','A');
  const a = contextName('apikey:a','A'), b = contextName('apikey:a','B');
  await awaitRunning(a,'A1');
  assign('apikey:a','A2','hello','A');
  assign('apikey:a','B1','wait-task B1','B');
  await awaitRunning(b,'B1');
  assert.ok(await running(a,'A1'), 'A and B must actually execute simultaneously');
  const overlap = new Date().toISOString();
  assert.equal(await command(['exec',a,'cat','/workspace/counter']),'1');
  assert.equal(await command(['exec',b,'cat','/workspace/counter']),'1');
  assert.equal((await exec('docker',['exec',b,'sh','-c','echo forbidden > /caller-workspace/write'],{timeout:30000}).then(()=>true,()=>false)),false);
  assign('apikey:b','other','hello','other');
  await new Promise(resolve=>setTimeout(resolve,250));
  assert.ok(!frames.some(frame=>frame.taskId==='other' && frame.type==='task.complete'));
  socket.send(JSON.stringify({type:'task.cancel',taskId:'A1'}));
  await waitFor(()=>frames.some(frame=>frame.taskId==='A1' && ['task.complete','task.fail'].includes(frame.type)),'cancel A1',60000);
  assert.ok(await running(b,'B1'),'cancel A must preserve B');
  const a2 = await completed('A2');
  assert.equal(a2.turn,2,'context workspace survives cancellation');
  assert.equal(a2.resumed,false,'canceled conversation resets');
  assert.equal((await completed('other')).turn,1,'another caller progresses while B is running');
  await command(['exec',b,'touch','/workspace/release']);
  const b1 = await completed('B1');
  {
    const files = id => frames.filter(frame=>frame.taskId===id && frame.type==='task.artifact').flatMap(frame=>frame.artifact.parts).filter(part=>part.kind==='file');
    assert.equal(files('A1').length,1);
    assert.equal(files('B1').length,1);
    const aFile=JSON.parse(Buffer.from(files('A1')[0].file.bytes,'base64').toString());
    const bFile=JSON.parse(Buffer.from(files('B1')[0].file.bytes,'base64').toString());
    assert.notEqual(aFile.session,bFile.session,'same file name must not cross execution bindings');
    assert.deepEqual(bFile,b1);
  }
  assign('apikey:a','B2','hello','B');
  const b2 = await completed('B2');
  assert.equal(b2.turn,2);
  assert.equal(b2.session,b1.session);
  assert.equal(b2.resumed,true);
  assert.notEqual(b2.session,a2.session);
  // Kill the trusted execution supervisor: the broker fallback must stop only A.
  assign('apikey:a','helperFailure','wait-task helperFailure','A');
  assign('apikey:a','survivor','wait-task survivor','B');
  await awaitRunning(a,'helperFailure');
  await awaitRunning(b,'survivor');
  await command(['exec','--user','0',a,'/usr/local/bin/node','-e',
    "const fs=require('fs');const parent=pid=>Number(fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[1]);const pid=JSON.parse(fs.readFileSync('/workspace/running','utf8')).pid;process.kill(parent(parent(pid)),'SIGKILL');"]);
  await waitFor(()=>frames.some(frame=>frame.taskId==='helperFailure' && frame.type==='task.fail'),'helper failure terminal',60000);
  assert.ok(await running(b,'survivor'),'failed supervisor must not terminate sibling');
  await command(['exec',b,'touch','/workspace/release']);
  const survivor=await completed('survivor');
  assert.equal(survivor.session,b2.session);
  // Crash with a live context, reconcile its exact owned resources, then retain files.
  assign('apikey:a','crash','wait-task crash','B');
  await awaitRunning(b,'crash');
  await stop('SIGKILL');
  await start();
  assign('apikey:a','restored','hello','B');
  const restored = await completed('restored');
  assert.equal(restored.turn,survivor.turn+2);
  assert.equal(restored.resumed,false);
  assert.ok(frames.some(frame=>frame.taskId==='restored' && frame.metadata?.['vicoop.runtime']?.conversationReset));
  await stop();
  await start();
  assign('apikey:a','approvalA','approval-task A','A');
  assign('apikey:a','approvalB','approval-task B','B');
  await waitFor(()=>['approvalA','approvalB'].every(id=>frames.some(frame=>frame.type==='approval.request' && frame.taskId===id)),'concurrent approvals',60000);
  const approvalB=frames.find(frame=>frame.type==='approval.request' && frame.taskId==='approvalB');
  socket.send(JSON.stringify({type:'approval.resolve',taskId:'approvalA',executionId:'exec-approvalA',requestId:approvalB.request.requestId,decision:'allow_once'}));
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.ok(!frames.some(frame=>frame.type==='approval.received' && frame.taskId==='approvalB'));
  socket.send(JSON.stringify({type:'task.cancel',taskId:'approvalA'}));
  await waitFor(()=>frames.some(frame=>frame.taskId==='approvalA' && ['task.complete','task.fail'].includes(frame.type)),'cancel approval A',60000);
  socket.send(JSON.stringify({type:'approval.resolve',taskId:'approvalB',executionId:'exec-approvalB',requestId:approvalB.request.requestId,decision:'allow_once'}));
  await completed('approvalB');
  assert.ok(frames.some(frame=>frame.type==='approval.received' && frame.taskId==='approvalB' && frame.decision==='allow_once'));
  assign('apikey:a','image','image-check','B');
  const imageResult=await completed('image');
  await stop();
  // Reducing execution parallelism preserves context layout and data.
  prepared.backends[kind].caller_runtime.concurrency.perCaller = 1;
  await writeFile(configPath,JSON.stringify(prepared),{mode:0o600});
  await start();
  assign('apikey:a','serialized','hello','B');
  assert.equal((await completed('serialized')).turn,imageResult.turn+1);
  await stop();
  const db = new Database(join(directory,'state','state.sqlite'),{readonly:true});
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM scopes').get().n,2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM caller_contexts').get().n,3);
  } finally { db.close(); }
  console.log(JSON.stringify({result:'PASS',kind,overlap,checks:['actual concurrent processes','context FIFO','same-name file isolation','read-only legacy workspace','sibling cancellation','supervisor failure isolation','other caller progress','conversation resume','approval isolation','inline image routing','crash recovery','perCaller=1 rollback']}));
} finally {
  await stop();
  for(const ws of server.clients) ws.terminate();
  await new Promise(resolve=>server.close(resolve));
  if(initialized) {
    for(const principal of principals) {
      await exec(binary,['container','remove',scope(principal),'--config',configPath],{env:clientEnv,timeout:60000});
    }
    await command(['volume','rm',storagePool]);
    await rm(directory,{recursive:true,force:true});
  } else console.error('Initialization recovery directory:',directory);
}
