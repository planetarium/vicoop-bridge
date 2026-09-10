import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createClaudeBrokerSpawn } from './claude-broker-spawn.js';

// Exercise the real relay/HTTP parser through OS pipes, with no Docker needed.
// The wrapper mirrors successful supervisor cleanup (transport exit 0) even
// when the relay exits on EOF. Actual root supervision is tested in Docker.
const localSpawn: typeof spawn = ((_cmd: string, args: string[], opts: object) =>
  spawn('/bin/sh', ['-c', '"$@"; exit 0', 'supervisor-stand-in', process.execPath, '-e', args[args.length - 1]],
    { ...opts, env: { PATH: process.env.PATH } })) as typeof spawn;

test('cancellation closes trusted input even when kill frames are ignored', async () => {
  for (const signal of ['SIGTERM','SIGKILL'] as const) {
    let ready!: () => void;
    const started=new Promise<void>(resolve=>{ready=resolve;});
    const ignoringRelay: typeof spawn = ((_cmd: string, _args: string[], opts: object) => {
      const processChild=spawn(process.execPath,['-e',`
        process.stdin.on('data',()=>{});
        process.stdin.on('end',()=>process.exit(0));
        console.log(JSON.stringify({t:'ready'}));
      `],{...opts,env:{PATH:process.env.PATH}});
      processChild.stdout!.once('data',ready);
      return processChild;
    }) as typeof spawn;
    const adapter=createClaudeBrokerSpawn('fixture',{spawnImpl:ignoringRelay,
      credential:()=>({kind:'oauth',secret:'mock-only'})});
    const child=adapter.spawn('unused',[],{});
    child.stdout!.resume();child.stderr!.resume();
    const closed=new Promise<number|null>(resolve=>child.on('close',resolve));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await started;
      child.kill(signal);
      const code=await Promise.race([closed,new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error('cancellation did not close supervisor input')),1000);
      })]);
      assert.equal(code,1);
    } finally {clearTimeout(timer);adapter.close();await closed;}
  }
});

test('an exit frame cannot report completion before the supervisor transport exits', async () => {
  let transportClosed = false;
  const earlyExit: typeof spawn = ((_cmd: string, _args: string[], opts: object) => {
    const child = spawn(process.execPath, ['-e', `
      console.log(JSON.stringify({t:'exit',code:0}));
      setTimeout(()=>process.exit(0),100);
    `], opts);
    child.on('close',()=>{transportClosed=true;});
    return child;
  }) as typeof spawn;
  const adapter = createClaudeBrokerSpawn('fixture', {spawnImpl:earlyExit,
    credential:()=>({kind:'oauth',secret:'mock-only'})});
  try {
    const child=adapter.spawn('unused',[],{});
    child.stdout!.resume();child.stderr!.resume();
    await new Promise<void>(resolve=>child.on('close',()=>resolve()));
    assert.ok(transportClosed, 'untrusted exit frame bypassed supervisor cleanup');
  } finally {adapter.close();}
});

test('stdio broker substitutes host OAuth, preserves SSE and per-spawn env, strips headers', async () => {
  const upstream = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer host-secret');
    assert.equal(req.headers['x-api-key'], undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.match(req.headers['anthropic-beta'] as string, /oauth-2025-04-20/);
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-secret': 'host-secret' });
    res.write('data: {"usage":{"input_tokens":12}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const adapter = createClaudeBrokerSpawn('fixture', {
    credential: () => ({ kind: 'oauth', secret: 'host-secret' }),
    upstream: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, spawnImpl: localSpawn,
  });
  try {
    const child = adapter.spawn(process.execPath, ['-e', `
      (async () => {
        const assert = require('node:assert/strict');
        assert.equal(process.env.ENABLE_PROMPT_CACHING_1H, '1');
        assert.ok(!JSON.stringify(process.env).includes('host-secret'));
        const r = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages?beta=true', {
          method:'POST', headers:{authorization:'Bearer '+process.env.CLAUDE_CODE_OAUTH_TOKEN, cookie:'drop-me'},
          body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:32,messages:[]})});
        assert.equal(r.status, 200); assert.equal(r.headers.get('x-secret'), null);
        process.stdout.write(await r.text());
      })().catch(e => { console.error(e); process.exitCode=1; });
    `], { env: { ENABLE_PROMPT_CACHING_1H: '1' } });
    let output = ''; let error = '';
    child.stdout!.on('data', c => output += c);
    child.stderr!.on('data', c => error += c);
    const done = new Promise<number | null>(resolve => child.on('close', resolve));
    child.stdin!.end('prompt');
    assert.equal(await done, 0, error);
    assert.equal(output, 'data: {"usage":{"input_tokens":12}}\n\ndata: [DONE]\n\n');
  } finally { adapter.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); }
});

