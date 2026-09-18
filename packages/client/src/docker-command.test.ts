import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedCommand } from './docker-command.js';

test('bounded commands keep the event loop responsive and preserve output/exit status', async () => {
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 10);
  const result = await runBoundedCommand(process.execPath, ['-e',
    'setTimeout(() => { process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7; }, 80)',
  ]);
  clearTimeout(timer);
  assert.equal(ticked, true);
  assert.deepEqual(result, { stdout: 'out', stderr: 'err', exitCode: 7 });
});

test('timeout and abort bound commands that never finish', async () => {
  const args = ['-e', 'setInterval(() => {}, 1000)'];
  await assert.rejects(runBoundedCommand(process.execPath, args, { timeoutMs: 50 }), /timed out/);
  const controller = new AbortController();
  const pending = runBoundedCommand(process.execPath, args, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /aborted/);
  await assert.rejects(runBoundedCommand('must-not-be-spawned', [], { signal: controller.signal }), /before start/);
});

test('spawn errors and excessive output settle with errors', async () => {
  await assert.rejects(runBoundedCommand('/nonexistent/vicoop-497-command', []), /ENOENT/);
  await assert.rejects(runBoundedCommand(process.execPath, ['-e',
    'process.stdout.write(Buffer.alloc(2 * 1024 * 1024)); setInterval(() => {}, 1000)',
  ]), /exceeded/);
});


test('binary input preserves bytes and an aborted blocked stdin transfer settles promptly', async () => {
  const data = Buffer.from([0, 255, 1, 128]);
  const result = await runBoundedCommand(process.execPath, ['-e', 'const chunks=[];process.stdin.on("data",c=>chunks.push(c));process.stdin.on("end",()=>process.stdout.write(Buffer.concat(chunks).toString("hex")))'], { input: data });
  assert.equal(result.stdout, data.toString('hex'));
  assert.equal(result.exitCode, 0);
  const controller = new AbortController();
  const writing = runBoundedCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { input: Buffer.alloc(8 * 1024 * 1024), signal: controller.signal });
  const rejected = assert.rejects(writing, /aborted/);
  controller.abort();
  await rejected;
});
