// Single source of truth for the `vicoop-client` daemon: a JSON config file
// living under the client's canonical home directory (see resolveConfigDir).
//
// History: prior to #137 the daemon had no on-disk config — operators stitched
// state together from `setup --write-env-file`'s output, `install.sh`'s env
// template, and a separate `owner-session.json`. config.json replaces the
// "env file you have to source" half of that, while owner-session.json keeps
// its existing shape and role.
//
// Resolution precedence for daemon args at startup (highest wins):
//   1. CLI flags (`--server`, `--token`, ...)
//   2. Env vars (`SERVER_URL`, `SERVER_TOKEN`, ...; what systemd EnvironmentFile=
//      keeps working unchanged)
//   3. `--config <path>` (operator-specified)
//   4. config.json at the canonical path

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWriteFile } from './fs-util.js';

const CONFIG_FILENAME = 'config.json';
const OWNER_SESSION_FILENAME = 'owner-session.json';
const LEGACY_HOME_DIRNAME = '.vicoop';

// Order:
//   1. $VICOOP_HOME — explicit operator override, useful for tests and
//      multi-tenant hosts.
//   2. ~/.vicoop if it already exists — keep existing installs (which
//      already store owner-session.json there) on the same path even when
//      the operator later sets $XDG_CONFIG_HOME for unrelated reasons.
//   3. $XDG_CONFIG_HOME/vicoop — fresh installs that opted in to XDG.
//   4. ~/.vicoop fallback for everything else, matching the old default.
export function resolveConfigDir(): string {
  const explicit = process.env.VICOOP_HOME?.trim();
  if (explicit) return explicit;

  const legacy = join(homedir(), LEGACY_HOME_DIRNAME);
  if (existsSync(legacy)) return legacy;

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, 'vicoop');

  return legacy;
}

export function defaultConfigPath(): string {
  return join(resolveConfigDir(), CONFIG_FILENAME);
}

export function defaultOwnerSessionPath(): string {
  return join(resolveConfigDir(), OWNER_SESSION_FILENAME);
}

export interface ClaudeBackendConfig {
  cwd?: string;
  settings?: Record<string, unknown>;
}

export interface CodexBackendConfig {
  cwd?: string;
  sandbox_mode?: string;
}

export interface OpenclawBackendConfig {
  gateway_url?: string;
  gateway_token?: string;
  agent?: string;
  task_timeout_ms?: number;
}

export interface BackendConfigs {
  claude?: ClaudeBackendConfig;
  codex?: CodexBackendConfig;
  openclaw?: OpenclawBackendConfig;
}

// Mirrors the daemon's CLI flag surface (--server / --token / --agentId /
// --card / --backend) plus a `backends` map for per-backend defaults. Keeping
// full parity with the flags means anything an operator can pass at launch
// also has a place to live in config.json — no "this knob is only configurable
// via env" surprises.
export interface ClientConfig {
  server_url?: string;
  server_token?: string;
  agent_id?: string;
  backend?: string;
  card?: string;
  backends?: BackendConfigs;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

// Hand-edited config files reliably ship malformed entries (typos, wrong
// types, accidental nesting). Be permissive: drop bad fields silently and
// keep the rest of the file usable, rather than refusing to load and
// stranding the daemon with no config at all.
function normalizeConfig(raw: Record<string, unknown>): ClientConfig {
  const c: ClientConfig = {};
  const serverUrl = asString(raw.server_url);
  if (serverUrl) c.server_url = serverUrl;
  const serverToken = asString(raw.server_token);
  if (serverToken) c.server_token = serverToken;
  const agentId = asString(raw.agent_id);
  if (agentId) c.agent_id = agentId;
  const backend = asString(raw.backend);
  if (backend) c.backend = backend;
  const card = asString(raw.card);
  if (card) c.card = card;
  const backends = asRecord(raw.backends);
  if (backends) {
    const out: BackendConfigs = {};
    const claudeRaw = asRecord(backends.claude);
    if (claudeRaw) {
      const cwd = asString(claudeRaw.cwd);
      const settings = asRecord(claudeRaw.settings);
      if (cwd || settings) {
        out.claude = {};
        if (cwd) out.claude.cwd = cwd;
        if (settings) out.claude.settings = settings;
      }
    }
    const codexRaw = asRecord(backends.codex);
    if (codexRaw) {
      const cwd = asString(codexRaw.cwd);
      const sandbox = asString(codexRaw.sandbox_mode);
      if (cwd || sandbox) {
        out.codex = {};
        if (cwd) out.codex.cwd = cwd;
        if (sandbox) out.codex.sandbox_mode = sandbox;
      }
    }
    const ocRaw = asRecord(backends.openclaw);
    if (ocRaw) {
      const url = asString(ocRaw.gateway_url);
      const tok = asString(ocRaw.gateway_token);
      const ag = asString(ocRaw.agent);
      const tto = asNumber(ocRaw.task_timeout_ms);
      if (url || tok || ag || tto !== undefined) {
        out.openclaw = {};
        if (url) out.openclaw.gateway_url = url;
        if (tok) out.openclaw.gateway_token = tok;
        if (ag) out.openclaw.agent = ag;
        if (tto !== undefined) out.openclaw.task_timeout_ms = tto;
      }
    }
    if (Object.keys(out).length > 0) c.backends = out;
  }
  return c;
}

// Returns `null` when the path doesn't exist, is unreadable, or holds JSON
// that isn't an object. The daemon treats null as "no config", which means
// env vars / CLI flags carry the whole load (today's behavior).
export function readConfig(path: string = defaultConfigPath()): ClientConfig | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return normalizeConfig(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

// Atomic write at mode 0o600 — config.json carries SERVER_TOKEN, treat it
// like owner-session.json. Directory created at 0o700 only when fresh; an
// existing dir keeps its permissions.
export function writeConfig(path: string, config: ClientConfig): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(path, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

// Per-field overlay (top-level only — `backends.*` falls through wholesale
// when the top layer doesn't set it). Used to layer an explicit
// `--config <path>` file on top of the canonical config so operators can
// keep, say, `backends.claude.settings` in the canonical file while
// overriding just `server_url` + `server_token` via `--config`. Missing
// keys in `top` fall through from `base`; everything `top` does set wins.
export function overlayConfig(base: ClientConfig, top: ClientConfig): ClientConfig {
  return {
    server_url: top.server_url ?? base.server_url,
    server_token: top.server_token ?? base.server_token,
    agent_id: top.agent_id ?? base.agent_id,
    backend: top.backend ?? base.backend,
    card: top.card ?? base.card,
    backends: top.backends ?? base.backends,
  };
}