test('cancellation closes an active upstream transport, observed by an independent Node process', async () => {
  const upstream = spawn('node', ['-e', `
    const server = require('http').createServer(async (req,res) => {
      for await (const c of req) {}
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write('data: {"started":true}\\n\\n');
      console.log('active');
      res.on('close',()=>{console.log('disconnected');});
    });
    server.listen(0,'127.0.0.1',()=>console.log(server.address().port));
  `], {stdio:['ignore','pipe','pipe']});
  let output = '';
  const waitFor = (pattern: RegExp) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { upstream.stdout.off('data',check); reject(new Error('Upstream event timed out')); },4000);
    const check = () => { if (pattern.test(output)) { clearTimeout(timeout); upstream.stdout.off('data',check); resolve(); } };
    upstream.stdout.on('data',check); check();
  });
  upstream.stdout.on('data', c => output += c);
  await waitFor(/^\d+\n/);
  const adapter = createClaudeBrokerSpawn('fixture', { spawnImpl:localSpawn,
    credential: () => ({kind:'oauth',secret:'host-secret'}), upstream:`http://127.0.0.1:${Number(output.split('\n')[0])}` });
  try {
    const child = adapter.spawn('node',['-e', `
      fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',
        headers:{authorization:'Bearer '+process.env.CLAUDE_CODE_OAUTH_TOKEN},
        body:JSON.stringify({model:'claude-haiku-4-5',max_tokens:32,messages:[]})})
      .then(r=>r.text()).catch(()=>{});
    `],{});
    child.stdout!.resume(); child.stderr!.resume();
    const done = new Promise<void>(r => child.on('close',()=>r()));
    child.stdin!.end();
    await waitFor(/active/); child.kill('SIGTERM');
    await waitFor(/disconnected/); await done;
  } finally { adapter.close(); upstream.kill('SIGKILL'); }
});

test('host prompt files are staged for the workload and removed after execution', async () => {
  const {mkdtempSync,writeFileSync,existsSync,rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os'); const {join} = await import('node:path');
  const hostDir=mkdtempSync(join(tmpdir(),'host-prompt-'));
  const hostFile=join(hostDir,'prompt.txt');
  // Larger than one frame, including Unicode and newlines.
  const content='system instruction 한글\n'.repeat(20000);
  writeFileSync(hostFile,content);
  const adapter=createClaudeBrokerSpawn('fixture',{spawnImpl:localSpawn,credential:()=>({kind:'oauth',secret:'host-secret'})});
  try {
    const child=adapter.spawn('node',['-e',`const fs=require('fs'); const path=process.argv[2]; console.log(JSON.stringify({path,bytes:fs.statSync(path).size,tail:fs.readFileSync(path,'utf8').slice(-22)}));`,'--','--append-system-prompt-file',hostFile],{});
    let output='';child.stdout!.on('data',c=>output+=c);child.stderr!.resume();
    const done=new Promise<number|null>(r=>child.on('close',r));child.stdin!.end();
    assert.equal(await done,0);
    const result=JSON.parse(output);
    assert.notEqual(result.path,hostFile);
    assert.equal(result.bytes,Buffer.byteLength(content));
    assert.equal(result.tail,content.slice(-22));
    // The relay flushes its exit frame before its own cleanup completes.
    for(let n=0;n<30 && existsSync(result.path);n++) await new Promise(r=>setTimeout(r,10));
    assert.ok(!existsSync(result.path));assert.ok(existsSync(hostFile));
  } finally {adapter.close();rmSync(hostDir,{recursive:true,force:true});}
});
