import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callerCredentialEnvironment } from './caller-runtime-credentials.js';
import { CallerRuntimeConfig } from './caller-runtime-config.js';

const now = 1_000_000;
const login = (accessToken: unknown = 'access-only', expiresAt: unknown = now + 120_000) =>
  JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, refreshToken: 'never-forward-me' } });

test('host credentials forward only access token and reread on each execution', async () => {
  let calls = 0;
  const read = async () => login(`rotated-${++calls}`);
  const options = { credentialSource: 'host-claude' as const };
  assert.equal(await callerCredentialEnvironment(options, read, now), 'CLAUDE_CODE_OAUTH_TOKEN=rotated-1');
  assert.equal(await callerCredentialEnvironment(options, read, now), 'CLAUDE_CODE_OAUTH_TOKEN=rotated-2');
});

test('host credentials reject unavailable, malformed, missing and expiring credentials without leaking secrets', async () => {
  const readers = [
    async () => { throw new Error('never-forward-me'); },
    async () => 'never-forward-me',
    async () => 'null',
    async () => '{}',
    async () => login('', now + 120_000),
    async () => login('secret\ninjection'),
    async () => login('a'.repeat(8193)),
    async () => login('access', now),
    async () => login('access', now + 60_000),
    async () => login('access', 'future'),
  ];
  for (const read of readers) {
    await assert.rejects(callerCredentialEnvironment({ credentialSource: 'host-claude' }, read, now),
      (error: Error) => !error.message.includes('never-forward-me') && !error.message.includes('injection'));
  }
});

test('legacy API key mode remains default, rereads rotation, and rejects public files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'caller-auth-test-'));
  const file = join(dir, 'key');
  try {
    await writeFile(file, 'first-key\n', { mode: 0o600 });
    assert.equal(await callerCredentialEnvironment({ credentialFile: file }), 'ANTHROPIC_API_KEY=first-key');
    await writeFile(file, 'second-key');
    assert.equal(await callerCredentialEnvironment({ credentialFile: file }), 'ANTHROPIC_API_KEY=second-key');
    await chmod(file, 0o644);
    await assert.rejects(callerCredentialEnvironment({ credentialFile: file }), /private regular file/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('configuration requires an explicit unambiguous credential source', () => {
  const base = { image: `sha256:${'a'.repeat(64)}`, stateDirectory: '/state' };
  assert.equal(CallerRuntimeConfig.parse({ ...base, credentialFile: '/key' }).credentialSource, 'api-key-file');
  assert.equal(CallerRuntimeConfig.parse({ ...base, credentialSource: 'host-claude' }).credentialSource, 'host-claude');
  for (const config of [base, { ...base, credentialSource: 'unknown' },
    { ...base, credentialSource: 'host-claude', credentialFile: '/key' }])
    assert.equal(CallerRuntimeConfig.safeParse(config).success, false);
});
