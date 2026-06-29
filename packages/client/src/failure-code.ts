export interface TaskFailError {
  code: string;
  message: string;
}

const PRESERVED_INPUT_CODES = new Set([
  'empty_prompt',
  'invalid_input',
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
  if (SEMANTIC_CODES.has(code)) return error;
  if (PRESERVED_INPUT_CODES.has(code)) return error;

  const text = `${code} ${message}`.toLowerCase();
  let normalizedCode = code;
  if (isQuotaExceeded(text)) normalizedCode = 'quota_exceeded';
  else if (isRateLimited(text)) normalizedCode = 'rate_limited';
  else if (isLoginRequired(text)) normalizedCode = 'login_required';
  else if (isAuthRequired(text)) normalizedCode = 'auth_required';
  else if (isAgentUnavailable(text)) normalizedCode = 'agent_unavailable';
  else if (isModelUnavailable(text)) normalizedCode = 'model_unavailable';
  else if (DISCONNECTED_CODES.has(code)) normalizedCode = 'disconnected';
  else if (isNetworkError(text)) normalizedCode = 'network_error';
  else if (isDisconnected(text)) normalizedCode = 'disconnected';
  else if (code === 'task_timeout' || isTimeout(text)) normalizedCode = 'timeout';
  else if (UPSTREAM_CODES.has(code) || isUpstreamError(text)) normalizedCode = 'upstream_error';

  if (normalizedCode === error.code) return error;
  return { ...error, code: normalizedCode };
}

function isQuotaExceeded(text: string): boolean {
  return (
    /\bquota\b/.test(text) ||
    text.includes('insufficient_quota') ||
    text.includes('exceeded your current quota') ||
    text.includes('usage limit') ||
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
    // Anthropic server-side overload, e.g. "API Error: 529 Overloaded ...";
    // the bare word can also arrive without the numeric status.
    text.includes('overloaded') ||
    /\b5\d\d\b/.test(text)
  );
}
