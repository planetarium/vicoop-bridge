import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

// Execute the shipped script against a fake Docker filesystem: stopping the
// runtime discards creds tmpfs while preserving its sessions volume.
for (const kind of ['codex', 'claude']) {
  test(`fork harness remains discoverable after ${kind} runtime stops`, {skip: process.platform === 'win32'}, () => {
    const root = mkdtempSync(join(tmpdir(), 'fork-harness-'));
    try {
      const bin = join(root, 'bin'), source = join(root, 'source');
      mkdirSync(bin); mkdirSync(join(source, 'skills', 'fixture'), {recursive: true});
      const memory = kind === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
      writeFileSync(join(source, memory), 'Fixture project instructions');
      writeFileSync(join(source, 'skills', 'fixture', 'SKILL.md'), 'Fixture skill');
      writeFileSync(join(source, 'auth.json'), 'fixture-secret');
      writeFileSync(join(source, 'skills', 'fixture', 'auth.json'), 'fixture-secret');
      writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');
const args=process.argv.slice(2),root=process.env.FORK_TEST_ROOT;
fs.appendFileSync(p.join(root,'calls.jsonl'),JSON.stringify(args)+'\\n');
if(args[0]==='inspect' && args.includes('--format')) console.log('false');
if(args[0]==='stop') fs.rmSync(p.join(root,'data','creds'),{recursive:true,force:true});
if(args[0]==='exec') {
  const target=args.at(-1);
  if(!target.startsWith('/data/')) process.exit(2);
  const actual=p.join(root,target);
  const r=cp.spawnSync('/bin/sh',['-c',args.at(-3),'sh',actual],{stdio:'inherit'});
  process.exit(r.status??1);
}
`, {mode: 0o700});
      writeFileSync(join(bin, 'vicoop-client'), '#!/bin/sh\nexit 99\n', {mode: 0o700});
      const script = fileURLToPath(new URL('../../../skills/fork-into-container/fork.sh', import.meta.url));
      const result = spawnSync('bash', [script], {encoding: 'utf8', timeout: 15000, env: {
        ...process.env, PATH: bin + delimiter + process.env.PATH,
        VICOOP_FORK_KIND: kind, CODEX_HOME: source, CLAUDE_CONFIG_DIR: source, FORK_TEST_ROOT: root,
      }});
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).injected_into, `/data/sessions/${kind}/config`);
      const config = join(root, 'data', 'sessions', kind, 'config');
      assert.equal(readFileSync(join(config, memory), 'utf8'), 'Fixture project instructions');
      assert.equal(readFileSync(join(config, 'skills', 'fixture', 'SKILL.md'), 'utf8'), 'Fixture skill');
      assert.ok(!existsSync(join(config, 'auth.json')));
      assert.ok(!existsSync(join(config, 'skills', 'fixture', 'auth.json')));
      const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(calls.at(-1), ['stop', `vicoop-runtime-${kind}`]);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
}
