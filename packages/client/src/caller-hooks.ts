import { z } from 'zod';
import semver from 'semver';
import { runDockerCommand, type AsyncDockerRun } from './docker-command.js';

// This is a container path, never a host command or a shell expression.
export const CallerPreToolUseHooks = z.array(z.object({
  command: z.string().max(512).regex(/^\/(?:opt\/vicoop\/hooks|shared\/[a-zA-Z0-9_-]+)\/[a-zA-Z0-9_./-]+$/)
    .refine(path => !path.slice(1).split('/').some(part => part === '.' || part === '..' || part === ''),
      'hook command must be a normalized absolute executable path'),
  matcher: z.string().min(1).max(256).default('*').refine(value => {
    try { if (value !== '*') new RegExp(value); return !/[\x00-\x1f\x7f]/.test(value); } catch { return false; }
  }, 'hook matcher must be a valid Claude tool-name regex or *'),
  timeoutSeconds: z.number().int().min(1).max(30).default(5),
}).strict()).min(1).max(8);

export type CallerHooks = z.infer<typeof CallerPreToolUseHooks>;
export interface CallerHookContext { taskId: string; requestId: string }

export function assertCallerHookVersion(version: string, hooks?: CallerHooks): void {
  if (hooks && !semver.satisfies(version, '>=2.1.295'))
    throw new Error('caller preToolUseHooks require Claude Code >=2.1.295 for fail-closed hooks');
}

export function callerHookSettings(hooks?: CallerHooks): Record<string, unknown> {
  return hooks ? {
    disableAllHooks: false,
    hooks: { PreToolUse: hooks.map(hook => ({
      matcher: hook.matcher,
      hooks: [{ type: 'command', command: hook.command, args: [], timeout: hook.timeoutSeconds, onFailure: 'block' }],
    })) },
  } : {};
}

// No caller code is executed during validation. Check each component, including
// nested mount points: a read-only ancestor is insufficient for a writable child.
export const CHECK_CALLER_HOOK_PATHS = String.raw`
const fs = require('node:fs');
const decode = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(line => {
  const fields = line.split(' '); return { path: decode(fields[4]), ro: fields[5].split(',').includes('ro') };
});
try {
  for (const command of JSON.parse(process.argv[1])) {
    let path = '';
    for (const part of command.split('/').filter(Boolean)) {
      path += '/' + part;
      const stat = fs.lstatSync(path);
      if (stat.isSymbolicLink()) throw Error('symlink');
      const mount = mounts.filter(m => m.path === '/' || path === m.path || path.startsWith(m.path + '/'))
        .sort((a,b) => b.path.length - a.path.length)[0];
      if (!mount || !mount.ro) throw Error('writable mount');
    }
    if (!fs.statSync(command).isFile()) throw Error('not a regular file');
    fs.accessSync(command, fs.constants.R_OK | fs.constants.X_OK);
  }
} catch { process.exit(1); }
`;

export async function validateCallerHookPaths(container: string, hooks: CallerHooks, signal: AbortSignal,
  run: AsyncDockerRun = runDockerCommand): Promise<void> {
  const result = await run(['exec', '--user', '1000:1000', container, '/usr/local/bin/node', '-e',
    CHECK_CALLER_HOOK_PATHS, JSON.stringify(hooks.map(hook => hook.command))], { signal, timeoutMs: 5000, maxOutputBytes: 4096 });
  if (result.exitCode !== 0)
    throw new Error('caller hook commands must be readable executable regular files on read-only mounts, without symlinks');
}
