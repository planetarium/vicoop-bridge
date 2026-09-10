// Real Docker transport/runtime smoke. --real uses the existing host OAuth
// allowance for two small Haiku turns; otherwise only a local mock is called.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync, spawn } from 'node:child_process';
import { createClaudeBrokerSpawn } from '../../src/claude-broker-spawn.js';
import { createClaudeCredentialReader } from '../../src/claude-auth-broker.js';
import { RuntimeContainer } from '../../src/runtime-container.js';
import { migrateClaudeSessions } from '../../src/container-init.js';
import { createLogger } from '../../src/logger.js';
import type { ChildHandle } from '../../src/spawn-adapter.js';

// A separate bridge process used to verify abrupt host death, including under
// Bun --compile. Its only output is the workload PID, never its grant/secret.
const workerIndex = process.argv.indexOf('--crash-worker');
if (workerIndex >= 0) {
  const workerAdapter = createClaudeBrokerSpawn(process.argv[workerIndex + 1], {
    credential: () => ({kind:'oauth',secret:'fixture-host-only'}),
  });
  const child = workerAdapter.spawn('node',['-e','console.log(process.pid); setInterval(()=>{},1000)'],{});
  child.stdout!.on('data',c=>process.stdout.write(c)); child.stderr!.resume(); child.stdin!.end();
  await new Promise(() => {});
}

const real = process.argv.includes('--real') || process.argv.includes('--real-api');
const authentication = process.argv.includes('--real-api') ? 'api-key' : 'oauth';
const id = `auth-${randomBytes(6).toString('hex')}`;
const runtime = new RuntimeContainer({ backendKind: 'claude', runtimeName: id,
  image: process.env.VICOOP_SMOKE_IMAGE ?? 'ghcr.io/planetarium/vicoop-runtime:latest', createIfMissing: true, failIfExists: true });
