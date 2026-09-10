import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CallerCredentialsOptions {
  credentialSource?: 'api-key-file' | 'host-claude';
  credentialFile?: string;
}

// Read-only and bounded: never invoke login/refresh or copy the refresh token.
async function readHostCredentials(): Promise<string> {
  if (process.env.CLAUDE_CONFIG_DIR)
    throw new Error('host-claude currently requires the default Claude config directory; unset CLAUDE_CONFIG_DIR');
  try {
    if (process.platform === 'darwin') {
      return await new Promise<string>((resolve, reject) => {
        execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
          { timeout: 10_000, maxBuffer: 65_536, encoding: 'utf8' },
          (error, stdout) => error ? reject(new Error('credential lookup failed')) : resolve(stdout));
      });
    }
    if (process.platform === 'linux') {
      const path = join(homedir(), '.claude', '.credentials.json');
      const info = await stat(path);
      if (!info.isFile() || info.size > 65_536 || info.mode & 0o077) throw new Error('invalid credential file');
      return await readFile(path, 'utf8');
    }
  } catch {
    // Child-process errors may contain credential output. Never propagate them.
    throw new Error('Cannot read host Claude login; sign in with Claude on this host and retry');
  }
  throw new Error('host-claude supports macOS and Linux only');
}

export async function callerCredentialEnvironment(
  options: CallerCredentialsOptions,
  readHost: () => Promise<string> = readHostCredentials,
  now = Date.now(),
): Promise<string> {
  if (options.credentialSource === 'host-claude') {
    if (options.credentialFile) throw new Error('host-claude cannot use credentialFile');
    let oauth: { accessToken?: unknown; expiresAt?: unknown } | undefined;
    try { oauth = JSON.parse(await readHost()).claudeAiOauth; }
    catch { throw new Error('Cannot read host Claude OAuth login; sign in with Claude on this host and retry'); }
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken || /\s|\0/.test(oauth.accessToken) || oauth.accessToken.length > 8192)
      throw new Error('Host Claude login has no valid OAuth access token');
    if (typeof oauth.expiresAt !== 'number' || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= now + 60_000)
      throw new Error('Host Claude OAuth token is expired or expires within one minute; refresh the host Claude login and retry');
    return `CLAUDE_CODE_OAUTH_TOKEN=${oauth.accessToken}`;
  }
  if (options.credentialSource !== undefined && options.credentialSource !== 'api-key-file')
    throw new Error('Unsupported caller credential source');
  if (!options.credentialFile) throw new Error('caller credentialFile is required for api-key-file');
  const info = await stat(options.credentialFile);
  if (!info.isFile() || info.size > 8192 || info.mode & 0o077)
    throw new Error('caller credential file must be a private regular file (chmod 600, at most 8 KiB)');
  const key = (await readFile(options.credentialFile, 'utf8')).trim();
  if (!key || /\s|\0/.test(key)) throw new Error('caller credential file must contain one Anthropic API key');
  return `ANTHROPIC_API_KEY=${key}`;
}
