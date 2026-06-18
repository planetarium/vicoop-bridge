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

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWriteFile } from './fs-util.js';

const CONFIG_FILENAME = 'config.json';
const OWNER_SESSION_FILENAME = 'owner-session.json';
const LEGACY_HOME_DIRNAME = '.vicoop';

// Order (each candidate is skipped if its filesystem entry exists and is
// not a directory — see `isUsableConfigDirPath`):
//   1. $VICOOP_HOME — explicit operator override, useful for tests and
//      multi-tenant hosts.
//   2. ~/.vicoop if it already exists as a directory — keep existing
//      installs (which already store owner-session.json there) on the
//      same path even when the operator later sets $XDG_CONFIG_HOME for
//      unrelated reasons.
//   3. $XDG_CONFIG_HOME/vicoop — fresh installs that opted in to XDG.
//   4. ~/.vicoop fallback for everything else, matching the old default.
export function resolveConfigDir(): string {
  // Each candidate is accepted only when its filesystem entry is either
  // missing (we'll create it via `mkdirSync(..., { recursive: true })`) or
  // already a directory. A regular file at any of these paths would later
  // crash `mkdirSync` / `atomicWriteFile` with confusing ENOTDIR. Warn
  // loudly and fall through so the daemon can still start under a sane
  // fallback instead of failing with a low-level errno trace.
  const explicit = process.env.VICOOP_HOME?.trim();
  if (explicit) {
    if (isUsableConfigDirPath(explicit)) return explicit;
    console.warn(
      `[client] $VICOOP_HOME (${explicit}) exists but is not a directory; ignoring.`,
    );
  }

  const legacy = join(homedir(), LEGACY_HOME_DIRNAME);
  if (isExistingDirectory(legacy)) return legacy;

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    // For XDG, the canonical config dir is `$XDG_CONFIG_HOME/vicoop`. Both
    // the XDG parent and the joined subpath get the same usability rule:
    // either non-existent (we'll mkdir -p) or an existing directory.
    if (isUsableConfigDirPath(xdg)) {
      const xdgVicoop = join(xdg, 'vicoop');
      if (isUsableConfigDirPath(xdgVicoop)) return xdgVicoop;
      console.warn(
        `[client] $XDG_CONFIG_HOME/vicoop (${xdgVicoop}) exists but is not a directory; ignoring.`,
      );
    } else {
      console.warn(
        `[client] $XDG_CONFIG_HOME (${xdg}) exists but is not a directory; ignoring.`,
      );
    }
  }

  return legacy;
}

// "Usable" means either it doesn't exist yet (mkdir -p will create it) or
// it exists and is a directory. An existing regular file / symlink-to-file
// / other non-directory entry is rejected.
function isUsableConfigDirPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function defaultConfigPath(): string {
  return join(resolveConfigDir(), CONFIG_FILENAME);
}

export function defaultOwnerSessionPath(): string {
  return join(resolveConfigDir(), OWNER_SESSION_FILENAME);
}

// Where the agent CLI actually runs.
//   - 'host'      : node:child_process.spawn on the bridge-client host
//                   (today's behavior; default).
//   - 'container' : `docker exec` into a long-lived vicoop-runtime
//                   container the bridge client orchestrates (#249).
export type BackendRuntime = 'host' | 'container';

export interface ClaudeBackendConfig {
  cwd?: string;
  settings?: Record<string, unknown>;
  /**
   * Model id for the spawned `claude`, e.g. `claude-opus-4-8`. Folded into
   * the `--settings` JSON as its `model` field at launch (a per-request
   * openai-compat `model` still overrides it). Mirrors the `--claude-model`
   * flag.
   */
  model?: string;
  /**
   * Additional model ids this claude install can serve alongside `model` /
   * the probed default, e.g. `["claude-sonnet-4-6", "claude-haiku-4-5"]`.
   * Advertised on the openai-compat `params.models[]` block and accepted as
   * per-request openai-compat `model` overrides (forwarded to the spawn as
   * `--model <id>`). Not validated against the account — a model the
   * account cannot access fails at task time with claude's own
   * `model_not_found`. Mirrors the `--claude-supported-models` flag.
   */
  supported_models?: string[];
  /**
   * Forward Claude's extended-thinking on the openai-compat/v1 `reasoning`
   * channel (so the a2x-internal-router stops false-failing-over long silent
   * reasoning turns — planetarium/a2x-internal-router#95). ON by default; set
   * `false` to disable when the deployed oai2a2a codec predates 0.6.0 and can't
   * understand the channel marker yet. Mirrors the `--no-claude-reasoning`
   * flag.
   */
  reasoning?: boolean;
  runtime?: BackendRuntime;
  runtime_name?: string;
}