const container = runtime.getContainerName();
const docker = (args: string[]) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`Docker ${args[0]} failed (exit ${r.status}); output withheld`);
  return r.stdout;
};
function capture(child: ChildHandle, input = '') {
  let stdout = ''; let stderr = '';
  child.stdout!.on('data', c => stdout += c);
  child.stderr!.on('data', c => stderr += c);
  const closed = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
  child.stdin!.end(input);
  return closed;
}
let forwarded = 0;
let hostProbeReached = 0;
let fakeKind: 'oauth' | 'api-key' = 'oauth';
const upstream = createServer(async (req, res) => {
  if (req.method === 'GET') { hostProbeReached++; res.end('test host service'); return; }
  assert.equal(req.headers[fakeKind === 'oauth' ? 'authorization' : 'x-api-key'], fakeKind === 'oauth' ? 'Bearer fixture-host-only' : 'fixture-host-only');
  for await (const _ of req) { /* drain */ }
  forwarded++;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'x-secret': 'fixture-host-only' });
  res.end('data: {"ok":true}\n\n');
});
// Test-only host service to prove the workload cannot reach a listening port.
upstream.listen(0, '0.0.0.0'); await once(upstream, 'listening');
const credential = real ? createClaudeCredentialReader() : () => ({ kind: fakeKind, secret: 'fixture-host-only' });
if (real) assert.equal((await credential()).kind,authentication,'Real smoke auth mode must match the selected host credential');
const adapter = createClaudeBrokerSpawn(container, {
  credential, authentication,
  ...(real ? {} : { upstream: `http://127.0.0.1:${(upstream.address() as {port:number}).port}` }),
  ttlMs: 180_000,
});
try {
  // Legacy fixture contains a sentinel login plus a conversation. No real secret.
  docker(['volume','create',`vicoop-creds-${id}`]);
  docker(['run','--rm','--network','none','--user','0',
    '--mount',`type=volume,source=vicoop-creds-${id},target=/legacy`,
    '--entrypoint','sh',process.env.VICOOP_SMOKE_IMAGE ?? 'ghcr.io/planetarium/vicoop-runtime:latest',
    '-c','mkdir -p /legacy/projects; echo legacy-secret > /legacy/.credentials.json; echo conversation > /legacy/projects/history.jsonl; chmod -R a+rX /legacy']);
  await runtime.start();
  docker(['exec', '--user', '0', container, 'chown', '-R', 'node:node', '/data/sessions/claude']);
  await migrateClaudeSessions(id, process.env.VICOOP_SMOKE_IMAGE ?? 'ghcr.io/planetarium/vicoop-runtime:latest', createLogger());
  assert.equal(docker(['exec',container,'cat','/data/sessions/claude/config/projects/history.jsonl']).trim(),'conversation');
  const inspect = JSON.parse(docker(['inspect', '--format', '{{json .}}', container]));
  assert.ok(!inspect.Mounts.some((m: {Destination:string}) => m.Destination === '/data/creds/claude' && m.Type !== 'tmpfs'));
  const probe = await capture(adapter.spawn('node', ['-e', `
    (async () => {
      const assert = require('assert/strict'), fs = require('fs');
      assert.ok(!JSON.stringify(process.env).includes(['fixture','host','only'].join('-')));
      assert.ok(!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-api03-bridge-'));
      assert.ok(!fs.existsSync('/data/creds/claude/.credentials.json'));
      assert.ok(!fs.existsSync('/data/sessions/claude/config/.credentials.json'));
      assert.ok(!fs.readFileSync('/proc/self/cmdline','utf8').includes(['fixture','host','only'].join('-')));
      // Network boundary: the private host gateway is not reachable.
      let denied = false;
      try { await fetch('http://host.docker.internal:${(upstream.address() as {port:number}).port}', {signal:AbortSignal.timeout(1000)}); } catch { denied = true; }
      assert.ok(denied);
      if (!${real}) {
        const r = await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages', {
          method:'POST',headers:{authorization:'Bearer '+process.env.CLAUDE_CODE_OAUTH_TOKEN},
          body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:32,messages:[]})});
        assert.equal(r.status,200); assert.equal(r.headers.get('x-secret'),null);
        assert.equal(await r.text(),'data: {"ok":true}\\n\\n');
      }
      console.log(JSON.stringify({probe:'pass',env:process.env,argv:fs.readFileSync('/proc/self/cmdline','utf8'),processEnv:fs.readFileSync('/proc/self/environ','utf8')}));
    })().catch(() => { console.log('probe-fail'); process.exitCode=1; });
  `], {}));
  assert.equal(probe.code, 0, 'workload probe failed (diagnostics withheld)');
  assert.ok(probe.stdout.includes('\"probe\":\"pass\"'),'workload probe did not complete');
  const providerSecret=(await credential()).secret;
  assert.ok(!(probe.stdout+probe.stderr).includes(providerSecret),'workload exposed the host provider credential');
  assert.equal(hostProbeReached,0,'workload reached the listening host service');
  if (!real) {
    fakeKind = 'api-key';
    const apiAdapter = createClaudeBrokerSpawn(container,{credential,authentication:'api-key',upstream:`http://127.0.0.1:${(upstream.address() as {port:number}).port}`});
    const r = await capture(apiAdapter.spawn('node', ['-e', `
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) throw Error('unexpected OAuth token');
      fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages/count_tokens', {method:'POST',
        headers:{'x-api-key':process.env.ANTHROPIC_API_KEY},
        body:JSON.stringify({model:'claude-sonnet-4-6',messages:[]})})
      .then(r=>{if(r.status!==200)process.exitCode=1;return r.text()}).catch(()=>process.exitCode=1);
    `], {}));
    apiAdapter.close();
    assert.equal(r.code, 0); assert.equal(forwarded, 2);
  } else {
    // Install the already-cached test Claude binary, never copying credentials.
    const source = `${id}-binary`;
    const image = process.env.VICOOP_SMOKE_CLAUDE_IMAGE ?? 'vicoop-caller-r2-validation:latest';
    const temp = mkdtempSync(join(tmpdir(), 'vicoop-auth-binary-'));
    try {
      docker(['create', '--name', source, '--network', 'none', image]);
      docker(['cp', '-L', `${source}:/usr/local/bin/claude`, join(temp, 'claude')]);
      docker(['exec', '--user', '0', container, 'mkdir', '-p', '/data/agents/claude/bin']);
      docker(['cp', join(temp, 'claude'), `${container}:/data/agents/claude/bin/claude`]);
    } finally { spawnSync('docker', ['rm', '-f', source], { stdio: 'ignore' }); rmSync(temp, {recursive:true,force:true}); }
    const common = ['-p', '--model', 'haiku', '--output-format', 'json', '--max-turns', '1', '--tools', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--dangerously-skip-permissions'];
    const first = await capture(adapter.spawn('claude', [...common, 'Remember the word ORCHID. Reply only OK.'], {}));
    assert.ok(!(first.stdout+first.stderr).includes(providerSecret),'inference diagnostics exposed a provider credential');
    let result; try { result = JSON.parse(first.stdout); } catch {}
    console.log(JSON.stringify({mode:`real-${authentication}`, turn:1, code:first.code, subtype:result?.subtype}));
    assert.equal(first.code, 0, 'real inference failed (raw diagnostics withheld)');
    assert.equal(result?.subtype, 'success'); assert.ok(result?.usage?.output_tokens > 0);
    const next = await capture(adapter.spawn('claude', [...common, '--resume', result.session_id, 'What word did I ask you to remember? Reply only that word.'], {}));
    assert.ok(!(next.stdout+next.stderr).includes(providerSecret),'continuation diagnostics exposed a provider credential');
    let continuation; try { continuation = JSON.parse(next.stdout); } catch {}
    console.log(JSON.stringify({mode:`real-${authentication}`, turn:2, code:next.code, subtype:continuation?.subtype}));
    assert.equal(next.code, 0); assert.equal(continuation?.subtype, 'success');
    assert.match(continuation.result, /ORCHID/);
    const snapshot = docker(['exec', container, 'sh', '-c', 'test ! -f /data/sessions/claude/config/.credentials.json && test ! -f /data/creds/claude/.credentials.json && echo clean']);
    assert.match(snapshot, /clean/);
  }
  const child = adapter.spawn('node', ['-e', `console.log(process.pid); setInterval(()=>{},1000)`], {});
  let pidText = '';
  const pidReady = new Promise<void>(resolve => child.stdout!.on('data', c => { pidText += c; if (pidText.includes('\n')) resolve(); }));
  const done = capture(child);
  await pidReady; child.kill('SIGTERM'); await done;
  const pid = Number(pidText.trim()); assert.ok(Number.isInteger(pid));
  const alive = spawnSync('docker', ['exec', container, 'test', '-e', `/proc/${pid}`]);
  assert.notEqual(alive.status, 0, 'cancelled process survived');
  // A stolen grant must fail in a second runtime, not just a second request.
  const peerId = `${id}-peer`;
  const peer = new RuntimeContainer({backendKind:'claude',runtimeName:peerId,
    image:process.env.VICOOP_SMOKE_IMAGE ?? 'ghcr.io/planetarium/vicoop-runtime:latest',createIfMissing:true,failIfExists:true});
  const peerAdapter = createClaudeBrokerSpawn(peer.getContainerName(),{credential:()=>({kind:'oauth',secret:'fixture-host-only'})});
  const owner = adapter.spawn('node',['-e',"console.log(JSON.stringify({token:process.env.CLAUDE_CODE_OAUTH_TOKEN||process.env.ANTHROPIC_API_KEY,url:process.env.ANTHROPIC_BASE_URL}));setInterval(()=>{},1000)"],{});
  let grantText='';
  const ownerDone=capture(owner);
  try {
    await new Promise<void>(resolve=>owner.stdout!.on('data',c=>{grantText+=c;if(grantText.includes('\n'))resolve();}));
    const grant=JSON.parse(grantText);
    await peer.start();
    const rejected=await capture(peerAdapter.spawn('node',['-e',`
      (async()=>{
        const assert=require('assert/strict');
        const response=await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',
          headers:{authorization:'Bearer '+${JSON.stringify(grant.token)}},
          body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:32,messages:[]})});
        assert.equal(response.status,401);
        // A's loopback endpoint is not exposed at A's container IP.
        let unreachable=false;
        try {await fetch('http://${JSON.parse(docker(['inspect','--format','{{json .NetworkSettings.IPAddress}}',container]))}:'+new URL(${JSON.stringify(grant.url)}).port,{signal:AbortSignal.timeout(1000)});}
        catch {unreachable=true;}
        assert.ok(unreachable);
      })().catch(()=>{process.exitCode=1;});
    `],{}));
    assert.equal(rejected.code,0,'stolen grant crossed runtime boundary');
  } finally {
    owner.kill('SIGKILL'); await ownerDone; peerAdapter.close();
    spawnSync('docker',['rm','-f',peer.getContainerName()],{stdio:'ignore'});
    for(const prefix of ['agents','sessions'])spawnSync('docker',['volume','rm',`vicoop-${prefix}-${peerId}`],{stdio:'ignore'});
  }

  // Kill the owning host process without any orderly shutdown callback.
  const workerArgs = process.versions.bun && !process.argv[1]?.endsWith('.ts')
    ? ['--crash-worker',container]
    : [...process.execArgv,process.argv[1],'--crash-worker',container];
  const workerTemp=mkdtempSync(join(tmpdir(),'vbc-'));
  const worker = spawn(process.execPath,workerArgs,{stdio:['ignore','pipe','pipe'],env:{...process.env,TMPDIR:workerTemp}});
  let workerPidText = '';
  try {
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Crash worker startup timed out')),15000);
      worker.stdout.on('data',c=>{workerPidText+=c;if(workerPidText.includes('\n')){clearTimeout(timer);resolve();}});
      worker.on('error',()=>{clearTimeout(timer);reject(new Error('Crash worker failed'));});
    });
    const workloadPid=Number(workerPidText.trim()); assert.ok(Number.isInteger(workloadPid));
    worker.kill('SIGKILL'); await once(worker,'close');
    let exists=true;
    for(let attempt=0;attempt<30;attempt++) {
      exists=spawnSync('docker',['exec',container,'test','-e',`/proc/${workloadPid}`]).status===0;
      if(!exists)break;
      await new Promise(r=>setTimeout(r,100));
    }
    assert.ok(!exists,'workload survived abrupt bridge death');
  } finally { worker.kill('SIGKILL'); rmSync(workerTemp,{recursive:true,force:true}); }
  console.log(JSON.stringify({mode:real?`real-${authentication}`:'mock-oauth-and-api-key', success:true, mockRequests:real?undefined:forwarded, cancellation:true, hostCrash:true, stolenGrantRejected:true}));
} finally {
  adapter.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r()));
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  for (const prefix of ['agents','sessions','creds']) spawnSync('docker', ['volume','rm',`vicoop-${prefix}-${id}`], { stdio: 'ignore' });
  assert.equal(docker(['ps','-aq','--filter',`name=^/${container}$`]).trim(), '');
}
