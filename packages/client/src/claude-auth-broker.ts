import { z } from 'zod';
import { createExecutionAuthBroker, BrokerRejection } from './execution-auth-broker.js';
import { createPinnedClaudeOAuthReader } from './backends/claude-usage.js';
export type ClaudeProviderCredential = { kind: 'oauth' | 'api-key'; secret: string };
export interface ClaudeFoundryConfig {
  readonly origin: string;
  readonly deployments: Readonly<Record<string, string>>;
}
export type CredentialReader = (() => ClaudeProviderCredential | Promise<ClaudeProviderCredential>) & {
  readonly foundry?: ClaudeFoundryConfig;
};
const claudeModel = /^claude-(?:haiku|sonnet|opus)-[a-zA-Z0-9.-]+$/;

function readFoundryConfig(env: NodeJS.ProcessEnv): ClaudeFoundryConfig | undefined {
  const enabled = env.CLAUDE_CODE_USE_FOUNDRY;
  if (enabled && enabled !== '0' && enabled !== '1')
    throw new Error('CLAUDE_CODE_USE_FOUNDRY must be 0 or 1');
  const keys = ['ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY', 'VICOOP_CLAUDE_FOUNDRY_MODEL_MAP'];
  if (enabled !== '1') {
    if (keys.some(key => env[key] !== undefined)) throw new Error('Foundry settings require CLAUDE_CODE_USE_FOUNDRY=1');
    return undefined;
  }
  if (['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'].some(key => env[key] !== undefined))
    throw new Error('Foundry cannot be combined with direct Anthropic authentication or endpoints');
  if (!env.ANTHROPIC_FOUNDRY_API_KEY) throw new Error('Foundry requires host ANTHROPIC_FOUNDRY_API_KEY; Entra ID and managed identity are not supported');
  const resource = env.ANTHROPIC_FOUNDRY_RESOURCE;
  const base = env.ANTHROPIC_FOUNDRY_BASE_URL;
  if (!!resource === !!base) throw new Error('Set exactly one Foundry resource or base URL');
  if (resource && !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(resource)) throw new Error('Invalid Foundry resource');
  let endpoint: URL;
  try { endpoint = new URL(base ?? `https://${resource}.services.ai.azure.com/anthropic`); }
  catch { throw new Error('Invalid Foundry base URL'); }
  if (endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.services\.ai\.azure\.com$/.test(endpoint.hostname) ||
      !['/', '/anthropic', '/anthropic/'].includes(endpoint.pathname)) throw new Error('Invalid Foundry base URL');
  let mapping: unknown;
  try { mapping = JSON.parse(env.VICOOP_CLAUDE_FOUNDRY_MODEL_MAP ?? ''); }
  catch { throw new Error('Foundry requires VICOOP_CLAUDE_FOUNDRY_MODEL_MAP JSON'); }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.keys(mapping).length < 1 || Object.keys(mapping).length > 32 ||
      Object.entries(mapping).some(([model, deployment]) => !claudeModel.test(model) || typeof deployment !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(deployment)))
    throw new Error('Invalid Foundry model/deployment mapping');
  return Object.freeze({ origin: endpoint.origin, deployments: Object.freeze({ ...mapping as Record<string, string> }) });
}

