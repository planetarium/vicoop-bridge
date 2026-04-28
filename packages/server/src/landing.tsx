import type { FC } from 'hono/jsx';
import { raw } from 'hono/html';
import type { AgentCardV03 } from '@a2x/sdk';

interface LandingProps {
  adminCard: AgentCardV03;
  clients: Array<{ id: string; url: string; card: AgentCardV03 }>;
  adminWallets: string[];
}

const STYLES = `
  :root { color-scheme: light dark; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    max-width: 720px;
    margin: 2rem auto;
    padding: 0 1rem;
    line-height: 1.5;
  }
  h1 { margin-bottom: 0.25rem; }
  h2 {
    margin-top: 2rem;
    border-bottom: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    padding-bottom: 0.25rem;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    padding: 0.1em 0.3em;
    background: color-mix(in srgb, currentColor 10%, transparent);
    border-radius: 3px;
  }
  .muted { opacity: 0.7; font-size: 0.9em; }
  .lede { opacity: 0.8; margin-top: 0; }
  ul { padding-left: 1.25rem; }
  li { margin: 0.25rem 0; }
  a { color: inherit; }
`;

export const Landing: FC<LandingProps> = ({ adminCard, clients, adminWallets }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>vicoop-bridge</title>
      <style>{raw(STYLES)}</style>
    </head>
    <body>
      <h1>vicoop-bridge</h1>
      <p class="lede">A2A server for outbound-connected local agents.</p>

      <h2>Admin agent</h2>
      <p>
        <strong>{adminCard.name}</strong>{' '}
        <span class="muted">v{adminCard.version}</span>
      </p>
      <p>{adminCard.description}</p>
      <p>Skills:</p>
      <ul>
        {adminCard.skills.map((s) => (
          <li key={s.id}>
            <strong>{s.name}</strong>{' '}
            <span class="muted">— {s.description ?? ''}</span>
          </li>
        ))}
      </ul>
      <p>
        Card:{' '}
        <a href="/.well-known/agent-card.json">
          <code>/.well-known/agent-card.json</code>
        </a>
      </p>

      <h2>Connected clients ({clients.length})</h2>
      <ul>
        {clients.length === 0 ? (
          <li class="muted">No clients connected.</li>
        ) : (
          clients.map((c) => (
            <li key={c.id}>
              <code>{c.id}</code> — {c.card.name}{' '}
              <span class="muted">v{c.card.version}</span>
              {' · '}
              <a href={`/agents/${encodeURIComponent(c.id)}/.well-known/agent-card.json`}>card</a>
            </li>
          ))
        )}
      </ul>

      <h2>Tools</h2>
      <p class="muted">
        Both accept a bridge-issued opaque caller token
        (<code>vbc_caller_*</code>) on the{' '}
        <code>Authorization: Bearer ...</code> header. Wallet-based clients
        obtain one by signing a SIWE message and exchanging it at{' '}
        <code>POST /auth/siwe/exchange</code>. Non-admin wallets only see
        clients they own (RLS enforced); admin wallets see everything.
      </p>
      <ul>
        <li>
          <a href="/admin/">Admin UI</a> — wallet sign-in via RainbowKit
        </li>
        <li>
          <a href="/graphiql">GraphiQL</a> — loads anonymously; include{' '}
          <code>Authorization: Bearer vbc_caller_*</code> header for
          authenticated queries (RLS filters rows otherwise)
        </li>
      </ul>

      <h3>Admin wallets</h3>
      {adminWallets.length === 0 ? (
        <p class="muted">
          None configured. Set <code>ADMIN_WALLET_ADDRESSES</code> to grant
          global access.
        </p>
      ) : (
        <ul>
          {adminWallets.map((w) => (
            <li key={w}>
              <code>{w}</code>
            </li>
          ))}
        </ul>
      )}
    </body>
  </html>
);