export interface CodexBackendConfig {
  cwd?: string;
  sandbox_mode?: string;
  /** What to answer when codex requests user approval. Default `decline`. */
  approval_decision?: 'accept' | 'acceptForSession' | 'decline';
  runtime?: BackendRuntime;
  runtime_name?: string;
}

export interface OpenclawBackendConfig {
  gateway_url?: string;
  gateway_token?: string;
  agent?: string;
  /**
   * Optional secondary agent name dedicated to tasks carrying the
   * openai-compat extension metadata. See
   * `OpenclawBackendOptions.openaiCompatAgent` for the operator-side
   * pairing (OpenClaw `agents.list` entry with `tools.deny=["*"]`).
   * Leave unset to route every task through `agent`.
   */
  openai_compat_agent?: string;
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
  // Opt-in crash telemetry. Absent / 'off' => the daemon never loads or
  // initializes the Sentry SDK. 'on' => crash reports (stack traces only — no
  // prompts, code, agent output, or console logs) are sent to the project's
  // Sentry. Default OFF is deliberate: the client runs on operators' own
  // machines, so reporting must be an explicit choice, not a silent default.
  // Flip it on with `agent register --enable-telemetry` or by hand-editing
  // this field. See packages/client/src/instrument.ts for what is/isn't sent.
  telemetry?: 'on' | 'off';
}

// Trim hand-edited values and drop the result when it's whitespace-only.
// Matches the env / CLI layers (both already call `.trim()` on their inputs)
// so a config like `"server_url": " wss://bridge "` doesn't surface as a
// "looks set but doesn't connect" mystery.
function asString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

// String-array fields: keep the string entries (trimmed, empties dropped),
// silently discard everything else — same permissive posture as the scalar
// pickers above. A non-array value or an array that yields no usable entry
// returns undefined so the field is omitted rather than set to [].
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  return out.length > 0 ? out : undefined;
}

// Enum surfaces validated at normalize time so a hand-edited typo doesn't
// reach a downstream parser that does `process.exit(1)`. Anything outside
// these sets is treated like any other malformed field — dropped, the rest
// of the file kept usable.
const KNOWN_BACKENDS = new Set([
  'echo',
  'openclaw',
  'claude',
  'codex',
  'vicoop-codex',
]);
const KNOWN_APPROVAL_DECISIONS = new Set([
  'accept',
  'acceptForSession',
  'decline',
]);
const KNOWN_CODEX_SANDBOX_MODES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);
const KNOWN_BACKEND_RUNTIMES = new Set<BackendRuntime>(['host', 'container']);

function pickBackendRuntime(v: unknown): BackendRuntime | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return KNOWN_BACKEND_RUNTIMES.has(trimmed as BackendRuntime)
    ? (trimmed as BackendRuntime)
    : undefined;
}

