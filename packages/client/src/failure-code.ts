export interface TaskFailError {
  code: string;
  message: string;
}

const PRESERVED_INPUT_CODES = new Set([
  'empty_prompt',
  'invalid_input',
  // Canonical OpenAI overflow code — tagged by backends and mapped to 400
  // by the gateway (oai2a2a#114); must survive normalization verbatim.
  'context_length_exceeded',
  'invalid_file_part',
  'unsupported_file_uri',
  'unsupported_file_mime',
  'file_too_large',
  'input_file_write_failed',
  'fetch_blocked_host',
  'fetch_too_large',
  'fetch_mime_mismatch',
  'fetch_failed',
  'serialize_failed',
  'parse_failed',
]);

const DISCONNECTED_CODES = new Set([
  'serve_unavailable',
  'app_server_unavailable',
  'app_server_crashed',
  'gateway_closed',
  'gateway_send_failed',
]);

const UPSTREAM_CODES = new Set(['upstream_error']);

const SEMANTIC_CODES = new Set([
  'quota_exceeded',
  'rate_limited',
  'login_required',
  'auth_required',
  'client_not_connected',
  'disconnected',
  'network_error',
  'agent_unavailable',
  'model_unavailable',
  'timeout',
]);

export function normalizeTaskFailError(error: TaskFailError): TaskFailError {
  const { code, message } = error;
  const normalizedCode = classifyFailureCode(code, message);
  const normalizedMessage = canonicalizeFailureMessage(normalizedCode, message);

  if (normalizedCode === error.code && normalizedMessage === error.message) {
    return error;
  }
  return { ...error, code: normalizedCode, message: normalizedMessage };
}

function classifyFailureCode(code: string, message: string): string {
  if (SEMANTIC_CODES.has(code)) return code;
  if (PRESERVED_INPUT_CODES.has(code)) return code;

  const text = `${code} ${message}`.toLowerCase();
  // Overflow first — its texts mention limits/tokens that later matchers
  // could misread. Full rationale at CONTEXT_OVERFLOW_PATTERNS.
  if (isContextOverflow(text)) return 'context_length_exceeded';
  if (isQuotaExceeded(text)) return 'quota_exceeded';
  if (isRateLimited(text)) return 'rate_limited';
  if (isLoginRequired(text)) return 'login_required';
  if (isAuthRequired(text)) return 'auth_required';
  if (isAgentUnavailable(text)) return 'agent_unavailable';
  if (isModelUnavailable(text)) return 'model_unavailable';
  if (DISCONNECTED_CODES.has(code)) return 'disconnected';
  if (isNetworkError(text)) return 'network_error';
  if (isDisconnected(text)) return 'disconnected';
  if (code === 'task_timeout' || isTimeout(text)) return 'timeout';
  if (UPSTREAM_CODES.has(code) || isUpstreamError(text)) return 'upstream_error';
  return code;
}

// The machine `code` is dropped before it reaches a downstream OpenAI-compatible
// client's retry heuristic (@ai-sdk/openai-compatible collapses an in-band
// `{error:{...}}` chunk to just its message string), so once a stream has
// committed content the only signal such a client can classify on is the message
// text. opencode's post-content retry matcher keys on the literal phrases
// "rate limit" / "too many requests", but `isRateLimited` above also fires on a
// bare `429`, `rate-limited` (hyphen), or `rate_limit` (underscore) — genuine
// rate limits whose upstream text lacks the exact phrase. Canonicalize those so
// the message carries the phrase. This is honest translation, not a mode change:
// the failure *is* a rate limit (we only reach here when it was classified as
// one); the upstream detail is preserved after the prefix.
function canonicalizeFailureMessage(code: string, message: string): string {
  if (code === 'rate_limited' && !/rate limit|too many requests/i.test(message)) {
    return message ? `rate limit: ${message}` : 'rate limit';
  }
  return message;
}

