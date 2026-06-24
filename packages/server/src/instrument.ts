import * as Sentry from '@sentry/hono/node';

Sentry.init({
  // DSN from the SENTRY_DSN env var (set as a Fly secret in deployment). No
  // hardcoded fallback: if unset, the SDK initializes disabled and sends nothing.
  // The deployed DSN points at the dedicated "vicoop-bridge-server" Sentry
  // project; everything below (spans AND logs) lands there.
  dsn: process.env.SENTRY_DSN,
  // `service` tag for filtering within the project. (The Hono wrapper's init
  // type doesn't expose serverName, so we tag instead.)
  initialScope: { tags: { service: 'vicoop-bridge-server' } },
  environment: process.env.SENTRY_ENVIRONMENT ?? 'production',
  // Opt-in via env so local `tsx` runs stay silent. Enabled in the Fly
  // deployment (SENTRY_ENABLED="true" in packages/server/fly.toml). This avoids
  // forcing NODE_ENV=production on the service just to gate Sentry.
  enabled: process.env.SENTRY_ENABLED === 'true',
  // Backend service: trace all requests by default. Tune via SENTRY_TRACES_SAMPLE_RATE.
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '1.0'),
  // Drop client-disconnect noise. POST /agents/:id streams its response as
  // text/event-stream (handleHandlerResult in http.tsx); when an A2A caller
  // closes the connection mid-stream — task cancel, timeout, or a flaky
  // network — Node's HTTP server emits `Error: aborted` and the @sentry/hono
  // context-error handler reports it (mechanism auto.http.hono.context_error).
  // These are normal client behaviour, not server faults, so they should not
  // surface as production errors (issue VICOOP-BRIDGE-SERVER-1). Match the exact
  // message rather than a substring so a genuine error that merely mentions
  // "aborted" still reports.
  beforeSend(event, hint) {
    const err = hint?.originalException as { message?: unknown; code?: unknown } | undefined;
    const message = typeof err?.message === 'string' ? err.message : '';
    const code = typeof err?.code === 'string' ? err.code : '';
    if (message === 'aborted' || code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE') {
      return null;
    }
    return event;
  },
  // A single Sentry.init/DSN sends spans and logs to the same project, so
  // these logs land in "vicoop-bridge-server" alongside the spans above.
  // `enableLogs` only opens the transport; consoleLoggingIntegration is what
  // feeds it — forwarding the server's console.* output as structured Sentry
  // logs. (No Fly auto-stop flush concern here: packages/server/fly.toml keeps
  // min_machines_running=1, so the periodic log flush always runs.)
  enableLogs: true,
  integrations: [
    Sentry.consoleLoggingIntegration({ levels: ['log', 'info', 'warn', 'error'] }),
  ],
});
