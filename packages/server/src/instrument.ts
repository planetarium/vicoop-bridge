import * as Sentry from '@sentry/hono/node';

Sentry.init({
  // DSN from the SENTRY_DSN env var (set as a Fly secret in deployment). No
  // hardcoded fallback: if unset, the SDK initializes disabled and sends nothing.
  dsn: process.env.SENTRY_DSN,
  // Same project as a2x-internal-router; the `service` tag is how the two
  // services are told apart within the one shared Sentry project. (The Hono
  // wrapper's init type doesn't expose serverName, so we tag instead.)
  initialScope: { tags: { service: 'vicoop-bridge-server' } },
  environment: process.env.SENTRY_ENVIRONMENT ?? 'production',
  // Opt-in via env so local `tsx` runs stay silent. Enabled in the Fly
  // deployment (SENTRY_ENABLED="true" in packages/server/fly.toml). This avoids
  // forcing NODE_ENV=production on the service just to gate Sentry.
  enabled: process.env.SENTRY_ENABLED === 'true',
  // Backend service: trace all requests by default. Tune via SENTRY_TRACES_SAMPLE_RATE.
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '1.0'),
});
