import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

// Execute the shipped script against a fake Docker filesystem: stopping the
// runtime discards creds tmpfs while preserving its sessions volume.
for (const kind of ['codex', 'claude']) {
 for (const mode of ['safe', 'legacy', 'credential-mount', 'credential-env', 'missing-firewall-capability', 'unconfined-seccomp', 'unconfined-apparmor', 'unsupported-client']) {
  test(`fork harness ${kind}: ${mode} boundary and persistence`, {skip: process.platform === 'win32'}, () => {
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
if(args[0]==='inspect' && args.includes('--format')) {
  if(args.includes('{{json .}}')) {
    const kind=process.env.VICOOP_FORK_KIND,mode=process.env.FORK_TEST_MODE;
    const c={Config:{User:'node',Labels:{['vicoop.'+kind+'-auth']:'stdio-v1','vicoop.name':kind},Env:[(kind==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR')+'=/data/sessions/'+kind+'/config']},HostConfig:{NetworkMode:'default',CapAdd:['NET_ADMIN','NET_RAW'],SecurityOpt:['no-new-privileges']},Mounts:[{Type:'volume',Name:'vicoop-sessions-'+kind,Destination:'/data/sessions/'+kind}]};
    if(mode==='missing-firewall-capability') c.HostConfig.CapAdd=[];
    if(mode==='unconfined-seccomp') c.HostConfig.SecurityOpt.push('seccomp=unconfined');
    if(mode==='unconfined-apparmor') c.HostConfig.SecurityOpt.push('apparmor=unconfined');
    if(mode==='legacy') c.Config.Labels={};
    if(mode==='credential-mount') c.Mounts.push({Type:'volume',Name:'vicoop-creds-'+kind,Destination:'/data/creds/'+kind});
    if(mode==='credential-env') c.Config.Env.push('OPENAI_API_KEY=fixture-secret');
    console.log(JSON.stringify(c));
  } else console.log('false');
}
if(args[0]==='stop') fs.rmSync(p.join(root,'data','creds'),{recursive:true,force:true});
if(args[0]==='exec') {
  const target=args.at(-1);
  if(!target.startsWith('/data/')) process.exit(2);
  const actual=p.join(root,target);
  const r=cp.spawnSync('/bin/sh',['-c',args.at(-3),'sh',actual],{stdio:'inherit'});
  process.exit(r.status??1);
}
`, {mode: 0o700});
      const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
      const tsx = createRequire(import.meta.url).resolve('tsx/cli');
      writeFileSync(join(bin, 'vicoop-client'), `#!/usr/bin/env node
if(process.env.FORK_TEST_MODE==='unsupported-client') process.exit(1);
const r=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(tsx)},${JSON.stringify(cli)},...process.argv.slice(2)],{stdio:'inherit'});
process.exit(r.status??1);
`, {mode: 0o700});
      const script = fileURLToPath(new URL('../../../skills/fork-into-container/fork.sh', import.meta.url));
      const result = spawnSync('bash', [script], {encoding: 'utf8', timeout: 15000, env: {
        ...process.env, PATH: bin + delimiter + process.env.PATH,
        VICOOP_FORK_KIND: kind, CODEX_HOME: source, CLAUDE_CONFIG_DIR: source, FORK_TEST_ROOT: root, FORK_TEST_MODE: mode,
      }});
      if (mode === 'unsupported-client') {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /update vicoop-client/);
        assert.ok(!existsSync(join(root, 'calls.jsonl')));
        return;
      }
      const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      if (mode !== 'safe') {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /runtime requires host-broker migration/);
        assert.match(result.stderr, /--preserve-volumes/);
        assert.match(result.stderr, /--reuse-state/);
        assert.ok(!result.stderr.includes('fixture-secret'));
        assert.ok(!calls.some(args => ['start', 'exec', 'stop'].includes(args[0])));
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).injected_into, `/data/sessions/${kind}/config`);
      const config = join(root, 'data', 'sessions', kind, 'config');
      assert.equal(readFileSync(join(config, memory), 'utf8'), 'Fixture project instructions');
      assert.equal(readFileSync(join(config, 'skills', 'fixture', 'SKILL.md'), 'utf8'), 'Fixture skill');
      assert.ok(!existsSync(join(config, 'auth.json')));
      assert.ok(!existsSync(join(config, 'skills', 'fixture', 'auth.json')));
      assert.deepEqual(calls.at(-1), ['stop', `vicoop-runtime-${kind}`]);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
}
}
