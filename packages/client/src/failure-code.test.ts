import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaskFailError } from './failure-code.js';

test('normalizeTaskFailError preserves caller/input validation failures', () => {
  assert.deepEqual(
    normalizeTaskFailError({
      code: 'empty_prompt',
      message: 'no content in message',
    }),
    {
      code: 'empty_prompt',
      message: 'no content in message',
    },
  );
  assert.deepEqual(
    normalizeTaskFailError({
      code: 'invalid_input',
      message: 'bad request shape',
    }),
    {
      code: 'invalid_input',
      message: 'bad request shape',
    },
  );
  assert.deepEqual(
    normalizeTaskFailError({
      code: 'file_too_large',
      message: 'FilePart exceeds INPUT_FILE_MAX_BYTES (10485761 > 10485760)',
    }),
    {
      code: 'file_too_large',
      message: 'FilePart exceeds INPUT_FILE_MAX_BYTES (10485761 > 10485760)',
    },
  );
});

test('normalizeTaskFailError maps quota and rate limit messages before generic upstream codes', () => {
  assert.equal(
    normalizeTaskFailError({
      code: 'turn_failed',
      message: 'insufficient_quota: exceeded your current quota',
    }).code,
    'quota_exceeded',
  );
  assert.equal(
    normalizeTaskFailError({
      code: 'upstream_error',
      message: 'vicoop-codex serve returned HTTP 429: too many requests',
    }).code,
    'rate_limited',
  );
});

test('normalizeTaskFailError canonicalizes rate-limit messages to carry the literal phrase', () => {
  // Bare `429` with no phrase: classified rate_limited, message gets the phrase
  // a post-content OpenAI-compatible retry heuristic (opencode) matches on.
  assert.deepEqual(
    normalizeTaskFailError({
      code: 'upstream_error',
      message: 'vicoop-codex serve returned HTTP 429',
    }),
    {
      code: 'rate_limited',
      message: 'rate limit: vicoop-codex serve returned HTTP 429',
    },
  );
  // Hyphen/underscore spellings the broad classifier accepts but the phrase
  // matcher would miss are canonicalized too.
  assert.equal(
    normalizeTaskFailError({ code: 'turn_failed', message: 'provider rate-limited the request' }).message,
    'rate limit: provider rate-limited the request',
  );
  // A caller that already emits the semantic `rate_limited` code (early-return
  // path) still gets its bare message canonicalized.
  assert.equal(
    normalizeTaskFailError({ code: 'rate_limited', message: 'slow down (429)' }).message,
    'rate limit: slow down (429)',
  );
  // Already carries the phrase: left untouched, no double prefix.
  assert.deepEqual(
    normalizeTaskFailError({
      code: 'upstream_error',
      message: 'HTTP 429: too many requests',
    }),
    {
      code: 'rate_limited',
      message: 'HTTP 429: too many requests',
    },
  );
});

test('normalizeTaskFailError maps claude subscription/overload terminal reasons', () => {
  // Claude's "session limit" cap surfaces as a usage/quota exhaustion.
  assert.equal(
    normalizeTaskFailError({
      code: 'claude_exit_nonzero',
      message: "You've hit your session limit · resets 3pm (UTC)",
    }).code,
    'quota_exceeded',
  );
  // Anthropic server-side overload, "API Error: 529 Overloaded ..." — keyed on
  // the numeric status, not the bare word (which a generic RPC turn error can
  // carry; see the codex turn/start `turn_failed` test).
  assert.equal(
    normalizeTaskFailError({
      code: 'claude_exit_nonzero',
      message: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary',
    }).code,
    'upstream_error',
  );
});

test('normalizeTaskFailError maps login and auth failures separately', () => {
  assert.equal(
    normalizeTaskFailError({
      code: 'claude_exit_nonzero',
      message: 'Claude Code session expired; please login',
    }).code,
    'login_required',
  );
  assert.equal(
    normalizeTaskFailError({
      code: 'upstream_error',
      message: 'provider returned HTTP 401 unauthorized: invalid token',
    }).code,
    'auth_required',
  );
});

test('normalizeTaskFailError maps local transport failures and timeouts', () => {
  assert.equal(
    normalizeTaskFailError({
      code: 'gateway_closed',
      message: 'gateway closed',
    }).code,
    'disconnected',
  );
  assert.equal(
    normalizeTaskFailError({
      code: 'app_server_crashed',
      message: 'codex app-server transport closed during thread/start',
    }).code,
    'disconnected',
  );
  assert.equal(
    normalizeTaskFailError({
      code: 'network_error',
      message: 'vicoop-codex serve request failed',
    }).code,
    'network_error',
  );
  assert.equal(
    normalizeTaskFailError({
      code: 'turn_failed',
      message: 'transport failure prevented completion after dispatch',
    }).code,
    'network_error',
  );
  assert.equal(
    normalizeTaskFailError({
      code: 'task_timeout',
      message: 'task timed out',
    }).code,
    'timeout',
  );
});

test('normalizeTaskFailError maps agent and model availability failures', () => {
  assert.equal(
    normalizeTaskFailError({
      code: 'turn_failed',
      message: 'agent temporarily unavailable',
    }).code,
    'agent_unavailable',
  );
  assert.equal(
    normalizeTaskFailError({
      code: 'turn_failed',
      message: 'model unavailable',
    }).code,
    'model_unavailable',
  );
});

test('normalizeTaskFailError maps clear upstream failures and preserves generic diagnostics', () => {
  assert.equal(
    normalizeTaskFailError({
      code: 'turn_failed',
      message: 'provider returned HTTP 500 internal server error',
    }).code,
    'upstream_error',
  );
  assert.equal(
    normalizeTaskFailError({
      code: 'vicoop_codex_failed',
      message: 'unknown provider failure',
    }).code,
    'upstream_error',
  );
  assert.equal(
    normalizeTaskFailError({
      code: 'gateway_chat_error',
      message: 'unknown gateway error',
    }).code,
    'gateway_chat_error',
  );
});
