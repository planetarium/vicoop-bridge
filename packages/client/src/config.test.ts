import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  defaultConfigPath,
  defaultOwnerSessionPath,
  overlayConfig,
  readConfig,
  resolveConfigDir,
  writeConfig,
} from './config.js';

// Each test owns its own tmp dir + scopes env vars so they don't leak into
// later tests in the same process (node:test runs them serially but the
// VICOOP_HOME/XDG_CONFIG_HOME state otherwise persists across tests).
function withEnv(
  t: { after: (fn: () => void) => void },
  overrides: Record<string, string | undefined>,
): void {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('resolveConfigDir honors $VICOOP_HOME above all', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-cfg-explicit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  withEnv(t, {
    VICOOP_HOME: dir,
    XDG_CONFIG_HOME: '/tmp/should-be-ignored',
  });
  assert.equal(resolveConfigDir(), dir);
});

test('resolveConfigDir prefers existing ~/.vicoop over XDG_CONFIG_HOME', (t) => {
  // Simulate an existing install: HOME points at a tmp dir that already has
  // a `.vicoop` subdirectory (from a prior `login` write). With XDG_CONFIG_HOME
  // also set, the resolver must still pick ~/.vicoop so the old owner-session
  // file isn't orphaned when an operator sets XDG for unrelated reasons.
  const home = mkdtempSync(join(tmpdir(), 'vicoop-cfg-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const legacy = join(home, '.vicoop');
  // Pre-create the legacy dir to simulate a prior `login` write — the
  // resolver's existsSync(~/.vicoop) probe short-circuits the XDG branch.
  mkdirSync(legacy);

  withEnv(t, {
    HOME: home,
    USERPROFILE: home,
    VICOOP_HOME: undefined,
    XDG_CONFIG_HOME: '/tmp/should-not-win',
  });
  assert.equal(resolveConfigDir(), legacy);
});

test('resolveConfigDir uses $XDG_CONFIG_HOME/vicoop for fresh installs', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'vicoop-cfg-fresh-'));
  const xdg = mkdtempSync(join(tmpdir(), 'vicoop-cfg-xdg-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.after(() => rmSync(xdg, { recursive: true, force: true }));
  // home has no .vicoop subdir => fresh install path
  withEnv(t, {
    HOME: home,
    USERPROFILE: home,
    VICOOP_HOME: undefined,
    XDG_CONFIG_HOME: xdg,
  });
  assert.equal(resolveConfigDir(), join(xdg, 'vicoop'));
});

test('resolveConfigDir falls back to ~/.vicoop when no envs set', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'vicoop-cfg-default-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  withEnv(t, {
    HOME: home,
    USERPROFILE: home,
    VICOOP_HOME: undefined,
    XDG_CONFIG_HOME: undefined,
  });
  assert.equal(resolveConfigDir(), join(home, '.vicoop'));
});

test('defaultConfigPath and defaultOwnerSessionPath colocate under resolveConfigDir', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-cfg-colocate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  withEnv(t, { VICOOP_HOME: dir });
  assert.equal(defaultConfigPath(), join(dir, 'config.json'));
  assert.equal(defaultOwnerSessionPath(), join(dir, 'owner-session.json'));
});

test('writeConfig writes JSON at mode 0600 and readConfig round-trips', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-cfg-rw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  writeConfig(path, {
    server_url: 'wss://bridge.test',
    server_token: 'tok',
    agent_id: 'a1',
    backend: 'claude',
    card: '/path/card.json',
    backends: {
      claude: { cwd: '/srv/work', settings: { sandbox: { enabled: true } } },
      codex: { cwd: '/srv/work', sandbox_mode: 'workspace-write' },
      openclaw: {
        gateway_url: 'ws://127.0.0.1:18789',
        gateway_token: 'gt',
        agent: 'main',
        task_timeout_ms: 60000,
      },
    },
  });
  const loaded = readConfig(path);
  assert.deepEqual(loaded, {
    server_url: 'wss://bridge.test',
    server_token: 'tok',
    agent_id: 'a1',
    backend: 'claude',
    card: '/path/card.json',
    backends: {
      claude: { cwd: '/srv/work', settings: { sandbox: { enabled: true } } },
      codex: { cwd: '/srv/work', sandbox_mode: 'workspace-write' },
      openclaw: {
        gateway_url: 'ws://127.0.0.1:18789',
        gateway_token: 'gt',
        agent: 'main',
        task_timeout_ms: 60000,
      },
    },
  });
  if (process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
  }
});

