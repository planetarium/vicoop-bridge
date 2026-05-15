import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BRIDGE_URL, mergeClientArgs, parseFlags } from './cli-args.js';
import type { ClientConfig } from './config.js';

// mergeClientArgs is the pure precedence layer: CLI flags > env > config.
// Tests here cover only the merge — the IO-heavy loader (parseClientArgs)
// resolves the config file path on disk and is covered indirectly by
// setup.test.ts + config.test.ts.

const CONFIG: ClientConfig = {
  server_url: 'wss://from-config',
  server_token: 'tok-config',
  agent_id: 'agent-config',
  backend: 'codex',
  card: '/cfg/card.json',
  backends: { codex: { sandbox_mode: 'read-only' } },
};

test('CLI flags beat env beat config', () => {
  const r = mergeClientArgs(
    { server: 'wss://from-flag', token: 'tok-flag' },
    {
      SERVER_URL: 'wss://from-env',
      SERVER_TOKEN: 'tok-env',
      AGENT_ID: 'agent-env',
      BACKEND: 'claude',
    },
    CONFIG,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.server, 'wss://from-flag');
  assert.equal(r.args.token, 'tok-flag');
  // No flag for agentId → env wins over config
  assert.equal(r.args.agentId, 'agent-env');
  // No flag for backend → env wins over config
  assert.equal(r.args.backend, 'claude');
  // backends.* always comes from config (env has no override surface)
  assert.deepEqual(r.args.backends, CONFIG.backends);
});

test('config fills in fields absent from CLI flags and env', () => {
  const r = mergeClientArgs({}, {}, CONFIG);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.server, CONFIG.server_url);
  assert.equal(r.args.token, CONFIG.server_token);
  assert.equal(r.args.agentId, CONFIG.agent_id);
  assert.equal(r.args.backend, CONFIG.backend);
  assert.equal(r.args.card, CONFIG.card);
});

test('default backend is echo when neither flag, env, nor config sets it', () => {
  const r = mergeClientArgs(
    { server: 'wss://x', token: 't', agentId: 'a' },
    {},
    {},
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.backend, 'echo');
});

test('server falls back to DEFAULT_BRIDGE_URL when no flag/env/config sets it', () => {
  // Issue #189 §6: the public bridge URL is baked in so a fresh install
  // needs zero flags. `server` is therefore never in the missing list.
  const r = mergeClientArgs({}, { SERVER_TOKEN: 't', AGENT_ID: 'a' }, {});
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.server, DEFAULT_BRIDGE_URL);
});

test('missing required args reported as a list', () => {
  const r = mergeClientArgs({}, {}, {});
  assert.equal(r.ok, false);
  if (r.ok) return;
  // backend defaults to 'echo' and server defaults to DEFAULT_BRIDGE_URL,
  // so only the two credential fields can be missing.
  assert.deepEqual(r.missing, ['token', 'agentId']);
});

test('parseFlags picks up known flags', () => {
  const r = parseFlags([
    '--server', 'wss://x',
    '--token', 't',
    '--agentId', 'a',
    '--backend', 'claude',
    '--card', '/c.json',
    '--config', '/etc/vicoop/config.json',
  ]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.flags.server, 'wss://x');
  assert.equal(r.flags.token, 't');
  assert.equal(r.flags.agentId, 'a');
  assert.equal(r.flags.backend, 'claude');
  assert.equal(r.flags.card, '/c.json');
  assert.equal(r.flags.config, '/etc/vicoop/config.json');
});

test('parseFlags accepts --flag=value form (issue #189 §2)', () => {
  // Before optique the parser silently dropped `--backend=claude`, letting
  // it fall through to env then to `'echo'` — a confusing "wrong backend
  // ran" failure mode. Now it parses identically to the space-separated form.
  const r = parseFlags([
    '--server=wss://x',
    '--token=t',
    '--agentId=a',
    '--backend=claude',
    '--config=/etc/vicoop/config.json',
  ]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.flags.server, 'wss://x');
  assert.equal(r.flags.backend, 'claude');
  assert.equal(r.flags.config, '/etc/vicoop/config.json');
});