// Hand-edited config files reliably ship malformed entries (typos, wrong
// types, accidental nesting). Be permissive: drop bad fields silently and
// keep the rest of the file usable, rather than refusing to load and
// stranding the daemon with no config at all. Enum-like fields are
// validated against their known sets here so the daemon doesn't exit on
// an unknown `backend` / `sandbox_mode` later.
function normalizeConfig(raw: Record<string, unknown>): ClientConfig {
  const c: ClientConfig = {};
  const serverUrl = asString(raw.server_url);
  if (serverUrl) c.server_url = serverUrl;
  const serverToken = asString(raw.server_token);
  if (serverToken) c.server_token = serverToken;
  const agentId = asString(raw.agent_id);
  if (agentId) c.agent_id = agentId;
  const backend = asString(raw.backend);
  if (backend && KNOWN_BACKENDS.has(backend)) c.backend = backend;
  const card = asString(raw.card);
  if (card) c.card = card;
  // Telemetry is a closed enum: only the two known string literals are
  // honoured. Anything else (typo, bool, number) is dropped — and a dropped
  // value reads as "off" downstream, which is the safe, privacy-preserving
  // default. So a malformed telemetry field can never accidentally *enable*
  // reporting.
  const telemetry = asString(raw.telemetry);
  if (telemetry === 'on' || telemetry === 'off') c.telemetry = telemetry;
  const backends = asRecord(raw.backends);
  if (backends) {
    const out: BackendConfigs = {};
    const claudeRaw = asRecord(backends.claude);
    if (claudeRaw) {
      const cwd = asString(claudeRaw.cwd);
      const settings = asRecord(claudeRaw.settings);
      const model = asString(claudeRaw.model);
      const models = asStringArray(claudeRaw.supported_models);
      const runtime = pickBackendRuntime(claudeRaw.runtime);
      const runtimeName = asString(claudeRaw.runtime_name);
      if (cwd || settings || model || models || runtime || runtimeName) {
        out.claude = {};
        if (cwd) out.claude.cwd = cwd;
        if (settings) out.claude.settings = settings;
        if (model) out.claude.model = model;
        if (models) out.claude.supported_models = models;
        if (runtime) out.claude.runtime = runtime;
        if (runtimeName) out.claude.runtime_name = runtimeName;
      }
    }
    const codexRaw = asRecord(backends.codex);
    if (codexRaw) {
      const cwd = asString(codexRaw.cwd);
      const sandbox = asString(codexRaw.sandbox_mode);
      const validSandbox =
        sandbox && KNOWN_CODEX_SANDBOX_MODES.has(sandbox) ? sandbox : undefined;
      const approvalRaw = asString(codexRaw.approval_decision);
      const validApproval =
        approvalRaw && KNOWN_APPROVAL_DECISIONS.has(approvalRaw)
          ? (approvalRaw as 'accept' | 'acceptForSession' | 'decline')
          : undefined;
      const runtime = pickBackendRuntime(codexRaw.runtime);
      const runtimeName = asString(codexRaw.runtime_name);
      if (cwd || validSandbox || validApproval || runtime || runtimeName) {
        out.codex = {};
        if (cwd) out.codex.cwd = cwd;
        if (validSandbox) out.codex.sandbox_mode = validSandbox;
        if (validApproval) out.codex.approval_decision = validApproval;
        if (runtime) out.codex.runtime = runtime;
        if (runtimeName) out.codex.runtime_name = runtimeName;
      }
    }
    const ocRaw = asRecord(backends.openclaw);
    if (ocRaw) {
      const url = asString(ocRaw.gateway_url);
      const tok = asString(ocRaw.gateway_token);
      const ag = asString(ocRaw.agent);
      const oai = asString(ocRaw.openai_compat_agent);
      const tto = asNumber(ocRaw.task_timeout_ms);
      if (url || tok || ag || oai || tto !== undefined) {
        out.openclaw = {};
        if (url) out.openclaw.gateway_url = url;
        if (tok) out.openclaw.gateway_token = tok;
        if (ag) out.openclaw.agent = ag;
        if (oai) out.openclaw.openai_compat_agent = oai;
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
  const raw = readConfigRaw(path);
  return raw ? normalizeConfig(raw) : null;
}

// Same parse + shape check as `readConfig` but without normalization, so
// callers that need to round-trip the file (e.g. `setup` merging credentials
// into a pre-existing config.json) preserve operator-added or future-version
// keys that `normalizeConfig` would otherwise drop. Returns `null` for the
// same "missing / unreadable / not a JSON object" cases as `readConfig`,
// so callers don't have to do file existence + JSON checks themselves.
export function readConfigRaw(
  path: string = defaultConfigPath(),
): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Atomic write at mode 0o600 — config.json carries SERVER_TOKEN, treat it
// like owner-session.json. Directory created at 0o700 only when fresh; an
// existing dir keeps its permissions. Accepts either the typed
// `ClientConfig` shape or a raw `Record<string, unknown>` so callers
// merging into a pre-read raw object (preserving unknown / future-version
// keys) can write the result back without losing them through the typed
// surface.
export function writeConfig(
  path: string,
  config: ClientConfig | Record<string, unknown>,
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(path, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

// Per-field overlay used to layer an explicit `--config <path>` file on top
// of the canonical config so operators can keep, say,
// `backends.claude.settings` in the canonical file while overriding just
// `server_url` + `server_token` via `--config`. Missing top-level keys in
// `top` fall through from `base`; everything `top` does set wins.
//
// `backends` gets a per-slot merge (claude / codex / openclaw) so that a
// `--config` containing only `backends.codex` doesn't wipe canonical
// `backends.claude` and `backends.openclaw`. Within each backend slot the
// override is still all-or-nothing — supplying `backends.claude.cwd`
// without `backends.claude.settings` keeps `cwd` from top and discards
// canonical `settings`, matching the documented "supplying any value
// replaces the default" semantics for backend config.
export function overlayConfig(base: ClientConfig, top: ClientConfig): ClientConfig {
  const mergedBackends: BackendConfigs | undefined =
    base.backends || top.backends
      ? { ...(base.backends ?? {}), ...(top.backends ?? {}) }
      : undefined;
  return {
    server_url: top.server_url ?? base.server_url,
    server_token: top.server_token ?? base.server_token,
    agent_id: top.agent_id ?? base.agent_id,
    backend: top.backend ?? base.backend,
    card: top.card ?? base.card,
    telemetry: top.telemetry ?? base.telemetry,
    backends: mergedBackends,
  };
}
