#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { AgentCard } from '@vicoop-bridge/protocol';
import { Client } from './client.js';
import { echoBackend } from './backends/echo.js';
import { createOpenclawBackend } from './backends/openclaw.js';
import { createClaudeBackend } from './backends/claude.js';
import type { Backend } from './backend.js';

interface Args {
  server: string;
  token: string;
  agentId: string;
  card: string;
  backend: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
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
      return createClaudeBackend();
    default:
      throw new Error(`unknown backend: ${name} (supported: echo, openclaw, claude)`);
  }
}

const args = parseArgs();
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
