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

test('resolveConfigDir warns + falls through when $VICOOP_HOME points at a regular file', (t) => {
  // VICOOP_HOME being a regular file would make the daemon later crash
  // mkdirSync / atomicWriteFile with ENOTDIR. Warn loudly and pick the
  // next candidate (legacy ~/.vicoop fallback in this test) so the
  // daemon still has a usable place to write.
  const home = mkdtempSync(join(tmpdir(), 'vicoop-cfg-vicoophome-file-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const strayFile = join(home, 'not-a-dir');
  writeFileSync(strayFile, 'stray');

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = origWarn;
  });

  withEnv(t, {
    HOME: home,
    USERPROFILE: home,
    VICOOP_HOME: strayFile,
    XDG_CONFIG_HOME: undefined,
  });
  // Falls through to default ~/.vicoop under HOME (which doesn't exist
  // as a dir yet, so resolver returns the path; mkdirSync would create
  // it on first write).
  assert.equal(resolveConfigDir(), join(home, '.vicoop'));
  assert.ok(
    warnings.some((w) => w.includes('$VICOOP_HOME') && w.includes('not a directory')),
    `expected warning about VICOOP_HOME, got: ${JSON.stringify(warnings)}`,
  );
});

test('resolveConfigDir skips the legacy ~/.vicoop branch when the path is a regular file', (t) => {
  // existsSync would otherwise say "yes" for a stray file at ~/.vicoop
  // (e.g. someone curl'd a download there) and later mkdirSync would crash
  // with ENOTDIR. Require it to actually be a directory before adopting it.
  const home = mkdtempSync(join(tmpdir(), 'vicoop-cfg-stray-file-'));
  const xdg = mkdtempSync(join(tmpdir(), 'vicoop-cfg-stray-xdg-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.after(() => rmSync(xdg, { recursive: true, force: true }));
  writeFileSync(join(home, '.vicoop'), 'stray file at ~/.vicoop');
  withEnv(t, {
    HOME: home,
    USERPROFILE: home,
    VICOOP_HOME: undefined,
    XDG_CONFIG_HOME: xdg,
  });
  // Legacy path is a file, so the resolver must fall through to XDG.
  assert.equal(resolveConfigDir(), join(xdg, 'vicoop'));
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
    trusted_identity_issuers: ['did:web:issuer.example'],
    backends: {
      claude: {
        cwd: '/srv/work',
        settings: { sandbox: { enabled: true } },
        model: 'claude-opus-4-8',
        supported_models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
      },
      codex: { cwd: '/srv/work', sandbox_mode: 'workspace-write', runtime_name: 'work' },
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
    trusted_identity_issuers: ['did:web:issuer.example'],
    backends: {
      claude: {
        cwd: '/srv/work',
        settings: { sandbox: { enabled: true } },
        model: 'claude-opus-4-8',
        supported_models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
      },
      codex: { cwd: '/srv/work', sandbox_mode: 'workspace-write', runtime_name: 'work' },
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

test('overlayConfig merges backends per slot so a partial top does not wipe other backends', () => {
  // The common --config use case: operator points --config at a file that
  // only sets `backends.codex` (or a server token override). The canonical
  // file's `backends.claude` and `backends.openclaw` must still apply.
  const base = {
    backends: {
      claude: { cwd: '/srv/work' },
      openclaw: { gateway_url: 'ws://127.0.0.1:18789' },
    },
  };
  const top = {
    backends: {
      codex: { sandbox_mode: 'workspace-write' as const },
    },
  };
  const merged = overlayConfig(base, top);
  assert.deepEqual(merged.backends, {
    claude: { cwd: '/srv/work' },
    openclaw: { gateway_url: 'ws://127.0.0.1:18789' },
    codex: { sandbox_mode: 'workspace-write' },
  });
});

test('overlayConfig: when both sides set the same backend slot, top wins entirely', () => {
  // Within a single backend slot the override remains all-or-nothing — supplying
  // any value replaces the default — matching how createClaudeBackend etc.
  // already treat their `settings` / `cwd` opts. So a top.backends.claude with
  // only `cwd` discards canonical `settings` from base.backends.claude.
  const base = {
    backends: {
      claude: { cwd: '/canon/work', settings: { sandbox: { enabled: true } } },
    },
  };
  const top = {
    backends: {
      claude: { cwd: '/override/work' },
    },
  };
  const merged = overlayConfig(base, top);
  assert.deepEqual(merged.backends, {
    claude: { cwd: '/override/work' },
  });
});

test('normalizeConfig trims string fields and drops whitespace-only', (t) => {
  // Hand-edited config files often have stray whitespace around values; if
  // that bled through verbatim into env vars / URLs / argv it would surface
  // as a confusing connection failure. Normalize trims so config.json
  // behaves like the env / CLI layers, both of which already call .trim().
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-cfg-trim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      server_url: '  wss://bridge.test  ',
      server_token: '\t fresh-token \n',
      backend: 'claude\n',
      agent_id: '   ', // whitespace-only — dropped
      backends: { openclaw: { agent: ' main ' } },
    }),
  );
  assert.deepEqual(readConfig(path), {
    server_url: 'wss://bridge.test',
    server_token: 'fresh-token',
    backend: 'claude',
    backends: { openclaw: { agent: 'main' } },
  });
});

test('normalizeConfig drops unknown backend and unknown codex.sandbox_mode', (t) => {
  // Permissive normalize must also catch enum typos — otherwise a hand-edited
  // `"backend": "claud"` or `"sandbox_mode": "workspace_write"` would survive
  // the read and then exit the daemon at startup via the downstream parser.
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-cfg-enum-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      server_url: 'wss://bridge.test',
      backend: 'claud', // typo — dropped
      backends: {
        codex: {
          cwd: '/work',
          sandbox_mode: 'workspace_write', // underscore vs hyphen — dropped
        },
      },
    }),
  );
  assert.deepEqual(readConfig(path), {
    server_url: 'wss://bridge.test',
    backends: {
      codex: { cwd: '/work' },
    },
  });
});

