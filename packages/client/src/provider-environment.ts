// Shared by host inspect validation and the workload relay. Match names only.
// The first branch matches known provider prefixes, including routing settings.
// CODEX_API_KEY, HF_TOKEN and HUGGING_FACE_HUB_TOKEN are exact names: broad
// CODEX_/HF_ prefixes would also reject non-secret home and cache settings.
// The second branch catches generic secret names, either standalone or after
// an underscore, so an unlisted provider cannot pass through e.g. FOO_API_KEY.
export const PROVIDER_ENV_PATTERN = /^(VICOOP_(?:CODEX_AZURE|CODEX_RESPONSES|CLAUDE_FOUNDRY)_|ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_|OPENAI_|CODEX_API_KEY$|AWS_|AZURE_|GOOGLE_|GEMINI_|GROQ_|MISTRAL_|COHERE_|HF_TOKEN$|HUGGING_FACE_HUB_TOKEN$)|(?:^|_)(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|SECRET_KEY|PRIVATE_KEY|CREDENTIALS)$/;

export function responsesHeaderReferences(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {};
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { throw new Error('Invalid Codex Responses extra header mapping'); }
  if (!entries || typeof entries !== 'object' || Array.isArray(entries))
    throw new Error('Codex Responses extra headers must map header names to environment variable names');
  for (const source of Object.values(entries)) {
    if (typeof source !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source))
      throw new Error('Invalid environment reference for Codex Responses header');
  }
  return entries as Record<string, string>;
}

// Snapshot only the names. Images and resumed containers must pass the same
// boundary even if a credential uses a name outside the known provider prefixes.
export function providerEnvironmentCheck(env = process.env) {
  const sources = new Set(Object.values(responsesHeaderReferences(env.VICOOP_CODEX_RESPONSES_EXTRA_HEADERS)));
  return (entry: string) => {
    const name = entry.split('=', 1)[0];
    return PROVIDER_ENV_PATTERN.test(name) || sources.has(name);
  };
}
