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

// Calls WebFinger and reports whether the bridge resolves this acct. A miss
// here usually means the bridge isn't connected to a client agent with this
// agentId, or the bridge's PUBLIC_URL host differs from the WS host the
// client is connecting on.
async function verifyWebfinger(id: AgentIdentity): Promise<VerifyResult> {
  const url = webfingerUrl(id);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/jrd+json' } });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { subject?: unknown; aliases?: unknown };
    const subject = typeof body.subject === 'string' ? body.subject : undefined;
    const aliases = Array.isArray(body.aliases)
      ? body.aliases.filter((x): x is string => typeof x === 'string')
      : undefined;
    return { ok: true, status: res.status, subject, aliases };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function printText(r: WhoamiResult): void {
  const pad = (k: string) => k.padEnd(12);
  process.stdout.write(`${pad('agentId:')}${r.agentId}\n`);
  process.stdout.write(`${pad('host:')}${r.host}\n`);
  process.stdout.write(`${pad('mention:')}${r.mention}\n`);
  process.stdout.write(`${pad('acct:')}${r.acct}\n`);
  process.stdout.write(`${pad('a2a:')}${r.a2aEndpoint}\n`);
  process.stdout.write(`${pad('a2a card:')}${r.a2aCardUrl}\n`);
  process.stdout.write(`${pad('webfinger:')}${r.webfingerUrl}\n`);
  if (r.verify) {
    process.stdout.write('\n');
    if (r.verify.ok) {
      process.stdout.write(`webfinger ok (subject=${r.verify.subject ?? '?'})\n`);
      for (const a of r.verify.aliases ?? []) {
        process.stdout.write(`  alias: ${a}\n`);
      }
    } else {
      process.stdout.write(
        `webfinger FAILED: ${r.verify.error ?? 'unknown error'}\n`,
      );
      process.stdout.write(
        '  (the bridge may not have this agentId connected, or its PUBLIC_URL host differs from --server host)\n',
      );
    }
  }
}

export async function runWhoami(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n${USAGE}\n`);
    return 1;
  }
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const agentId = parsed.agentId ?? process.env.AGENT_ID;
  const server = parsed.server ?? process.env.SERVER_URL;
  if (!agentId || !server) {
    process.stderr.write(
      `missing required: ${[!agentId && 'agentId', !server && 'server'].filter(Boolean).join(', ')}\n${USAGE}\n`,
    );
    return 1;
  }

  const host = hostFromServerUrl(server);
  if (!host) {
    process.stderr.write(`could not derive host from --server: ${server}\n`);
    return 1;
  }
  if (!isValidMentionableLocal(agentId)) {
    process.stderr.write(
      `agentId "${agentId}" is not a valid Mentionable local-part (must match [A-Za-z0-9._-]{1,64} and not be . or ..). ` +
        'WebFinger lookup will not resolve.\n',
    );
    // Continue printing so operators see what they have configured — but flag
    // it via a non-zero exit so scripts can branch on validity.
    const id: AgentIdentity = { agentId, host };
    const result: WhoamiResult = {
      agentId,
      host,
      mention: formatMention(id),
      acct: formatAcct(id),
      a2aEndpoint: a2aEndpoint(id),
      a2aCardUrl: a2aCardUrl(id),
      webfingerUrl: webfingerUrl(id),
    };
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printText(result);
    }
    return 2;
  }

  const id = deriveIdentity(agentId, server);
  if (!id) {
    // Should not be reachable given the explicit checks above; defensive.
    process.stderr.write('could not derive agent identity\n');
    return 1;
  }
  const result: WhoamiResult = {
    agentId: id.agentId,
    host: id.host,
    mention: formatMention(id),
    acct: formatAcct(id),
    a2aEndpoint: a2aEndpoint(id),
    a2aCardUrl: a2aCardUrl(id),
    webfingerUrl: webfingerUrl(id),
  };
  if (parsed.verify) {
    result.verify = await verifyWebfinger(id);
  }
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printText(result);
  }
  return result.verify && !result.verify.ok ? 3 : 0;
}
