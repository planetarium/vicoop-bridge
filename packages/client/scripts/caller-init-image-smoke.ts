// Real Docker init probes: writable volume contract, failure atomicity and CLI administration.
// No provider/model calls; supply a compatible local immutable image.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCallerContainerInit } from '../src/caller-container-init.js';
import { runCallerState } from '../src/caller-runtime-admin.js';
import { runDockerCommand } from '../src/docker-command.js';
import { createLogger } from '../src/logger.js';
const image = process.env.VICOOP_SMOKE_IMAGE;
assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
const directory = await mkdtemp(join(tmpdir(), 'caller-init-image-'));
const configPath = join(directory, 'config.json');
const images: string[] = [];
const parentTag = `vicoop-init-smoke:${randomUUID()}`;
async function docker(args: string[]) {
  const result = await runDockerCommand(args, { timeoutMs: 120000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}
try {
  await writeFile(configPath, JSON.stringify({ agent_id: `smoke-${randomUUID()}`, server_token: 'fixture' }));
  for (const kind of ['claude', 'codex'] as const) {
    await runCallerContainerInit({ kind, configPath, image, validateCredentials: async () => {}, logger: createLogger('silent') });
    await runCallerState({ config: configPath, backend: kind, validate: true });
  }
  const original = await readFile(configPath, 'utf8');
  await docker(['tag', image!, parentTag]);
  const dockerfile = join(directory, 'Dockerfile');
  await writeFile(dockerfile, `FROM ${parentTag}\nUSER root\nARG BLOCKED_PATH\nARG REMOVE_PATH\nRUN if [ -n "$REMOVE_PATH" ]; then rm "$REMOVE_PATH"; else chown root:root "$BLOCKED_PATH" && chmod 755 "$BLOCKED_PATH"; fi\nLABEL vicoop.init-smoke="${randomUUID()}"\nUSER node\n`);
  for (const path of ['/workspace', '/data/sessions/claude/config', '/bin/sleep', '/usr/bin/du', '/usr/bin/awk']) {
    const iid = join(directory, 'image-id');
    await docker(['build', '--iidfile', iid, '--build-arg', `${path.includes('/bin/') ? 'REMOVE_PATH' : 'BLOCKED_PATH'}=${path}`, directory]);
    const invalid = (await readFile(iid, 'utf8')).trim();
    images.push(invalid);
    await assert.rejects(runCallerContainerInit({
      kind: 'claude', configPath, image: invalid,
      validateCredentials: async () => {}, logger: createLogger('silent'),
    }), path.includes('/bin/') ? /caller image is missing required/ : /caller image must provide writable/);
    assert.equal(await readFile(configPath, 'utf8'), original);
  }
  console.log('PASS both init backends, offline validation, rejected root-owned workspace/session volumes, missing runtime helper rejection, unchanged config on failure');
} finally {
  for (const id of images) await docker(['image', 'rm', id]);
  await runDockerCommand(['image', 'rm', parentTag]);
  await rm(directory, { recursive: true, force: true });
}
