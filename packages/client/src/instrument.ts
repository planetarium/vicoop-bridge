// Opt-in crash telemetry for the bridge client daemon.
//
// Unlike the server (packages/server/src/instrument.ts), the client runs on
// operators' own machines and ships as a distributed binary, so its Sentry
// posture is deliberately the *opposite* of the server's:
//
//   - OFF by default. This module is dynamically imported and `initTelemetry`
//     called only when config.json has `"telemetry": "on"` (see cli.ts). When
//     the operator hasn't opted in, the Sentry SDK is never even loaded.
//   - NO console / log forwarding. The server forwards console.* as structured
//     logs; doing that here would ship operators' agent output (prompts, code,
//     task content) to us. We disable breadcrumbs entirely so nothing the
//     daemon logs is ever attached to an event.
//   - NO tracing. tracesSampleRate: 0 — we capture crashes, not spans.
//   - NO PII. sendDefaultPii: false, and `scrubEvent` strips request/user data
//     and redacts the operator's home path out of stack frames / messages.
//
// Net effect when opted in: only an exception's class + stack trace (with home
// paths redacted) reaches Sentry. Never prompts, code, agent output, tokens,
// or console logs.

import { homedir } from 'node:os';
// `@sentry/bun` (not `@sentry/node`): the released client is a `bun build
// --compile` single-file binary, so it runs on the Bun runtime — and that's
// the only context where telemetry is ever live. `@sentry/bun` extends the
// node SDK with Bun's native fetch transport; it also imports cleanly under
// Node, so dev (`tsx`) and the test runner are unaffected (telemetry is opt-in
// and never initialized there anyway).
import type { ErrorEvent, EventHint } from '@sentry/bun';
import * as Sentry from '@sentry/bun';
import { clientVersion } from './version.js';

// Fallback DSN for the client's own Sentry project. A DSN is a *submit-only*
// credential — it cannot read, list, modify, or delete events — so shipping it
// inside the distributed binary is safe, the same posture Sentry documents for
// browser SDKs.
//
// Kept empty on purpose: the real DSN is injected at *build time*, not stored
// here. The release build (scripts/package-client-release.sh) passes
// `--define process.env.VICOOP_CLIENT_SENTRY_DSN="<dsn>"` to `bun build`, which
// rewrites the lookup in resolveDsn() to a string literal in the compiled
// binary. The value comes from the VICOOP_CLIENT_SENTRY_DSN GitHub secret (see
// .github/workflows/release.yml). Builds without that secret (local, forks, CI
// smoke compiles) leave the lookup as a normal runtime read — undefined there —
// and fall through to this empty string, so telemetry stays disabled and sends
// nothing. The same env var also works as a plain runtime override for local
// testing (`VICOOP_CLIENT_SENTRY_DSN=… vicoop-client start`).
const BAKED_IN_DSN = '';

function resolveDsn(): string {
  return process.env.VICOOP_CLIENT_SENTRY_DSN?.trim() || BAKED_IN_DSN;
}

let initialized = false;

// Redact the operator's home directory out of any string so absolute paths
// like `/Users/alice/...` or `/home/alice/...` (which leak a username) become
// `~/...`. Applied to exception messages and stack-frame filenames.
function redactHome(value: string): string {
  const home = homedir();
  if (!home) return value;
  return value.split(home).join('~');
}

// Drop everything that could carry operator data, then redact home paths from
// what's left. Runs on every event right before it leaves the process.
// Exported for unit-testability; the daemon wires it in via `beforeSend`.
export function scrubEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  // Identifying / network metadata we never want.
  delete event.user;
  delete event.request;
  delete event.server_name; // hostname can identify the operator's machine
  // Breadcrumbs are already suppressed via beforeBreadcrumb, but belt-and-
  // suspenders: never let any accumulate onto an event.
  delete event.breadcrumbs;

  if (event.message) event.message = redactHome(event.message);
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = redactHome(value.value);
    for (const frame of value.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = redactHome(frame.filename);
      if (frame.abs_path) frame.abs_path = redactHome(frame.abs_path);
    }
  }
  return event;
}

// Initialize the Sentry SDK for crash reporting. Idempotent. Returns true when
// telemetry is actually live (initialized with a DSN), false when there is no
// DSN to send to — the caller uses this to decide whether to wire up the
// process-level crash handlers and to log the resolved state.
export function initTelemetry(opts: { environment?: string } = {}): boolean {
  if (initialized) return true;
  const dsn = resolveDsn();
  if (!dsn) return false;

  Sentry.init({
    dsn,
    release: `@vicoop-bridge/client@${clientVersion}`,
    // Same shared-project tagging convention as the server: the `service` tag
    // is how client vs. server events are told apart.
    initialScope: { tags: { service: 'vicoop-bridge-client' } },
    environment:
      opts.environment ??
      process.env.VICOOP_CLIENT_SENTRY_ENVIRONMENT ??
      'production',
    // Crash reporting only — no performance tracing/spans.
    tracesSampleRate: 0,
    // Never attach IP, cookies, headers, or user identifiers.
    sendDefaultPii: false,
    // Suppress ALL breadcrumbs. @sentry/node's default integrations turn
    // console.* calls into breadcrumbs; for this client those calls carry agent
    // output, so dropping every breadcrumb is what keeps that data out of
    // events. (We also filter the Console integration below for good measure.)
    beforeBreadcrumb: () => null,
    // Last-line scrub: strip request/user/host data and redact home paths.
    beforeSend: scrubEvent,
    // Drop the Console integration so it never even builds breadcrumbs from the
    // daemon's logging. Keeping the rest of the defaults (e.g. the global error
    // handlers) intact.
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== 'Console'),
  });
  initialized = true;
  return true;
}

// Capture an exception. No-op when telemetry isn't initialized, so callers can
// invoke it unconditionally.
export function captureException(error: unknown): void {
  if (!initialized) return;
  Sentry.captureException(error);
}

// Flush queued events before the process exits. The Sentry transport is async;
// without a flush a captured crash can be lost when we call process.exit right
// after. No-op (resolves immediately) when telemetry isn't initialized.
export async function flushTelemetry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Best-effort: a failed flush must never block or crash shutdown.
  }
}
