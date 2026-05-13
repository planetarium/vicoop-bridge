import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeClientArgs, parseFlags } from './cli-args.js';
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

test('missing required args reported as a list', () => {
  const r = mergeClientArgs({}, {}, {});
  assert.equal(r.ok, false);
  if (r.ok) return;
  // backend defaults to 'echo' so it's never missing; only the three credentials are.
  assert.deepEqual(r.missing, ['server', 'token', 'agentId']);
});

test('parseFlags picks up known flags and ignores unrecognised ones', () => {
  const r = parseFlags([
    '--server', 'wss://x',
    '--token', 't',
    '--agentId', 'a',
    '--backend', 'claude',
    '--card', '/c.json',
    '--config', '/etc/vicoop/config.json',
    '--unknown', 'value',
  ]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.flags, {
    server: 'wss://x',
    token: 't',
    agentId: 'a',
    backend: 'claude',
    card: '/c.json',
    config: '/etc/vicoop/config.json',
  });
});

test('parseFlags fails when a known flag is missing its value', () => {
  // Trailing --config with no token after it should not silently set
  // config = undefined; report the missing value so the operator notices.
  const trailing = parseFlags(['--server', 'wss://x', '--config']);
  assert.equal(trailing.ok, false);
  if (trailing.ok) return;
  assert.match(trailing.error, /--config requires a value/);

  // --config followed by another --flag means the operator forgot the path
  // and the next flag would otherwise be consumed as the value. Reject.
  const consumed = parseFlags(['--config', '--server', 'wss://x']);
  assert.equal(consumed.ok, false);
  if (consumed.ok) return;
  assert.match(consumed.error, /--config requires a value/);
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
