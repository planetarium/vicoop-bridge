import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BRIDGE_URL, mergeClientArgs, parseFlags } from './cli-args.js';
import type { ClientConfig } from './config.js';

// mergeClientArgs is the pure precedence layer: CLI flags > config (env
// is no longer part of the chain — issue #189 §5). The IO-heavy loader
// (parseClientArgs) resolves the config file path on disk and is covered
// indirectly by setup.test.ts + config.test.ts.

const CONFIG: ClientConfig = {
  server_url: 'wss://from-config',
  server_token: 'tok-config',
  agent_id: 'agent-config',
  backend: 'codex',
  card: '/cfg/card.json',
  backends: { codex: { sandbox_mode: 'read-only' } },
};

test('CLI flags beat config', () => {
  const r = mergeClientArgs(
    {
      server: 'wss://from-flag',
      token: 'tok-flag',
      agentId: 'agent-flag',
      backend: 'claude',
    },
    CONFIG,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.server, 'wss://from-flag');
  assert.equal(r.args.token, 'tok-flag');
  assert.equal(r.args.agentId, 'agent-flag');
  assert.equal(r.args.backend, 'claude');
  // backends.* always comes from config (no flag has a place to put it).
  assert.deepEqual(r.args.backends, CONFIG.backends);
});

test('config fills in fields absent from CLI flags', () => {
  const r = mergeClientArgs({}, CONFIG);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.server, CONFIG.server_url);
  assert.equal(r.args.token, CONFIG.server_token);
  assert.equal(r.args.agentId, CONFIG.agent_id);
  assert.equal(r.args.backend, CONFIG.backend);
  assert.equal(r.args.card, CONFIG.card);
});

test('default backend is echo when neither flag nor config sets it', () => {
  const r = mergeClientArgs(
    { server: 'wss://x', token: 't', agentId: 'a' },
    {},
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.backend, 'echo');
});

test('server falls back to DEFAULT_BRIDGE_URL when no flag/config sets it', () => {
  // Issue #189 §6: the public bridge URL is baked in so a fresh install
  // needs zero flags. `server` is therefore never in the missing list.
  const r = mergeClientArgs({ token: 't', agentId: 'a' }, {});
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.server, DEFAULT_BRIDGE_URL);
});

test('missing required args reported as a list', () => {
  const r = mergeClientArgs({}, {});
  assert.equal(r.ok, false);
  if (r.ok) return;
  // backend defaults to 'echo' and server defaults to DEFAULT_BRIDGE_URL,
  // so only the two credential fields can be missing.
  assert.deepEqual(r.missing, ['token', 'agentId']);
  assert.deepEqual(r.errors, []);
});

