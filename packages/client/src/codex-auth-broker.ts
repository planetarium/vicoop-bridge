import semver from 'semver';
import { BACKENDS_MANIFEST } from './backends-manifest.js';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createExecutionAuthBroker,
  BrokerRejection,
} from './execution-auth-broker.js';

export const CODEX_BROKER_VERSION_RANGE =
  BACKENDS_MANIFEST.codex.externalRuntimeSupportedRange!;
export function isSupportedCodexBrokerVersion(version: string): boolean {
  return semver.satisfies(version, CODEX_BROKER_VERSION_RANGE);
}

class InvalidCodexLogin extends Error {}

export type CodexCredential = {
  kind: 'api-key' | 'oauth';
  secret: string;
  accountId?: string;
  azureEndpoint?: string;
  azureModel?: string;
  azureDeployment?: string;
};
export type CodexCredentialReader = () =>
  | CodexCredential
  | Promise<CodexCredential>;

// Explicit host-only Azure adapter. Caller input cannot select an upstream.
export function validateCodexAzureEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid Codex Azure endpoint'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
      !/^[a-z0-9][a-z0-9-]*\.(?:openai\.azure\.com|services\.ai\.azure\.com)$/.test(url.hostname) ||
      !['/openai/v1', '/openai/v1/'].includes(url.pathname))
    throw new Error('Invalid Codex Azure endpoint; use https://RESOURCE.openai.azure.com/openai/v1');
  return url.origin + '/openai/v1';
}

function validateAzureModels(model: string | undefined, deployment: string | undefined): void {
  if (!model || !/^(gpt-|o[134](?:-|$))[a-zA-Z0-9._-]+$/.test(model) || model.length > 128 ||
      !deployment || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(deployment))
    throw new Error('Azure Codex requires a supported logical model and a valid deployment name');
}

