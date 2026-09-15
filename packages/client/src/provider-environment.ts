// Shared by host inspect validation and the workload relay. Match names only.
// The first branch matches known provider prefixes, including routing settings.
// CODEX_API_KEY, HF_TOKEN and HUGGING_FACE_HUB_TOKEN are exact names: broad
// CODEX_/HF_ prefixes would also reject non-secret home and cache settings.
// The second branch catches generic secret names, either standalone or after
// an underscore, so an unlisted provider cannot pass through e.g. FOO_API_KEY.
export const PROVIDER_ENV_PATTERN = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_|OPENAI_|CODEX_API_KEY$|AWS_|AZURE_|GOOGLE_|GEMINI_|GROQ_|MISTRAL_|COHERE_|HF_TOKEN$|HUGGING_FACE_HUB_TOKEN$)|(?:^|_)(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|SECRET_KEY|PRIVATE_KEY|CREDENTIALS)$/;
