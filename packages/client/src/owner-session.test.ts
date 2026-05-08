import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  atomicWriteFile,
  loadOwnerSession,
  resolveOwnerSession,
  saveOwnerSession,
  type OwnerSession,
} from './owner-session.js';

function makeSession(overrides: Partial<OwnerSession> = {}): OwnerSession {
  return {
    bridge: 'https://bridge.test',
    token: 'vbc_owner_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    principal_id: 'eth:0x1111111111111111111111111111111111111111',
    email: null,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    saved_at: new Date().toISOString(),
    ...overrides,
  };
}

test('saveOwnerSession + loadOwnerSession round-trip preserves fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-owner-'));
  try {
    const path = join(dir, 'owner-session.json');
    const session = makeSession();
    saveOwnerSession(session, path);
    const loaded = loadOwnerSession(path);
    assert.deepEqual(loaded, session);
    // chmod 600 best-effort; if the platform supports POSIX modes, verify.
    const mode = statSync(path).mode & 0o777;
    if (process.platform !== 'win32') {
      assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadOwnerSession returns null when file is missing', () => {
  const path = join(tmpdir(), `vicoop-owner-missing-${Date.now()}.json`);
  assert.equal(loadOwnerSession(path), null);
});

test('loadOwnerSession returns null on malformed JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-owner-bad-'));
  try {
    const path = join(dir, 'owner-session.json');
    writeFileSync(path, '{not json');
    assert.equal(loadOwnerSession(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadOwnerSession returns null when required field saved_at is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-owner-missing-'));
  try {
    const path = join(dir, 'owner-session.json');
    // OwnerSession requires saved_at; an older or hand-edited file without
    // it shouldn't slip through and violate the declared return type.
    writeFileSync(path, JSON.stringify({
      bridge: 'https://bridge.test',
      token: 'vbc_owner_xxx',
      expires_at: new Date(Date.now() + 1000).toISOString(),
    }));
    assert.equal(loadOwnerSession(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadOwnerSession returns null when fields have wrong types', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-owner-types-'));
  try {
    const path = join(dir, 'owner-session.json');
    // Tampered: `bridge` is a number, not a string. The truthiness check
    // would have let this through and resolveOwnerSession would have
    // crashed in `.replace()`.
    writeFileSync(path, JSON.stringify({
      bridge: 123,
      token: 'vbc_owner_xxx',
      expires_at: new Date(Date.now() + 1000).toISOString(),
      saved_at: new Date().toISOString(),
    }));
    assert.equal(loadOwnerSession(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomicWriteFile cleans up its temp file on rename failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-atomic-fail-'));
  try {
    // Force renameSync to fail by making the destination an existing
    // directory — POSIX rename(2) returns EISDIR / ENOTEMPTY in that case.
    const dest = join(dir, 'collide');
    mkdirSync(dest);
    assert.throws(() => atomicWriteFile(dest, 'irrelevant'));
    // No *.tmp file should remain in the parent dir.
    const stragglers = readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(stragglers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveOwnerSession can overwrite an existing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-owner-overwrite-'));
  try {
    const path = join(dir, 'owner-session.json');
    saveOwnerSession(makeSession({ token: 'vbc_owner_first' }), path);
    // Re-saving must succeed cross-platform — Windows' non-overwriting
    // rename was leaving the new token stranded in the temp file.
    saveOwnerSession(makeSession({ token: 'vbc_owner_second' }), path);
    const loaded = loadOwnerSession(path);
    assert.equal(loaded?.token, 'vbc_owner_second');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveOwnerSession prefers env over file when both present', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-owner-env-'));
  try {
    const path = join(dir, 'owner-session.json');
    saveOwnerSession(
      makeSession({ bridge: 'https://from-file.test', token: 'vbc_owner_filetokenxxxxxxxxxxxxxxxxxxx' }),
      path,
    );

    const prevToken = process.env.VICOOP_OWNER_TOKEN;
    const prevBridge = process.env.VICOOP_BRIDGE;
    process.env.VICOOP_OWNER_TOKEN = 'vbc_owner_envtokenxxxxxxxxxxxxxxxxxxxx';
    process.env.VICOOP_BRIDGE = 'https://from-env.test';
    t.after(() => {
      if (prevToken === undefined) delete process.env.VICOOP_OWNER_TOKEN;
      else process.env.VICOOP_OWNER_TOKEN = prevToken;
      if (prevBridge === undefined) delete process.env.VICOOP_BRIDGE;
      else process.env.VICOOP_BRIDGE = prevBridge;
    });

    const resolved = resolveOwnerSession(path);
    assert.deepEqual(resolved, {
      bridge: 'https://from-env.test',
      token: 'vbc_owner_envtokenxxxxxxxxxxxxxxxxxxxx',
      source: 'env',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveOwnerSession falls back to file when env unset', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-owner-file-'));
  try {
    const path = join(dir, 'owner-session.json');
    saveOwnerSession(makeSession({ bridge: 'https://file.test', token: 'vbc_owner_fromfile' }), path);

    const prevToken = process.env.VICOOP_OWNER_TOKEN;
    const prevBridge = process.env.VICOOP_BRIDGE;
    delete process.env.VICOOP_OWNER_TOKEN;
    delete process.env.VICOOP_BRIDGE;
    t.after(() => {
      if (prevToken !== undefined) process.env.VICOOP_OWNER_TOKEN = prevToken;
      if (prevBridge !== undefined) process.env.VICOOP_BRIDGE = prevBridge;
    });

    const resolved = resolveOwnerSession(path);
    assert.deepEqual(resolved, {
      bridge: 'https://file.test',
      token: 'vbc_owner_fromfile',
      source: 'file',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveOwnerSession ignores file when stored token is expired', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vicoop-owner-exp-'));
  try {
    const path = join(dir, 'owner-session.json');
    saveOwnerSession(
      makeSession({ expires_at: new Date(Date.now() - 1000).toISOString() }),
      path,
    );

    const prevToken = process.env.VICOOP_OWNER_TOKEN;
    const prevBridge = process.env.VICOOP_BRIDGE;
    delete process.env.VICOOP_OWNER_TOKEN;
    delete process.env.VICOOP_BRIDGE;
    t.after(() => {
      if (prevToken !== undefined) process.env.VICOOP_OWNER_TOKEN = prevToken;
      if (prevBridge !== undefined) process.env.VICOOP_BRIDGE = prevBridge;
    });

    assert.equal(resolveOwnerSession(path), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