// Select once, reread only that source, and never copy/refresh a login in Docker.
export function createCodexCredentialReader(
  env: NodeJS.ProcessEnv = process.env,
): CodexCredentialReader {
  const azureKeys = ['VICOOP_CODEX_AZURE_ENDPOINT', 'VICOOP_CODEX_AZURE_MODEL',
    'VICOOP_CODEX_AZURE_DEPLOYMENT', 'VICOOP_CODEX_AZURE_API_VERSION', 'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_AUTH_TOKEN', 'AZURE_OPENAI_AD_TOKEN', 'AZURE_OPENAI_API_VERSION'];
  if (azureKeys.some(key => env[key] !== undefined)) {
    if (!env.VICOOP_CODEX_AZURE_ENDPOINT || !env.AZURE_OPENAI_API_KEY ||
        !env.VICOOP_CODEX_AZURE_MODEL || !env.VICOOP_CODEX_AZURE_DEPLOYMENT ||
        env.OPENAI_API_KEY || env.OPENAI_BASE_URL || env.AZURE_OPENAI_ENDPOINT ||
        env.AZURE_OPENAI_AUTH_TOKEN || env.AZURE_OPENAI_AD_TOKEN || env.OPENAI_API_VERSION ||
        env.AZURE_OPENAI_API_VERSION ||
        (env.VICOOP_CODEX_AZURE_API_VERSION !== undefined && env.VICOOP_CODEX_AZURE_API_VERSION !== 'v1'))
      throw new Error('Azure Codex requires explicit bridge endpoint, model, deployment and API key; conflicting provider settings and non-v1 API versions are unsupported');
    const endpoint = validateCodexAzureEndpoint(env.VICOOP_CODEX_AZURE_ENDPOINT);
    const model = env.VICOOP_CODEX_AZURE_MODEL;
    const deployment = env.VICOOP_CODEX_AZURE_DEPLOYMENT;
    validateAzureModels(model, deployment);
    const initialKey = env.AZURE_OPENAI_API_KEY;
    if (/\s/.test(initialKey)) throw new Error('Host Azure OpenAI API key is unavailable');
    const pinnedKeys = [...azureKeys, 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_ENDPOINT',
      'AZURE_OPENAI_AUTH_TOKEN', 'AZURE_OPENAI_AD_TOKEN', 'OPENAI_API_VERSION', 'AZURE_OPENAI_API_VERSION'];
    const initial = pinnedKeys.map(key => env[key]);
    return () => {
      if (pinnedKeys.some((key, index) => env[key] !== initial[index]))
        throw new Error('Host Azure Codex configuration changed; restart the bridge');
      return {kind: 'api-key', secret: initialKey, azureEndpoint: endpoint, azureModel: model, azureDeployment: deployment};
    };
  }
  if (env.OPENAI_BASE_URL)
    throw new Error(
      'Codex container authentication requires the direct OpenAI service',
    );
  if (env.OPENAI_API_KEY) {
    const initialKey = env.OPENAI_API_KEY;
    if (/\s/.test(initialKey))
      throw new Error('Host OpenAI API key is unavailable');
    return () => {
      const secret = env.OPENAI_API_KEY;
      if (!secret || /\s/.test(secret))
        throw new Error('Host OpenAI API key is unavailable');
      if (secret !== initialKey)
        throw new Error('Host OpenAI API key changed; restart the bridge');
      return { kind: 'api-key', secret };
    };
  }
  const config = join(
    env.CODEX_HOME || join(homedir(), '.codex'),
    'config.toml',
  );
  if (existsSync(config)) {
    for (const raw of readFileSync(config, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('[')) break;
      if (
        /^profile\s*=/.test(line) ||
        (/^model_provider\s*=/.test(line) &&
          !/^model_provider\s*=\s*["']openai["']\s*(?:#.*)?$/.test(line))
      ) {
        throw new Error(
          'Codex container authentication supports only the default OpenAI provider, without a host config profile',
        );
      }
    }
  }
  const file = join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
  const read = (): CodexCredential => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.OPENAI_API_KEY && data.tokens?.access_token)
        throw new InvalidCodexLogin(
          'Host Codex login has conflicting API-key and OAuth credentials; select one login type',
        );
      if (data.OPENAI_API_KEY) {
        if (
          typeof data.OPENAI_API_KEY !== 'string' ||
          /\s/.test(data.OPENAI_API_KEY)
        )
          throw Error();
        return { kind: 'api-key', secret: data.OPENAI_API_KEY };
      }
      if (data.auth_mode !== 'chatgpt')
        throw new InvalidCodexLogin(
          'Host Codex login mode is unsupported; use an API key or a chatgpt login',
        );
      const secret = data.tokens?.access_token,
        accountId = data.tokens?.account_id;
      if (
        typeof secret !== 'string' ||
        !secret ||
        /\s/.test(secret) ||
        typeof accountId !== 'string' ||
        !accountId ||
        /\s/.test(accountId)
      )
        throw Error();
      const payload = JSON.parse(
        Buffer.from(secret.split('.')[1], 'base64url').toString(),
      );
      if (
        typeof payload.exp !== 'number' ||
        payload.exp * 1000 <= Date.now() + 30000
      )
        throw Error();
      return { kind: 'oauth', secret, accountId };
    } catch (error) {
      if (error instanceof InvalidCodexLogin) throw error;
      throw new Error(
        'Host Codex login is missing or expired; log in on the host and retry. The bridge does not refresh OAuth.',
      );
    }
  };
  const initial = read();
  return () => {
    const next = read();
    if (
      next.kind !== initial.kind ||
      next.accountId !== initial.accountId ||
      (initial.kind === 'api-key' && next.secret !== initial.secret)
    )
      throw new Error('Host Codex account changed; restart the bridge');
    return next;
  };
}