test('normalizeConfig accepts backends.codex with sandbox_mode and approval_decision', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-cfg-codex-approval-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      server_url: 'wss://b',
      backend: 'codex',
      backends: {
        codex: {
          cwd: '/srv',
          sandbox_mode: 'workspace-write',
          approval_decision: 'acceptForSession',
          runtime_name: 'work',
        },
      },
    }),
  );
  assert.deepEqual(readConfig(path), {
    server_url: 'wss://b',
    backend: 'codex',
    backends: {
      codex: {
        cwd: '/srv',
        sandbox_mode: 'workspace-write',
        approval_decision: 'acceptForSession',
        runtime_name: 'work',
      },
    },
  });
});

test('normalizeConfig drops invalid codex approval_decision', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-cfg-codex-approval-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      backends: {
        codex: {
          cwd: '/work',
          approval_decision: 'yes', // not in enum — dropped
        },
      },
    }),
  );
  assert.deepEqual(readConfig(path), {
    backends: {
      codex: { cwd: '/work' },
    },
  });
});

test('normalizeConfig keeps telemetry on/off and drops anything else', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-cfg-telemetry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const onPath = join(dir, 'on.json');
  writeFileSync(onPath, JSON.stringify({ telemetry: 'on' }));
  assert.deepEqual(readConfig(onPath), { telemetry: 'on' });

  const offPath = join(dir, 'off.json');
  writeFileSync(offPath, JSON.stringify({ telemetry: 'off' }));
  assert.deepEqual(readConfig(offPath), { telemetry: 'off' });

  // A garbage / typo'd / wrong-type value is dropped — and a dropped value
  // reads as "off" downstream, so a malformed field can never enable reporting.
  for (const bad of ['true', 'ON', 'enabled', 'yes', '1']) {
    const p = join(dir, `bad-${bad}.json`);
    writeFileSync(p, JSON.stringify({ telemetry: bad }));
    assert.deepEqual(readConfig(p), {}, `telemetry=${bad} should be dropped`);
  }
  const boolPath = join(dir, 'bool.json');
  writeFileSync(boolPath, JSON.stringify({ telemetry: true }));
  assert.deepEqual(readConfig(boolPath), {});
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

test('normalizeConfig keeps usable backends.claude.supported_models entries and drops the rest', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-cfg-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      backends: {
        claude: {
          // non-string / empty entries dropped, strings trimmed
          supported_models: [' claude-sonnet-4-6 ', 42, '', null, 'claude-haiku-4-5'],
        },
        codex: {
          cwd: '/srv/work',
        },
      },
    }),
  );
  assert.deepEqual(readConfig(path), {
    backends: {
      claude: { supported_models: ['claude-sonnet-4-6', 'claude-haiku-4-5'] },
      codex: { cwd: '/srv/work' },
    },
  });

  // A models value of the wrong type (or with no usable entry) drops the
  // field — and with it the whole claude slot when nothing else is set.
  writeFileSync(
    path,
    JSON.stringify({ backends: { claude: { supported_models: 'claude-haiku-4-5' } } }),
  );
  assert.deepEqual(readConfig(path), {});
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
    trusted_identity_issuers: ['did:web:canonical.example'],
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
    trusted_identity_issuers: ['did:web:canonical.example'],
    // Neither side set telemetry, so it falls through as undefined — the
    // fixed-shape overlay always carries the key (see the next test).
    telemetry: undefined,
    backends: { claude: { settings: { sandbox: { enabled: true } } } },
  });
});

test('overlayConfig: empty top leaves base values intact; empty base passes top through', () => {
  // The result object always carries the known keys; missing inputs land
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
