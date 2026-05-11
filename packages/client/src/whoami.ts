// `vicoop-client whoami` — print the agent's own A2A identity
// (mention / acct / WebFinger URL) so operators can confirm what string
// to paste into other agents' allowed-callers or into their backend's
// persona/system prompt, and optionally verify the bridge actually
// resolves it via WebFinger.

import {
  a2aCardUrl,
  a2aEndpoint,
  deriveIdentity,
  formatAcct,
  formatMention,
  hostFromServerUrl,
  httpOriginFromServerUrl,
  isValidMentionableLocal,
  webfingerUrl,
  type AgentIdentity,
} from './identity.js';

interface ParsedArgs {
  agentId?: string;
  server?: string;
  json: boolean;
  verify: boolean;
  help: boolean;
}

// Output sinks are injectable so tests don't have to mutate global
// process.stdout/stderr — overriding `process.stdout.write` collides with
// node:test's TAP emitter and silently drops most test events.
export interface WhoamiIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const defaultIO: WhoamiIO = {
  stdout: (s) => {
    process.stdout.write(s);
  },
  stderr: (s) => {
    process.stderr.write(s);
  },
};

// Default timeout for `--verify`. Long enough to ride out a slow handshake
// against a sleeping fly machine but short enough to give a clear failure
// instead of hanging an operator's terminal indefinitely.
const VERIFY_TIMEOUT_MS = 10_000;

const USAGE =
  'usage: vicoop-client whoami [--agentId <id>] [--server <ws://...>] [--json] [--verify]\n' +
  '  agentId / server fall back to AGENT_ID / SERVER_URL env vars.';

function parseArgs(args: string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = { json: false, verify: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') {
      out.json = true;
      continue;
    }
    if (a === '--verify') {
      out.verify = true;
      continue;
    }
    if (a === '-h' || a === '--help') {
      out.help = true;
      continue;
    }
    if (a === '--agentId' || a === '--server') {
      const v = args[i + 1];
      if (v === undefined) return { error: `${a} requires a value` };
      if (a === '--agentId') out.agentId = v;
      else out.server = v;
      i++;
      continue;
    }
    return { error: `unknown argument: ${a}` };
  }
  return out;
}

interface WhoamiResult {
  agentId: string;
  host: string;
  httpOrigin: string;
  mention: string;
  acct: string;
  a2aEndpoint: string;
  a2aCardUrl: string;
  webfingerUrl: string;
  verify?: VerifyResult;
}

interface VerifyResult {
  ok: boolean;
  status?: number;
  error?: string;
  subject?: string;
  aliases?: string[];
}