export function createCodexAuthBroker(opts: {
  credential: CodexCredentialReader;
  authentication: 'api-key' | 'oauth';
  upstream?: string;
  azureEndpoint?: string;
  azureModel?: string;
  azureDeployment?: string;
  ttlMs?: number;
  timeoutMs?: number;
  maxRequests?: number;
  maxConcurrent?: number;
}) {
  const oauth = opts.authentication === 'oauth';
  const azure = opts.azureEndpoint ? new URL(validateCodexAzureEndpoint(opts.azureEndpoint)) : undefined;
  if (azure && oauth) throw new Error('Azure Codex requires API-key authentication');
  if (azure) validateAzureModels(opts.azureModel, opts.azureDeployment);
  else if (opts.azureModel || opts.azureDeployment) throw new Error('Azure Codex requires an endpoint');
  return createExecutionAuthBroker({
    ...opts,
    upstream:
      opts.upstream ??
      (azure?.origin ?? (oauth ? 'https://chatgpt.com' : 'https://api.openai.com')),
    origins: [azure?.origin ?? (oauth ? 'https://chatgpt.com' : 'https://api.openai.com')],
    pathPrefix: azure ? azure.pathname : opts.upstream ? '' : oauth ? '/backend-api/codex' : '/v1',
    transformBody: azure ? data => ({ ...data, model: opts.azureDeployment }) : undefined,
    allow(req) {
      // Built-in OpenAI tries WebSockets first. 426 selects its HTTP fallback
      // immediately; 403 causes repeated handshakes before falling back.
      if (
        req.method === 'GET' &&
        req.url === '/responses' &&
        req.headers.upgrade?.toLowerCase() === 'websocket'
      )
        return 426;
      return (
        req.method === 'POST' &&
        ['/responses', '/responses/compact'].includes(req.url ?? '') &&
        !req.headers['content-encoding']
      );
    },
    async prepare(req, data) {
      if (
        !data ||
        typeof data !== 'object' ||
        typeof data.model !== 'string' ||
        !/^(gpt-|o[134](?:-|$))[a-zA-Z0-9._-]*$/.test(data.model) ||
        (azure && data.model !== opts.azureModel) ||
        data.background === true
      )
        throw new BrokerRejection(403);
      if (
        data.max_output_tokens !== undefined &&
        (!Number.isInteger(data.max_output_tokens) ||
          data.max_output_tokens < 1 ||
          data.max_output_tokens > 128000)
      )
        throw new BrokerRejection(403);
      const credential = await opts.credential();
      if (
        credential.kind !== opts.authentication ||
        credential.azureEndpoint !== azure?.href.replace(/\/$/, '') ||
        credential.azureModel !== opts.azureModel ||
        credential.azureDeployment !== opts.azureDeployment ||
        !credential.secret ||
        /\s/.test(credential.secret)
      )
        throw new BrokerRejection(503);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(azure ? {'api-key': credential.secret} : {authorization: `Bearer ${credential.secret}`}),
      };
      if (oauth) {
        if (!credential.accountId || /\s/.test(credential.accountId))
          throw new BrokerRejection(503);
        headers['chatgpt-account-id'] = credential.accountId;
        headers['openai-beta'] = 'responses=experimental';
        headers.originator = 'codex_cli_rs';
      }
      for (const name of [
        'user-agent',
        'session_id',
        'conversation_id',
        'version',
      ]) {
        if (typeof req.headers[name] === 'string')
          headers[name] = req.headers[name];
      }
      return headers;
    },
  });
}

// ChatGPT's authenticated catalog is different from the embedded API catalog.
// Only non-secret model metadata crosses into the runtime, staged per execution.
export async function loadCodexModelCatalog(
  credential: CodexCredentialReader,
  version: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  const auth = await credential();
  signal?.throwIfAborted();
  if (auth.kind !== 'oauth') return undefined;
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))
    throw new Error('Invalid Codex version');
  const response = await fetchImpl(
    `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(
      version,
    )}`,
    {
      headers: {
        authorization: `Bearer ${auth.secret}`,
        'chatgpt-account-id': auth.accountId!,
        originator: 'codex_cli_rs',
      },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    },
  );
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Host Codex model catalog is unavailable');
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body as any) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024)
      throw new Error('Codex model catalog exceeds limit');
    chunks.push(chunk);
  }
  signal?.throwIfAborted();
  const text = Buffer.concat(chunks).toString();
  if (text.includes(auth.secret))
    throw new Error('Invalid Codex model catalog');
  const parsed = JSON.parse(text);
  if (
    !Array.isArray(parsed.models) ||
    !parsed.models.length ||
    parsed.models.some((m: any) => typeof m.slug !== 'string')
  )
    throw new Error('Invalid Codex model catalog');
  return JSON.stringify({
    models: parsed.models.map((model: any) => ({
      ...model,
      supported_in_api: true,
      prefer_websockets: false,
      use_responses_lite: false,
    })),
  });
}
