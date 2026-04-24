#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { AgentCard } from '@vicoop-bridge/protocol';
import { Client } from './client.js';
import { echoBackend } from './backends/echo.js';
import { createOpenclawBackend } from './backends/openclaw.js';
import { createClaudeBackend } from './backends/claude.js';
import type { Backend } from './backend.js';
import { clientVersion } from './version.js';
import { runUpgrade } from './upgrade.js';

interface Args {
  server: string;
  token: string;
  agentId: string;
  card: string;
  backend: string;
}

function parseClientArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (!key.startsWith('--')) continue;
    const k = key.slice(2) as keyof Args;
    out[k] = val;
    i++;
  }
  const env = (k: string, v?: string) => v ?? process.env[k];
  const resolved: Args = {
    server: env('SERVER_URL', out.server)!,
    token: env('SERVER_TOKEN', out.token)!,
    agentId: env('AGENT_ID', out.agentId)!,
    card: env('AGENT_CARD', out.card)!,
    backend: env('BACKEND', out.backend) ?? 'echo',
  };
  const missing = Object.entries(resolved).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`missing required args: ${missing.join(', ')}`);
    console.error('usage: vicoop-client --server <ws://...> --token <t> --agentId <id> --card <path> [--backend echo]');
    process.exit(1);
  }
  return resolved;
}

function pickBackend(name: string): Backend {
  switch (name) {
    case 'echo':
      return echoBackend;
    case 'openclaw':
      return createOpenclawBackend();
    case 'claude':
      return createClaudeBackend({
        cwd: process.env.CLAUDE_CWD?.trim() || undefined,
      });
    default:
      throw new Error(`unknown backend: ${name} (supported: echo, openclaw, claude)`);
  }
}

function runClient(argv: string[]): void {
  const args = parseClientArgs(argv);
  const cardJson = JSON.parse(readFileSync(args.card, 'utf8'));
  const agentCard = AgentCard.parse(cardJson);

  const client = new Client({
    serverUrl: args.server,
    token: args.token,
    agentId: args.agentId,
    agentCard,
    backend: pickBackend(args.backend),
  });

  client.start();

  const shutdown = () => {
    console.log('\n[client] shutting down');
    client.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runUpgradeCmd(args: string[]): Promise<number> {
  let check = false;
  let force = false;
  let version: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check') check = true;
    else if (a === '--force') force = true;
    else if (a === '--version') {
      version = args[++i];
      if (!version) {
        console.error('--version requires a value (e.g. 0.3.0, v0.3.0, or client-v0.3.0)');
        return 1;
      }
    } else if (a === '-h' || a === '--help') {
      console.log('usage: vicoop-client upgrade [--check] [--force] [--version <X.Y.Z | vX.Y.Z | client-vX.Y.Z>]');
      return 0;
    } else {
      console.error(`unknown argument to upgrade: ${a}`);
      return 1;
    }
  }
  try {
    return await runUpgrade({ check, force, version });
  } catch (e) {
    console.error(`upgrade failed: ${(e as Error).message}`);
    return 1;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Top-level --version / -v: print and exit before touching anything else.
  // Also used by the upgrade path's healthcheck on a freshly extracted bundle.
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${clientVersion}\n`);
    process.exit(0);
  }

  if (argv[0] === 'upgrade') {
    process.exit(await runUpgradeCmd(argv.slice(1)));
  }

  // Default path: long-running daemon. Do not exit — client.start() keeps the
  // event loop alive and signal handlers will call process.exit on shutdown.
  runClient(argv);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