// Context-window overflow. This matcher is the effective classifier for the
// gateway's 400 `context_length_exceeded` mapping — a tagged code bypasses
// the gateway's own (deliberately narrow) message-rescue gate — and it runs
// before the quota/rate matchers, so every entry must be a phrase a provider
// actually emits for overflow, never a generic fragment: bare substrings
// like "context length" or "too many tokens" would reclassify TPM rate
// limits or assistant prose quoted in crash diagnostics as non-retryable
// caller errors. Matched against lowercased text.
// (claude's terminal_reason "blocking_limit" signal is handled in claude.ts,
// the layer that knows that enum — not here.)
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt is too long/, // Anthropic
  /input is too long for requested model/, // Anthropic (Bedrock)
  /input length and max_tokens exceed context limit/, // Anthropic
  /exceeds the context window/, // OpenAI /responses (relayed by codex serve)
  /maximum context length is \d+ tokens/, // OpenAI chat completions
  /reduce the length of the messages/, // OpenAI (second half of the same message)
  /input token count.*exceeds the maximum/, // Gemini
  /context[_ ]?length[_ ]?exceeded/, // the code token quoted in relayed error bodies
];

function isContextOverflow(text: string): boolean {
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}

function isQuotaExceeded(text: string): boolean {
  return (
    /\bquota\b/.test(text) ||
    text.includes('insufficient_quota') ||
    text.includes('exceeded your current quota') ||
    // "usage limit", but NOT the server-throttle disclaimer "Server is
    // temporarily limiting requests (not your usage limit)" — that's a
    // transient rate limit (classified below), not account exhaustion.
    (text.includes('usage limit') && !text.includes('not your usage limit')) ||
    // Claude subscription cap: "You've hit your session limit · resets 3pm (UTC)".
    text.includes('session limit')
  );
}

function isRateLimited(text: string): boolean {
  return (
    text.includes('rate limit') ||
    text.includes('rate_limit') ||
    text.includes('rate-limited') ||
    text.includes('rate limited') ||
    text.includes('too many requests') ||
    // Anthropic server-side throttle: "Server is temporarily limiting
    // requests (not your usage limit)" — a transient rate limit even when
    // the "· Rate limited" suffix is absent (the quota guard above hands
    // this text off rather than dropping it).
    text.includes('temporarily limiting requests') ||
    /\b429\b/.test(text)
  );
}

function isLoginRequired(text: string): boolean {
  return (
    text.includes('login required') ||
    text.includes('login_required') ||
    text.includes('not logged in') ||
    text.includes('please log in') ||
    text.includes('please login') ||
    text.includes('session expired') ||
    text.includes('reauth') ||
    text.includes('re-auth')
  );
}

function isAuthRequired(text: string): boolean {
  return (
    text.includes('auth required') ||
    text.includes('auth_required') ||
    text.includes('authentication required') ||
    text.includes('authentication failed') ||
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('invalid api key') ||
    text.includes('invalid token') ||
    text.includes('bad token') ||
    text.includes('missing token') ||
    text.includes('token expired') ||
    text.includes('expired token') ||
    /\b401\b/.test(text) ||
    /\b403\b/.test(text)
  );
}

function isDisconnected(text: string): boolean {
  return (
    text.includes('disconnected') ||
    text.includes('connection refused') ||
    text.includes('connection reset') ||
    text.includes('connection closed') ||
    text.includes('transport closed') ||
    text.includes('socket closed') ||
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('enotfound')
  );
}

function isTimeout(text: string): boolean {
  return text.includes('timeout') || text.includes('timed out');
}

function isNetworkError(text: string): boolean {
  return (
    text.includes('network_error') ||
    text.includes('network error') ||
    text.includes('transport failure') ||
    text.includes('transport failed')
  );
}

function isAgentUnavailable(text: string): boolean {
  return (
    text.includes('agent_unavailable') ||
    text.includes('agent unavailable') ||
    text.includes('agent is unavailable') ||
    text.includes('agent temporarily unavailable')
  );
}

function isModelUnavailable(text: string): boolean {
  return (
    text.includes('model_unavailable') ||
    text.includes('model unavailable') ||
    text.includes('model is unavailable') ||
    text.includes('model temporarily unavailable')
  );
}

function isUpstreamError(text: string): boolean {
  return (
    text.includes('upstream') ||
    text.includes('provider error') ||
    text.includes('provider failure') ||
    text.includes('server error') ||
    text.includes('internal server error') ||
    // Anthropic server-side overload arrives as "API Error: 529 Overloaded
    // ..." — matched by the numeric status below. The bare word "overloaded"
    // is deliberately NOT keyed on: a generic RPC turn error can carry it and
    // should stay its own code (see codex turn/start `turn_failed` test).
    /\b5\d\d\b/.test(text)
  );
}
