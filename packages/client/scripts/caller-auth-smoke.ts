// Explicit opt-in: uses the host Claude.ai login for one real model request.
// Also run as a Bun-compiled executable. Never prints model output or credentials.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerCallerRuntimePool } from '../src/caller-runtime-docker.js';
import { scopeDigest } from '../src/caller-runtime-store.js';
import { runDockerCommand } from '../src/docker-command.js';

const image = process.env.VICOOP_SMOKE_IMAGE;
if (!image) throw new Error('Set VICOOP_SMOKE_IMAGE to a pinned image containing Claude');
const directory = await mkdtemp(join(tmpdir(), 'vicoop-caller-auth-'));
const pool = new DockerCallerRuntimePool({
  image, credentialSource: 'host-claude', stateDirectory: directory,
  agentId: 'auth-smoke', maxScopes: 1, taskTimeoutMs: 120_000,
});
try {
  await pool.initialize();
  const runtime = await pool.start(scopeDigest('auth-smoke', 'apikey:test'), new AbortController().signal);
  try {
    const child = runtime.spawn('node', ['-e', `
      const cp = require('child_process');
      if (!process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN) process.exit(2);
      const r = cp.spawnSync('claude', ['-p', 'Explain what the JavaScript expression 2 + 2 evaluates to in one sentence.', '--model', 'haiku', '--output-format', 'json', '--max-turns', '1', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--dangerously-skip-permissions'], {encoding:'utf8', timeout:90000, maxBuffer:1048576});
      let result; try { result = JSON.parse(r.stdout); } catch {}
      const ok = r.status === 0 && result?.subtype === 'success' && !result?.is_error && typeof result?.result === 'string' && result.result.length > 0 && result?.usage?.output_tokens > 0;
      console.log(JSON.stringify({success:ok, models:Object.keys(result?.modelUsage ?? {})}));
      process.exit(ok ? 0 : 1);
    `], { cwd: '/state/workspace' });
    let output = '';
    child.stdout!.on('data', chunk => { output += chunk; });
    child.stderr!.on('data', () => {});
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on('close', resolve);
      child.on('error', () => reject(new Error('Auth smoke process failed')));
    });
    child.stdin!.end();
    assert.equal(await exited, 0, 'Real Claude OAuth inference failed');
    assert.equal(JSON.parse(output).success, true);
    await runtime.finish(true);
  } catch (error) {
    await runtime.cancel();
    throw error;
  }
} finally {
  await pool.close();
  for (const args of [
    ['ps', '-aq', '--filter', `label=vicoop.caller-namespace=${pool.store.namespace}`],
    ['network', 'ls', '-q', '--filter', `label=vicoop.caller-namespace=${pool.store.namespace}`],
  ]) {
    const result = await runDockerCommand(args);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), '', 'Auth smoke leaked Docker resources');
  }
  await rm(directory, { recursive: true, force: true });
}
console.log('PASS: real Claude OAuth inference through DockerCallerRuntimePool, checkpoint and cleanup');
