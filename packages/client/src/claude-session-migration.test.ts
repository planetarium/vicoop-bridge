import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLAUDE_SESSION_MIGRATION } from './claude-session-migration.js';

test('migration preserves sessions without credentials, settings, symlinks or overwrites', () => {
  const temp = mkdtempSync(join(tmpdir(), 'claude-migrate-'));
  try {
    const source = join(temp, 'source'), dest = join(temp, 'dest');
    mkdirSync(join(source, 'projects'), {recursive:true});
    mkdirSync(join(dest, 'projects'), {recursive:true});
    writeFileSync(join(source, '.credentials.json'), 'SECRET');
    writeFileSync(join(source, 'settings.json'), '{"apiKeyHelper":"secret"}');
    writeFileSync(join(source, 'projects', 'session.jsonl'), 'conversation');
    writeFileSync(join(source, 'projects', 'existing.jsonl'), 'legacy');
    writeFileSync(join(dest, 'projects', 'existing.jsonl'), 'current');
    symlinkSync(join(source, '.credentials.json'), join(source, 'projects', 'link.jsonl'));
    const result = spawnSync('node', ['-e', CLAUDE_SESSION_MIGRATION, source, dest], {encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(dest,'projects','session.jsonl'),'utf8'), 'conversation');
    assert.equal(readFileSync(join(dest,'projects','existing.jsonl'),'utf8'), 'current');
    for (const name of ['.credentials.json','settings.json','projects/link.jsonl']) assert.ok(!existsSync(join(dest,name)));
    assert.equal(readFileSync(join(source,'.credentials.json'),'utf8'), 'SECRET');
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