// Pin the source at daemon startup. Reread it on every request, without
// falling back to a different credential type after expiry or removal.
export function createClaudeCredentialReader(env: NodeJS.ProcessEnv = process.env): CredentialReader {
  for (const key of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
    if (env[key] && env[key] !== '0') throw new Error(`${key} is unsupported by Claude container authentication`);
  }
  const foundry = readFoundryConfig(env);
  if (foundry) {
    const pinnedKeys = ['CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL',
      'ANTHROPIC_FOUNDRY_API_KEY', 'VICOOP_CLAUDE_FOUNDRY_MODEL_MAP', 'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];
    const initial = pinnedKeys.map(key => env[key]);
    const secret = env.ANTHROPIC_FOUNDRY_API_KEY;
    const reader: CredentialReader = () => {
      if (pinnedKeys.some((key, index) => env[key] !== initial[index]))
        throw new Error('Foundry host configuration changed; restart the daemon');
      if (!secret || /\s/.test(secret)) throw new Error('Foundry host API key is unavailable; restore it and restart the daemon');
      return { kind: 'api-key', secret };
    };
    Object.defineProperty(reader, 'foundry', { value: foundry, enumerable: true });
    return reader;
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

// Only deliberately shared, bounded settings may reach an untrusted caller's argv.
// strict() rejects hooks/helpers, arbitrary environment, and future unknown keys.
const callerSettings = z.object({
  model: z.string().regex(/^(?:sonnet|opus|haiku|claude-[a-z0-9.-]+)(?:\[1m\])?$/).optional(),
  effortLevel: z.enum(['low', 'medium', 'high', 'max']).optional(),
  alwaysThinkingEnabled: z.boolean().optional(),
  sandbox: z.object({ enabled: z.boolean().optional(), failIfUnavailable: z.boolean().optional() }).strict().optional(),
  permissions: z.object({
    deny: z.array(z.string().min(1).max(1024).regex(/\S/).regex(/^[^\u0000-\u001f\u007f]*$/)).max(64),
  }).strict().optional(),
  env: z.object({ ENABLE_PROMPT_CACHING_1H: z.enum(['0', '1']).optional() }).strict().optional(),
}).strict();

export function selectClaudeCallerSettings(settings: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (settings === undefined) return undefined;
  const result = callerSettings.safeParse(settings);
  if (!result.success)
    throw new Error('Claude container settings support only model, effortLevel, alwaysThinkingEnabled, sandbox enabled/failIfUnavailable, permissions.deny (up to 64 nonblank rules of 1024 characters without control characters), and env.ENABLE_PROMPT_CACHING_1H (0 or 1); host hooks, helpers and other environment/settings are unsupported');
  // Linux limits each argv string to 128 KiB on 4 KiB-page systems. Leave
  // room for backend-added settings and count serialized UTF-8, not characters.
  if (Buffer.byteLength(JSON.stringify(result.data), 'utf8') > 96 * 1024)
    throw new Error('Claude container settings must serialize to at most 96 KiB of UTF-8 JSON');
  return result.data; // Parsed copy, never the operator's mutable settings object.
}

export function assertClaudeBrokerSettings(settings: Record<string, unknown> | undefined): void {
  selectClaudeCallerSettings(settings);
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
  const foundry = opts.credential.foundry;
  return createExecutionAuthBroker({
    ...opts, upstream: opts.upstream ?? foundry?.origin ?? 'https://api.anthropic.com',
    origins: [foundry?.origin ?? 'https://api.anthropic.com'],
    pathPrefix: foundry ? '/anthropic' : undefined,
    transformBody: foundry ? data => ({ ...data, model: foundry.deployments[data.model] }) : undefined,
    allow: req => req.method === 'POST' && ['/v1/messages','/v1/messages?beta=true','/v1/messages/count_tokens','/v1/messages/count_tokens?beta=true'].includes(req.url ?? ''),
    async prepare(req, data) {
      if (!data || typeof data !== 'object' || typeof data.model !== 'string' ||
          !claudeModel.test(data.model) ||
          (foundry && (!Object.hasOwn(foundry.deployments, data.model) || Object.hasOwn(data, 'fallbacks'))) ||
          (opts.models && !opts.models.includes(data.model)) ||
          (!req.url!.includes('count_tokens') && (!Number.isInteger(data.max_tokens) || data.max_tokens < 1 || data.max_tokens > 128_000))) {
        throw new BrokerRejection(403);
      }
      let credential: ClaudeProviderCredential;
      try { credential = await opts.credential(); } catch {
        opts.onCredentialFailure?.();
        throw new BrokerRejection(503);
      }
      if (!credential.secret || /\s/.test(credential.secret) || (foundry && credential.kind !== 'api-key') || (opts.authentication && credential.kind !== opts.authentication)) { throw new BrokerRejection(503); }
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