test('--runtime with a non-runtime-capable backend is a hard error', () => {
  // echo (and openclaw / vicoop-codex) don't have a runtime container
  // profile; passing --runtime with one of them is almost always an
  // operator typo, so surface it instead of silently ignoring.
  const r = mergeClientArgs(
    { token: 't', agentId: 'a', backend: 'echo', runtime: 'container' },
    {},
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(
    r.errors.some((e) => e.includes('--runtime') && e.includes('echo')),
    `expected error mentioning --runtime and echo, got: ${r.errors.join(' | ')}`,
  );
});

test('--cwd with a non-process-spawning backend is a hard error', () => {
  // openclaw routes tasks over a gateway WS; there's no host-side child
  // process to give a working directory to.
  const r = mergeClientArgs(
    { token: 't', agentId: 'a', backend: 'openclaw', cwd: '/some/dir' },
    {},
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(
    r.errors.some((e) => e.includes('--cwd') && e.includes('openclaw')),
    `expected error mentioning --cwd and openclaw, got: ${r.errors.join(' | ')}`,
  );
});

test('--runtime + --cwd with --backend claude is accepted', () => {
  // Positive control: the supported pairing must still parse cleanly.
  const r = mergeClientArgs(
    { token: 't', agentId: 'a', backend: 'claude', runtime: 'container', cwd: '/repo' },
    {},
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.runtime, 'container');
  assert.equal(r.args.cwd, '/repo');
});

test('--runtime-name is accepted for container-capable backends', () => {
  const r = mergeClientArgs(
    {
      token: 't',
      agentId: 'a',
      backend: 'codex',
      runtime: 'container',
      runtimeName: 'work',
    },
    {},
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.runtimeName, 'work');
});

test('--runtime-name with a non-runtime-capable backend is a hard error', () => {
  const r = mergeClientArgs(
    { token: 't', agentId: 'a', backend: 'echo', runtimeName: 'work' },
    {},
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(
    r.errors.some((e) => e.includes('--runtime-name') && e.includes('echo')),
    `expected error mentioning --runtime-name and echo, got: ${r.errors.join(' | ')}`,
  );
});

test('parseFlags picks up known flags', () => {
  const r = parseFlags([
    '--server', 'wss://x',
    '--token', 't',
    '--agentId', 'a',
    '--backend', 'claude',
    '--card', '/c.json',
    '--config', '/etc/vicoop/config.json',
    '--runtime-name', 'work',
  ]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.flags.server, 'wss://x');
  assert.equal(r.flags.token, 't');
  assert.equal(r.flags.runtimeName, 'work');
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
    '--cwd', '/workspaces/repo',
    '--codex-sandbox', 'workspace-write',
    '--openclaw-gateway', 'ws://gw:18789',
    '--openclaw-task-timeout-ms', '60000',
  ]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.flags.cwd, '/workspaces/repo');
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

test('mergeClientArgs trims and treats whitespace-only flag values as unset', () => {
  // Space-padded values from CLI should normalize to clean strings, and a
  // whitespace-only value should fall through to the next layer — matching
  // the same trim+drop semantics normalizeConfig applies to the config
  // layer.
  const r = mergeClientArgs(
    { server: '  wss://flag-padded  ', card: '   ' },
    { agent_id: 'agent-from-config', server_token: 't', backend: 'claude' },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.server, 'wss://flag-padded');
  assert.equal(r.args.token, 't');
  assert.equal(r.args.agentId, 'agent-from-config');
  // card was whitespace-only on flag, and config has none → resolves to
  // undefined (not empty string).
  assert.equal(r.args.card, undefined);
});

test('--cwd flag overrides the active backend\'s config cwd', () => {
  // Issue #189 §1: --cwd is a first-class flag. Config layer wins last.
  // After the per-backend → unified flag refactor the merge step scopes
  // the config fallback to whichever `--backend` is active.
  const r = mergeClientArgs(
    { token: 't', agentId: 'a', backend: 'claude', cwd: '/from-flag' },
    { backends: { claude: { cwd: '/from-config' } } },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.cwd, '/from-flag');
});

test('config backends.<active>.cwd is the only fallback (no env)', () => {
  // Issue #189 §5: env is out of the chain entirely. Setting CLAUDE_CWD
  // in process.env has no effect here.
  const previous = process.env.CLAUDE_CWD;
  process.env.CLAUDE_CWD = '/from-env';
  try {
    const r = mergeClientArgs(
      { token: 't', agentId: 'a', backend: 'claude' },
      { backends: { claude: { cwd: '/from-config' } } },
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.args.cwd, '/from-config');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CWD;
    else process.env.CLAUDE_CWD = previous;
  }
});

test('config backends.codex.cwd resolves when --backend codex is active', () => {
  // Mirror of the claude case: the unified flag resolution must pick the
  // correct per-backend config key based on the active backend selection.
  const r = mergeClientArgs(
    { token: 't', agentId: 'a', backend: 'codex' },
    { backends: { codex: { cwd: '/codex-from-config' }, claude: { cwd: '/claude-from-config' } } },
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.cwd, '/codex-from-config');
});

test('env vars in the daemon-config chain are ignored entirely (issue #189 §5)', () => {
  // The old chain consulted SERVER_URL / SERVER_TOKEN / AGENT_ID / BACKEND
  // / AGENT_CARD between flag and config. With env removed, these vars
  // must have no effect on the resolved daemon args.
  const env = {
    SERVER_URL: 'wss://from-env',
    SERVER_TOKEN: 'tok-env',
    AGENT_ID: 'agent-env',
    BACKEND: 'claude',
    AGENT_CARD: '/env/card.json',
  };
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const r = mergeClientArgs({}, CONFIG);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // Every field should reflect CONFIG, never the env value.
    assert.equal(r.args.server, CONFIG.server_url);
    assert.equal(r.args.token, CONFIG.server_token);
    assert.equal(r.args.agentId, CONFIG.agent_id);
    assert.equal(r.args.backend, CONFIG.backend);
    assert.equal(r.args.card, CONFIG.card);
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
