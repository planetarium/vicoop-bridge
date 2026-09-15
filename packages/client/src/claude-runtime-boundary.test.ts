import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBrokerContainer } from './execution-runtime-boundary.js';
import { RuntimeContainer } from './runtime-container.js';
const container = () => ({ Config: { User: 'node', Labels: { 'vicoop.claude-auth': 'stdio-v1', 'vicoop.name': 'work' },
  Env: ['CLAUDE_CONFIG_DIR=/data/sessions/claude/config'] },
  HostConfig: { NetworkMode: 'default', CapAdd: ['NET_ADMIN', 'NET_RAW'], SecurityOpt: ['no-new-privileges'] },
  Mounts: [{Type:'volume',Name:'vicoop-agents-'+('work'),Destination:'/data/agents/claude'},{Type:'volume',Name:'vicoop-sessions-'+('work'),Destination:'/data/sessions/claude'},{Type:'tmpfs',Destination:'/data/creds/claude'}] });

test('reject legacy/unsafe runtime inspect without leaking credentials in diagnostics', () => {
  assert.doesNotThrow(() => assertBrokerContainer(JSON.stringify(container()), 'claude', 'work'));
  for (const mutate of [
    (c: any) => c.Config.Labels = {},
    (c: any) => c.Mounts = [],
    ...[0, 1, 2].map(index => (c: any) => c.Mounts.splice(index, 1)),
    (c: any) => c.Config.Labels['vicoop.name'] = 'other',
    (c: any) => c.Config.Env.push('GOOGLE_API_KEY=SECRET_VALUE'),
    (c: any) => c.Config.Env.push('GEMINI_API_KEY=SECRET_VALUE'),
    (c: any) => c.HostConfig.UsernsMode = 'host',
    (c: any) => c.HostConfig.IpcMode = 'container:other',
    (c: any) => c.HostConfig.DeviceRequests = [{Count: -1}],
    (c: any) => c.Config.Env.push('ANTHROPIC_API_KEY=SECRET_VALUE'),
    (c: any) => c.Mounts.push({Type:'volume',Destination:'/data/creds/claude'}),
    (c: any) => c.Mounts[0].Name = 'vicoop-creds-work',
    (c: any) => c.Mounts.push({Type:'bind',Destination:'/var/run/docker.sock'}),
    (c: any) => c.Config.User = '0',
    (c: any) => c.HostConfig.NetworkMode = 'container:other',
    (c: any) => c.HostConfig.CapAdd = ['SYS_ADMIN'],
    (c: any) => c.HostConfig.CapAdd = [],
    (c: any) => delete c.HostConfig.CapAdd,
    (c: any) => c.HostConfig.SecurityOpt = [],
    ...['seccomp=unconfined', 'apparmor=unconfined', 'seccomp:unconfined', 'apparmor:unconfined'].map(option =>
      (c: any) => c.HostConfig.SecurityOpt.push(option)),
  ]) {
    const c = container(); mutate(c);
    assert.throws(() => assertBrokerContainer(JSON.stringify(c), 'claude', 'work'), e => e instanceof Error && /migration/.test(e.message) && !e.message.includes('SECRET_VALUE'));
  }
});

test('new Claude runtime mounts only agent/session volumes and applies firewall before returning', async () => {
  const calls: string[][] = [];
  const runtime = new RuntimeContainer({ backendKind:'claude', runtimeName:'work', createIfMissing:true,
    dockerRun(args) {
      calls.push([...args]);
      const stdout = args[0] === 'version' ? '27' : args.includes('{{json .}}') ? JSON.stringify(container()) : args.includes('{{.State.Status}}') ? 'running' : '';
      return {exitCode:0,stdout,stderr:''};
    } });
  await runtime.start();
  const create = calls.find(c => c[0] === 'create')!;
  assert.ok(!create.some(c => c.includes('source=vicoop-creds-')));
  assert.ok(create.includes('CLAUDE_CONFIG_DIR=/data/sessions/claude/config'));
  assert.ok(create.includes('no-new-privileges'));
  const firewall = calls.at(-1)!;
  assert.deepEqual(firewall.slice(0,4), ['exec','--user','0','vicoop-runtime-work']);
  assert.equal(firewall[4], '/bin/sh');
  assert.match(firewall.at(-1)!, /ip6tables -w -P OUTPUT DROP/);
  const script = firewall.at(-1)!;
  assert.ok(script.indexOf('PATH=/usr/sbin:/usr/bin:/sbin:/bin') < script.indexOf('iptables -w -N'));
  assert.ok(script.indexOf('--dport 53 -j ACCEPT') < script.indexOf('-d 192.168.0.0/16 -j REJECT'));
  assert.match(script, /-p tcp --dport 53 -j ACCEPT/);
});

test('legacy runtime is rejected before start or any credential probe', async () => {
  const calls: string[][] = [];
  const runtime = new RuntimeContainer({backendKind:'claude', dockerRun(args) {
    calls.push([...args]);
    return {exitCode:0,stdout: args[0] === 'version' ? '27' : args[0] === 'ps' ? 'container-id' : '{}',stderr:''};
  }});
  await assert.rejects(runtime.start(), /migration/);
  assert.ok(!calls.some(c => c[0] === 'start' || c[0] === 'exec'));
});

test('broker boundary allows custom seccomp and AppArmor profiles', () => {
  const c = container();
  c.HostConfig.SecurityOpt.push('seccomp=/etc/docker/restricted.json', 'apparmor=vicoop-restricted');
  assert.doesNotThrow(() => assertBrokerContainer(JSON.stringify(c), 'claude', 'work'));
});

test('workspace comparison accepts canonical equivalents including symlinks', async () => {
  const {mkdtempSync, mkdirSync, symlinkSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'runtime-workspace-'));
  try {
    const source = join(dir, 'project');
    const alias = join(dir, 'alias');
    mkdirSync(source);
    symlinkSync(source, alias);
    const c = {...container(), Mounts: [...container().Mounts, {Type: 'bind', Source: source, Destination: '/workspace'}]};
    assert.doesNotThrow(() => assertBrokerContainer(JSON.stringify(c), 'claude', 'work', alias));
    assert.throws(() => assertBrokerContainer(JSON.stringify(c), 'claude', 'work', join(dir, 'other')), /workspace differs/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
