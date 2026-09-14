import { createExecutionAuthBroker, BrokerRejection } from './execution-auth-broker.js';
import { createPinnedClaudeOAuthReader } from './backends/claude-usage.js';
export type ClaudeProviderCredential = { kind: 'oauth' | 'api-key'; secret: string };
export type CredentialReader = () => ClaudeProviderCredential | Promise<ClaudeProviderCredential>;

// Pin the source at daemon startup. Reread it on every request, without
// falling back to a different credential type after expiry or removal.
export function createClaudeCredentialReader(env: NodeJS.ProcessEnv = process.env): CredentialReader {
  for (const key of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    if (env[key] && env[key] !== '0') throw new Error(`${key} is unsupported by Claude container authentication`);
  }
  if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL !== 'https://api.anthropic.com') {
    throw new Error('Claude container authentication requires the direct Anthropic API');
  }
  const sources = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].filter(k => env[k]);
  if (sources.length > 1) throw new Error('Set only one Claude host credential environment variable');
  if (env.ANTHROPIC_AUTH_TOKEN) throw new Error('Use ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN for Claude container authentication');
  const source = sources[0];
  const readOAuth = source ? undefined : createPinnedClaudeOAuthReader({ configDir: env.CLAUDE_CONFIG_DIR });
  return () => {
    if (source) {
      const secret = env[source];
      if (!secret || /\s/.test(secret)) throw new Error('Claude host credential is unavailable; restore it and restart the daemon');
      return { kind: source === 'ANTHROPIC_API_KEY' ? 'api-key' : 'oauth', secret };
    }
    const creds = readOAuth!();
    if (!creds || /\s/.test(creds.accessToken) || (creds.expiresAt !== undefined && creds.expiresAt <= Date.now() + 30_000)) {
      throw new Error('Claude host login is missing or expired; log in with Claude on the host and retry. The bridge does not refresh OAuth tokens.');
    }
    return { kind: 'oauth', secret: creds.accessToken };
  };
}

export function assertClaudeBrokerSettings(settings: Record<string, unknown> | undefined): void {
  if (!settings) return;
  if (['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'].some(k => k in settings)) {
    throw new Error('Claude container authentication helpers are unsupported; use host login or a host API key');
  }
  if (settings.env && typeof settings.env === 'object' && Object.keys(settings.env).some(k =>
    /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS$)/.test(k))) {
    throw new Error('Claude container provider environment must be configured on the host, not in agent settings');
  }
}

export interface BrokerOptions {
  credential: CredentialReader;
  authentication?: ClaudeProviderCredential['kind'];
  // Trusted test seam; production never supplies a destination.
  upstream?: string;
  ttlMs?: number;
  timeoutMs?: number;
  maxRequests?: number;
  maxConcurrent?: number;
  models?: readonly string[];
  onCredentialFailure?: () => void;
}

export function createClaudeAuthBroker(opts: BrokerOptions) {
  return createExecutionAuthBroker({
    ...opts, upstream: opts.upstream ?? 'https://api.anthropic.com', origins: ['https://api.anthropic.com'],
    allow: req => req.method === 'POST' && ['/v1/messages','/v1/messages?beta=true','/v1/messages/count_tokens','/v1/messages/count_tokens?beta=true'].includes(req.url ?? ''),
    async prepare(req, data) {
      if (!data || typeof data !== 'object' || typeof data.model !== 'string' ||
          !/^claude-(?:haiku|sonnet|opus)-[a-zA-Z0-9.-]+$/.test(data.model) ||
          (opts.models && !opts.models.includes(data.model)) ||
          (!req.url!.includes('count_tokens') && (!Number.isInteger(data.max_tokens) || data.max_tokens < 1 || data.max_tokens > 128_000))) {
        throw new BrokerRejection(403);
      }
      let credential: ClaudeProviderCredential;
      try { credential = await opts.credential(); } catch {
        opts.onCredentialFailure?.();
        throw new BrokerRejection(503);
      }
      if (!credential.secret || /\s/.test(credential.secret)) { throw new BrokerRejection(503); }
      const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
      headers[credential.kind === 'oauth' ? 'authorization' : 'x-api-key'] = credential.kind === 'oauth' ? `Bearer ${credential.secret}` : credential.secret;
      const beta = String(req.headers['anthropic-beta'] ?? '');
      if (!/^[a-zA-Z0-9,._-]*$/.test(beta)) { throw new BrokerRejection(400); }
      const betas = beta.split(',').filter(v => v && (credential.kind === 'oauth' || v !== 'oauth-2025-04-20'));
      if (credential.kind === 'oauth') betas.push('oauth-2025-04-20');
      if (betas.length) headers['anthropic-beta'] = [...new Set(betas)].join(',');
      for (const name of ['user-agent', 'x-app']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      return headers;
    },
  });
}