test('readConfig returns null when file does not exist', () => {
  const path = join(tmpdir(), `vicoop-cfg-missing-${Date.now()}.json`);
  assert.equal(readConfig(path), null);
});

test('readConfig drops malformed fields and keeps the rest', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-cfg-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      server_url: 'wss://bridge.test',
      server_token: 123, // wrong type — dropped
      agent_id: '', // empty — dropped
      backend: 'claude',
      backends: {
        openclaw: {
          task_timeout_ms: 'not-a-number', // wrong type — dropped
          gateway_url: 'ws://x',
        },
        // unknown backend keys are ignored — only claude/codex/openclaw recognized
        random: { foo: 'bar' },
      },
      // unknown top-level keys ignored
      extra_field: 'unused',
    }),
  );
  const loaded = readConfig(path);
  assert.deepEqual(loaded, {
    server_url: 'wss://bridge.test',
    backend: 'claude',
    backends: { openclaw: { gateway_url: 'ws://x' } },
  });
});

test('readConfig returns null on completely malformed JSON', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-cfg-json-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  writeFileSync(path, '{not json');
  assert.equal(readConfig(path), null);
});

test('readConfig returns null when JSON root is not an object', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-cfg-array-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(['not', 'an', 'object']));
  assert.equal(readConfig(path), null);
});

test('overlayConfig: top fields win per key, missing keys fall through from base', () => {
  // Used by cli.ts to layer `--config <path>` on top of the canonical
  // config so an explicit config file with only `server_token` doesn't
  // wipe `backends.claude.settings` from the canonical file.
  const base = {
    server_url: 'wss://canonical',
    server_token: 'canonical-tok',
    agent_id: 'canonical-agent',
    backend: 'claude',
    card: '/canonical/card.json',
    backends: { claude: { settings: { sandbox: { enabled: true } } } },
  };
  const top = {
    server_token: 'explicit-tok',
    agent_id: 'explicit-agent',
  };
  assert.deepEqual(overlayConfig(base, top), {
    server_url: 'wss://canonical',
    server_token: 'explicit-tok',
    agent_id: 'explicit-agent',
    backend: 'claude',
    card: '/canonical/card.json',
    backends: { claude: { settings: { sandbox: { enabled: true } } } },
  });
});

test('overlayConfig: empty top leaves base values intact; empty base passes top through', () => {
  // The result object always carries the six known keys; missing inputs land
  // as `undefined` rather than absent properties. mergeClientArgs's `||`
  // chain treats both shapes identically, so this is just shape — assert the
  // values rather than the key set.
  const base = { server_url: 'wss://b', backends: { codex: { sandbox_mode: 'read-only' } } };
  const allFromBase = overlayConfig(base, {});
  assert.equal(allFromBase.server_url, 'wss://b');
  assert.deepEqual(allFromBase.backends, base.backends);
  assert.equal(allFromBase.server_token, undefined);

  const top = { server_token: 'tok' };
  const allFromTop = overlayConfig({}, top);
  assert.equal(allFromTop.server_token, 'tok');
  assert.equal(allFromTop.server_url, undefined);
});

// Confirm the default-args call (no explicit path) wires through VICOOP_HOME.
test('readConfig/writeConfig default to resolveConfigDir() when no path passed', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-cfg-defaults-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  withEnv(t, { VICOOP_HOME: dir });
  writeConfig(defaultConfigPath(), { server_url: 'wss://bridge.test' });
  const loaded = readConfig();
  assert.deepEqual(loaded, { server_url: 'wss://bridge.test' });
  // Side check: file lives under VICOOP_HOME, not under homedir().
  assert.notEqual(defaultConfigPath(), join(homedir(), '.vicoop', 'config.json'));
});