test('parseFlags rejects unknown flags (no more silent drop)', () => {
  // Old hand-rolled parser silently ignored unknown flags — fine for some
  // CLIs but for this one it masked real typos because the daemon would
  // then fall through to `'echo'` with no error. Optique rejects unknown
  // input.
  const r = parseFlags(['--server', 'wss://x', '--unknown', 'value']);
  assert.equal(r.ok, false);
});

test('parseFlags promotes env-only knobs to first-class flags (issue #189 §1)', () => {
  // The new flags should parse and round-trip through DaemonFlags so the
  // backend factories receive them via DaemonArgs rather than reading
  // process.env directly.
  const r = parseFlags([
    '--claude-cwd', '/workspaces/repo',
    '--codex-sandbox', 'workspace-write',
    '--openclaw-gateway', 'ws://gw:18789',
    '--openclaw-task-timeout-ms', '60000',
  ]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.flags.claudeCwd, '/workspaces/repo');
  assert.equal(r.flags.codexSandbox, 'workspace-write');
  assert.equal(r.flags.openclawGateway, 'ws://gw:18789');
  assert.equal(r.flags.openclawTaskTimeoutMs, 60000);
});

test('parseFlags fails when a known flag is missing its value', () => {
  // Trailing --config with no token after it should not silently set
  // config = undefined; report the missing value so the operator notices.
  const trailing = parseFlags(['--server', 'wss://x', '--config']);
  assert.equal(trailing.ok, false);
  if (trailing.ok) return;
  assert.match(trailing.error, /--config/);
});

test('parseFlags rejects invalid enum values (--codex-sandbox)', () => {
  // Type-safe enum checking happens at parse time; the old hand-rolled
  // parser punted this to `parseCodexSandboxMode` in cli.ts which exited
  // the process. Now it surfaces as a clean parse failure.
  const r = parseFlags(['--codex-sandbox', 'banana']);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /codex-sandbox/);
});

test('mergeClientArgs trims and treats whitespace-only as unset', () => {
  // Space-padded values from env or CLI should normalize to clean strings,
  // and a whitespace-only value should fall through to the next layer —
  // matching the same trim+drop semantics normalizeConfig applies to the
  // config layer.
  const r = mergeClientArgs(
    { server: '  wss://flag-padded  ', card: '   ' },
    { SERVER_TOKEN: '\ttoken-env\n', AGENT_ID: '   ' },
    { agent_id: 'agent-from-config', backend: 'claude' },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.server, 'wss://flag-padded');
  assert.equal(r.args.token, 'token-env');
  // env AGENT_ID is whitespace-only → falls through to config
  assert.equal(r.args.agentId, 'agent-from-config');
  // card was whitespace-only on both flag and env, and config has none →
  // resolves to undefined (not empty string).
  assert.equal(r.args.card, undefined);
});

test('empty env values fall through to config', () => {
  // install.sh ships the env template with empty `SERVER_TOKEN=` for the
  // operator to fill in. That empty string must not shadow a populated
  // config.json, otherwise an operator who finished setup via config.json
  // would suddenly find the daemon missing a token on next start.
  const r = mergeClientArgs(
    {},
    { SERVER_URL: '', SERVER_TOKEN: '', AGENT_ID: '' },
    {
      server_url: 'wss://from-config',
      server_token: 'tok-config',
      agent_id: 'agent-config',
    },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.server, 'wss://from-config');
  assert.equal(r.args.token, 'tok-config');
  assert.equal(r.args.agentId, 'agent-config');
});

test('CLI backend flag wins over env CLAUDE_CWD via backends merge', () => {
  // Issue #189 §1: --claude-cwd is now a first-class flag and beats the
  // env-var fallback CLAUDE_CWD. Config layer wins last.
  const r = mergeClientArgs(
    { token: 't', agentId: 'a', claudeCwd: '/from-flag' },
    { CLAUDE_CWD: '/from-env' },
    { backends: { claude: { cwd: '/from-config' } } },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.claudeCwd, '/from-flag');
});

test('env CLAUDE_CWD beats config when no flag is set', () => {
  const r = mergeClientArgs(
    { token: 't', agentId: 'a' },
    { CLAUDE_CWD: '/from-env' },
    { backends: { claude: { cwd: '/from-config' } } },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.claudeCwd, '/from-env');
});