// Calls WebFinger and reports whether the bridge actually resolves this
// agent. A miss usually means the bridge isn't connected to a client agent
// with this agentId, or its PUBLIC_URL host differs from the WS host being
// used here. We treat the lookup as failed unless the JRD's `subject` matches
// the requested acct — a generic 200 with an unrelated subject would
// otherwise look like a successful resolution.
async function verifyWebfinger(id: AgentIdentity): Promise<VerifyResult> {
  const url = webfingerUrl(id);
  const expectedSubject = formatAcct(id);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout after ${VERIFY_TIMEOUT_MS}ms`)),
    VERIFY_TIMEOUT_MS,
  );
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/jrd+json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { subject?: unknown; aliases?: unknown };
    const subject = typeof body.subject === 'string' ? body.subject : undefined;
    const aliases = Array.isArray(body.aliases)
      ? body.aliases.filter((x): x is string => typeof x === 'string')
      : undefined;
    if (!subject) {
      return { ok: false, status: res.status, error: 'response missing subject', aliases };
    }
    // RFC 7033 §4.4 requires `subject` to identify the resource the response
    // describes. The bridge's WebFinger lookup is case-insensitive on
    // scheme + local + domain (see `packages/server/src/well-known.test.ts`
    // "matches case-insensitively on scheme + domain + local"), so we
    // compare case-insensitively here to align — a subject that round-trips
    // through the server may come back with different casing than we sent.
    if (subject.toLowerCase() !== expectedSubject.toLowerCase()) {
      return {
        ok: false,
        status: res.status,
        error: `subject mismatch: expected "${expectedSubject}", got "${subject}"`,
        subject,
        aliases,
      };
    }
    return { ok: true, status: res.status, subject, aliases };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function printText(r: WhoamiResult, io: WhoamiIO): void {
  const pad = (k: string) => k.padEnd(12);
  io.stdout(`${pad('agentId:')}${r.agentId}\n`);
  io.stdout(`${pad('host:')}${r.host}\n`);
  io.stdout(`${pad('mention:')}${r.mention}\n`);
  io.stdout(`${pad('acct:')}${r.acct}\n`);
  io.stdout(`${pad('a2a:')}${r.a2aEndpoint}\n`);
  io.stdout(`${pad('a2a card:')}${r.a2aCardUrl}\n`);
  io.stdout(`${pad('webfinger:')}${r.webfingerUrl}\n`);
  if (r.verify) {
    io.stdout('\n');
    if (r.verify.ok) {
      io.stdout(`webfinger ok (subject=${r.verify.subject ?? '?'})\n`);
      for (const a of r.verify.aliases ?? []) {
        io.stdout(`  alias: ${a}\n`);
      }
    } else {
      io.stdout(`webfinger FAILED: ${r.verify.error ?? 'unknown error'}\n`);
      io.stdout(
        '  (the bridge may not have this agentId connected, or its PUBLIC_URL host differs from --server host)\n',
      );
    }
  }
}

function buildResult(id: AgentIdentity): WhoamiResult {
  return {
    agentId: id.agentId,
    host: id.host,
    httpOrigin: id.httpOrigin,
    mention: formatMention(id),
    acct: formatAcct(id),
    a2aEndpoint: a2aEndpoint(id),
    a2aCardUrl: a2aCardUrl(id),
    webfingerUrl: webfingerUrl(id),
  };
}

export async function runWhoami(argv: string[], io: WhoamiIO = defaultIO): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n${USAGE}\n`);
    return 1;
  }
  if (parsed.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }

  const agentId = parsed.agentId ?? process.env.AGENT_ID;
  const server = parsed.server ?? process.env.SERVER_URL;
  if (!agentId || !server) {
    io.stderr(
      `missing required: ${[!agentId && 'agentId', !server && 'server'].filter(Boolean).join(', ')}\n${USAGE}\n`,
    );
    return 1;
  }

  const host = hostFromServerUrl(server);
  const httpOrigin = httpOriginFromServerUrl(server);
  if (!host || !httpOrigin) {
    io.stderr(`could not derive host from --server: ${server}\n`);
    return 1;
  }
  if (!isValidMentionableLocal(agentId)) {
    io.stderr(
      `agentId "${agentId}" is not a valid Mentionable local-part (must match [A-Za-z0-9._-]{1,64} and not be . or ..). ` +
        'WebFinger lookup will not resolve.\n',
    );
    // Continue printing so operators see what they have configured — but flag
    // it via a non-zero exit so scripts can branch on validity. URL helpers
    // %-encode `agentId` defensively, so an out-of-charset id still yields
    // a parseable (if non-resolving) URL.
    const result = buildResult({ agentId, host, httpOrigin });
    if (parsed.json) {
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printText(result, io);
    }
    return 2;
  }

  const id = deriveIdentity(agentId, server);
  if (!id) {
    // Should not be reachable given the explicit checks above; defensive.
    io.stderr('could not derive agent identity\n');
    return 1;
  }
  const result = buildResult(id);
  if (parsed.verify) {
    result.verify = await verifyWebfinger(id);
  }
  if (parsed.json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printText(result, io);
  }
  return result.verify && !result.verify.ok ? 3 : 0;
}
