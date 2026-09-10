import test from 'node:test';
import assert from 'node:assert/strict';
import { assertClaudeBrokerContainer } from './claude-runtime-boundary.js';
import { RuntimeContainer } from './runtime-container.js';
const container = () => ({ Config: { User: 'node', Labels: { 'vicoop.claude-auth': 'stdio-v1', 'vicoop.name': 'work' },
  Env: ['CLAUDE_CONFIG_DIR=/data/sessions/claude/config'] },
  HostConfig: { NetworkMode: 'default', SecurityOpt: ['no-new-privileges'] },
  Mounts: [{ Type: 'volume', Name: 'vicoop-sessions-work', Destination: '/data/sessions/claude' }] });

test('reject legacy/unsafe runtime inspect without leaking credentials in diagnostics', () => {
  assert.doesNotThrow(() => assertClaudeBrokerContainer(JSON.stringify(container())));
  for (const mutate of [
    (c: any) => c.Config.Labels = {},
    (c: any) => c.Config.Env.push('ANTHROPIC_API_KEY=SECRET_VALUE'),
    (c: any) => c.Mounts.push({Type:'volume',Destination:'/data/creds/claude'}),
    (c: any) => c.Mounts[0].Name = 'vicoop-creds-work',
    (c: any) => c.Mounts.push({Type:'bind',Destination:'/var/run/docker.sock'}),
    (c: any) => c.Config.User = '0',
    (c: any) => c.HostConfig.NetworkMode = 'container:other',
    (c: any) => c.HostConfig.CapAdd = ['SYS_ADMIN'],
    (c: any) => c.HostConfig.SecurityOpt = [],
  ]) {
    const c = container(); mutate(c);
    assert.throws(() => assertClaudeBrokerContainer(JSON.stringify(c)), e => e instanceof Error && /migration/.test(e.message) && !e.message.includes('SECRET_VALUE'));
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
  assert.match(firewall.at(-1)!, /ip6tables -w -P OUTPUT DROP/);
  const script = firewall.at(-1)!;
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
