import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from './config.js';
import { mergeClientArgs, parseFlags } from './cli-args.js';
import { ClaudeSendFileConfig, MAX_CLAUDE_SEND_FILE_BYTES, sendFilePendingBytes } from './send-file-config.js';

const base = { server_token:'fixture', agent_id:'fixture', backend:'claude' };
const root = join(tmpdir(), 'output with spaces');

test('native send-file is opt-in; flags override config roots and size independently', () => {
  const disabled = mergeClientArgs({}, base);
  assert.ok(disabled.ok);
  assert.equal(disabled.args.claudeSendFile, undefined);
  assert.equal(sendFilePendingBytes(undefined), undefined);
  const flags = parseFlags(['--claude-send-file-root',root,'--claude-send-file-max-bytes','65536']);
  assert.ok(flags.ok);
  const result = mergeClientArgs(flags.flags,{...base,backends:{claude:{send_file:{allowed_roots:[tmpdir()],max_bytes:1024}}}});
  assert.ok(result.ok);
  assert.deepEqual(result.args.claudeSendFile,{allowed_roots:[root],max_bytes:65536});
  const onlySize = mergeClientArgs({claudeSendFileMaxBytes:2048},{...base,backends:{claude:{send_file:{allowed_roots:[root],max_bytes:1024}}}});
  assert.ok(onlySize.ok);
  assert.deepEqual(onlySize.args.claudeSendFile,{allowed_roots:[root],max_bytes:2048});
});

test('config round-trip preserves explicit roots and materializes the bounded default', t => {
  const dir = mkdtempSync(join(tmpdir(),'send-file-config-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file = join(dir,'config.json');
  writeFileSync(file,JSON.stringify({...base,backends:{claude:{send_file:{allowed_roots:[root]}}}}));
  const config = readConfig(file)!;
  const result = mergeClientArgs({},config);
  assert.ok(result.ok);
  assert.deepEqual(result.args.claudeSendFile,{allowed_roots:[root],max_bytes:6*1024*1024});
  writeFileSync(file,JSON.stringify({...base,backends:{claude:{send_file:{allowed_roots:['.']}}}}));
  assert.throws(()=>readConfig(file),/absolute paths/);
});

test('invalid roots, oversized/invalid caps and unsupported runtimes fail closed', () => {
  for (const raw of [
    {allowed_roots:[]},{allowed_roots:['.']},{allowed_roots:[root],host:'0.0.0.0'},
    ...[0,-1,0.5,NaN,Infinity,MAX_CLAUDE_SEND_FILE_BYTES+1].map(max_bytes=>({allowed_roots:[root],max_bytes})),
  ]) assert.equal(ClaudeSendFileConfig.safeParse(raw).success,false);
  for (const flags of [
    {claudeSendFileMaxBytes:10}, {claudeSendFileRoot:' '},
    {claudeSendFileRoot:root,backend:'codex' as const},
    {claudeSendFileRoot:root,runtime:'container' as const},
  ]) assert.equal(mergeClientArgs(flags,base).ok,false);
  assert.equal(parseFlags(['--claude-send-file-max-bytes','8388609']).ok,false);
});

test('pending queue has headroom for two maximum base64 frames and each fits gateway ingress', () => {
  const config = ClaudeSendFileConfig.parse({allowed_roots:[root],max_bytes:MAX_CLAUDE_SEND_FILE_BYTES});
  const frameBytes = 4*Math.ceil(config.max_bytes/3)+1024*1024;
  assert.ok(frameBytes < 16*1024*1024);
  assert.ok(sendFilePendingBytes(config)! >= frameBytes*2);
});
