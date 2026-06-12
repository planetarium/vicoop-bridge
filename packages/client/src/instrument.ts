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

// Resolve the client's own Sentry DSN. A DSN is a *submit-only* credential —
// it cannot read, list, modify, or delete events — so baking it into the
// distributed binary is safe, the same posture Sentry documents for browser
// SDKs.
//
// There's a single source: `process.env.VICOOP_CLIENT_SENTRY_DSN`. In the
// release binary it isn't a runtime read — the build (scripts/
// package-client-release.sh) passes `--define
// process.env.VICOOP_CLIENT_SENTRY_DSN="<dsn>"` to `bun build`, which rewrites
// this lookup to a string literal in the compiled output. The value comes from
// the VICOOP_CLIENT_SENTRY_DSN GitHub secret (see .github/workflows/
// release.yml). Builds without that define (local, forks, CI smoke compiles)
// leave it as a normal runtime read — undefined unless the operator exports the
// var themselves — so it falls through to '' and telemetry stays disabled,
// sending nothing. The same env var therefore doubles as a runtime override for
// local testing (`VICOOP_CLIENT_SENTRY_DSN=… vicoop-client start`).
function resolveDsn(): string {
  return process.env.VICOOP_CLIENT_SENTRY_DSN?.trim() ?? '';
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
    // Operability hatch: `VICOOP_CLIENT_SENTRY_DEBUG=1` makes the SDK log its
    // own transport (event queued / sent / rejected) to the console. An
    // operator who opted in but sees nothing in Sentry can flip this to confirm
    // events are actually leaving the host. Off by default; logs go to the
    // local console only (they are not themselves telemetry).
    debug: process.env.VICOOP_CLIENT_SENTRY_DEBUG === '1',
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
    // Suppress ALL breadcrumbs. Even with default integrations off (below),
    // this guarantees nothing the daemon logs — agent prompts, code, task
    // output — is ever attached to an event as a breadcrumb.
    beforeBreadcrumb: () => null,
    // Last-line scrub: strip request/user/host data and redact home paths.
    beforeSend: scrubEvent,
    // `@sentry/bun` carries the full @sentry/node + OpenTelemetry default
    // integration set: ~25 auto-instrumentations (Fastify, Postgres, Kafka,
    // Anthropic, http/undici patching, OTel global registration, …). None of
    // it is relevant to a CLI that only reports crashes, and on init it would
    // monkey-patch the daemon's own networking and register OTel globals. Turn
    // the whole default set off and add back only the two event-shaping
    // integrations crash reports benefit from. Stack-trace capture is core
    // client behavior (the stack parser), not an integration, so it's
    // unaffected — and our own process-level handlers (cli.ts) are what feed
    // uncaughtException / unhandledRejection, so we don't need Sentry's.
    defaultIntegrations: false,
    integrations: [
      Sentry.dedupeIntegration(), // collapse identical repeated crash reports
      Sentry.linkedErrorsIntegration(), // unwrap `error.cause` chains
    ],
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
