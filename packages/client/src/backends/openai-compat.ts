// Shared wire-format types, parser, and renderers for the openai-compat
// A2A extension (planetarium/oai2a2a/extensions/openai-compat/v1).
//
// Every backend in this package (claude / codex / vicoop-codex / openclaw)
// consumes this extension off `Message.metadata[OPENAI_COMPAT_EXTENSION_URI]`,
// so the parsing/normalisation/rendering live here rather than in any one
// backend module. Backend-specific helpers (e.g. claude's native-MCP system
// prompt, codex's `thread/inject_items` mapping) stay in the respective
// backend file.

import { OPENAI_COMPAT_EXTENSION_URI, type Part } from '@vicoop-bridge/protocol';

// OpenAI content-part shapes carried in `user` / `assistant` `content` arrays.
// We only constrain the discriminator so the wire shape stays forward-compat
// with new content-part types (audio, file refs, …) added to OpenAI Chat
// Completions later — receivers MUST treat unknown `type` values as opaque
// and pass them through where the target model supports it.
export interface OpenAICompatTextPart {
  type: 'text';
  text: string;
}
export interface OpenAICompatImageUrlPart {
  type: 'image_url';
  image_url: { url: string; detail?: string };
}
export type OpenAICompatContentPart =
  | OpenAICompatTextPart
  | OpenAICompatImageUrlPart
  | { type: string; [key: string]: unknown };

// `user` / `assistant`-text `content` may be a plain string or an OpenAI
// content-part array (multimodal). `assistant`-with-`tool_calls` carries
// `content: null`; `tool` carries `content: string` (gateway normalises).
export type OpenAICompatMessageContent = string | OpenAICompatContentPart[];

// One entry of `chat_history`. Mirrors OpenAI Chat Completions `messages[]`
// shapes for prior conversation turns (everything except the trailing user
// turn, which rides through A2A `parts`).
export interface OpenAICompatHistoryUser {
  role: 'user';
  content: OpenAICompatMessageContent;
}
export interface OpenAICompatHistoryAssistantText {
  role: 'assistant';
  content: OpenAICompatMessageContent;
}
export interface OpenAICompatHistoryAssistantToolCalls {
  role: 'assistant';
  // OpenAI Chat Completions allows an assistant turn to carry BOTH text
  // content AND `tool_calls` (e.g. the model emits a brief explanation
  // before calling a function). On the wire `content` can therefore be
  // `null` / `""` (no text) OR a string / content-part array (text was
  // emitted). We normalise the no-text variants to `null` in the parser;
  // backends that re-emit the turn pass any text through as a separate
  // assistant message before the function_call items.
  content: OpenAICompatMessageContent | null;
  tool_calls: unknown[];
}
export interface OpenAICompatHistoryTool {
  role: 'tool';
  tool_call_id: string;
  name?: string;
  // OpenAI permits string-or-content-parts; on the wire we require string so
  // gateways own the normalisation. Bridges treat it as opaque text.
  content: string;
}
export type OpenAICompatHistoryEntry =
  | OpenAICompatHistoryUser
  | OpenAICompatHistoryAssistantText
  | OpenAICompatHistoryAssistantToolCalls
  | OpenAICompatHistoryTool;

// Decomposed view of the openai-compat A2A extension. The wire payload
// under `Message.metadata[OPENAI_COMPAT_EXTENSION_URI]` carries the
// *complete* OpenAI Chat Completions request body inside
// `chat_completions_request` (envelope contract, oai2a2a#80 symmetric
// envelope completion). This struct is the parser's decomposed view of
// that envelope — it splits the body into the four logical channels every
// backend in this package has historically consumed (system text, tools,
// tool_choice, prior conversation turns) so backend code does not have to
// re-walk `messages[]` itself. The decomposition is lossy by design (the
// gateway-internal `a2a` field is dropped, `system`/`developer` messages
// are concatenated, the trailing user turn is split off into A2A `parts`);
// for the raw envelope, read the metadata key directly.
export interface OpenAICompatMetadata {
  system?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  chat_history?: OpenAICompatHistoryEntry[];
}

// Top-level shape of the openai-compat extension wire payload. The full
// inbound OpenAI Chat Completions request body lives under
// `chat_completions_request` — forwarded verbatim by the gateway with at
// most codec-internal transport fields stripped.
//
// Spec: extensions/openai-compat/v1/README.md#request-metadata-payload-gateway--agent
export interface OpenAICompatRequestEnvelope {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  [key: string]: unknown;
}

// Validate a single content-part item from a `user` / `assistant` `content`
// array. Unknown `type` values pass through as opaque objects so future
// OpenAI content kinds parse cleanly even on bridges built before they
// existed; the target-model adapter is the one that decides whether to
// honour them.
function parseContentPart(raw: unknown): OpenAICompatContentPart | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.type !== 'string' || p.type.length === 0) return null;
  if (p.type === 'text') {
    if (typeof p.text !== 'string') return null;
    return { type: 'text', text: p.text };
  }
  if (p.type === 'image_url') {
    if (!p.image_url || typeof p.image_url !== 'object') return null;
    const iu = p.image_url as Record<string, unknown>;
    if (typeof iu.url !== 'string' || iu.url.length === 0) return null;
    const out: OpenAICompatImageUrlPart = {
      type: 'image_url',
      image_url: { url: iu.url },
    };
    if (typeof iu.detail === 'string') out.image_url.detail = iu.detail;
    return out;
  }
  // Forward-compat: keep unknown content-part types verbatim.
  return p as OpenAICompatContentPart;
}

// Accept string or array-of-content-parts for `user` / `assistant` content.
// Returns null when the shape is unusable (non-string, non-array, or array
// with any malformed entry) so the whole history parse fails fast — see
// parseChatHistory's strict-or-nothing rationale.
function parseUserOrAssistantContent(raw: unknown): OpenAICompatMessageContent | null {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return null;
  const parts: OpenAICompatContentPart[] = [];
  for (const p of raw) {
    const parsed = parseContentPart(p);
    if (!parsed) return null;
    parts.push(parsed);
  }
  return parts;
}


// True when the caller has supplied tool definitions AND has not explicitly
// disabled tool use (`tool_choice === "none"`). Backends consult this to
// decide whether to suppress agent-side built-in tools that would otherwise
// bypass the envelope-emit contract — see #175 for the codex case (built-in
// shell/exec executed `ls` directly instead of emitting a `tool_calls`
// envelope for the caller's `bash` definition) and #178 for the same
// pattern in claude (built-in Read/Glob/Bash served a `ls` request without
// surfacing the caller's `List`). The condition mirrors `hasTools` in
// `buildOpenAICompatSystemPrompt` so the gate that enables the envelope
// contract in the prompt is the same gate that disables the conflicting
// built-ins.
export function callerToolDispatchActive(meta: OpenAICompatMetadata | null): boolean {
  if (!meta) return false;
  if (meta.tools === undefined) return false;
  return meta.tool_choice !== 'none';
}

// Extract the openai-compat extension's request envelope verbatim. Reads
// `metadata[OPENAI_COMPAT_EXTENSION_URI].chat_completions_request` (the
// symmetric envelope contract — oai2a2a#80 — places the full inbound
// OpenAI Chat Completions request body there) and returns it without
// decomposition.
//
// This is the envelope-direct entry point used by backends migrating off
// `parseOpenAICompatMetadata`'s decomposed view (#302). Backends consume
// the envelope's fields directly (`model`, `tools`, `tool_choice`,
// `messages[]`) and reuse the exported projection helpers
// (`collectSystemFromMessages`, `chatHistoryFromMessages`) to derive the
// system text and the multi-turn replay block.
//
// Returns null when the envelope key is absent or malformed so callers
// can short-circuit before touching projection helpers.
export function parseOpenAICompatEnvelope(
  metadata: Record<string, unknown> | undefined,
): OpenAICompatRequestEnvelope | null {
  if (!metadata) return null;
  const raw = metadata[OPENAI_COMPAT_EXTENSION_URI];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const env = r.chat_completions_request;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  return env as OpenAICompatRequestEnvelope;
}

// Extract and shape-check the openai-compat extension metadata. Reads the
// `chat_completions_request` envelope (the symmetric envelope contract —
// oai2a2a#80 — places the full inbound OpenAI Chat Completions request
// body under that key) and decomposes it into the four logical channels
// every backend in this package consumes:
//
//   - `system`: concatenation of every `messages[i].role in {system,
//     developer}` entry's text content, `\n`-joined.
//   - `tools`: the envelope's `tools[]` verbatim (when non-empty).
//   - `tool_choice`: the envelope's `tool_choice` verbatim.
//   - `chat_history`: every non-system / non-developer entry of `messages[]`
//     *except* the trailing user turn (which rides A2A `parts` for
//     non-extension-aware consumers and is already in the envelope itself).
//
// Returns null when the envelope key is absent, malformed, or
// decomposes to no actionable content, so callers can branch on
// truthiness without per-field null checks.
export function parseOpenAICompatMetadata(
  metadata: Record<string, unknown> | undefined,
): OpenAICompatMetadata | null {
  if (!metadata) return null;
  const raw = metadata[OPENAI_COMPAT_EXTENSION_URI];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  // Envelope contract (oai2a2a#80 symmetric): the full inbound
  // ChatCompletionsRequest body lives under `chat_completions_request`.
  if (r.chat_completions_request && typeof r.chat_completions_request === 'object') {
    return parseEnvelope(r.chat_completions_request as OpenAICompatRequestEnvelope);
  }

  // Legacy / direct-decomposed shape: pre-envelope gateways and unit-test
  // fixtures place `{system, tools, tool_choice, chat_history}` directly
  // under the URI key. The parser still accepts this for transitional
  // compatibility — the envelope path above is the production wire shape.
  return parseLegacyDecomposed(r);
}

function parseEnvelope(envelope: OpenAICompatRequestEnvelope): OpenAICompatMetadata | null {
  const out: OpenAICompatMetadata = {};

  const system = collectSystemFromMessages(envelope.messages);
  if (system) out.system = system;

  if (Array.isArray(envelope.tools) && envelope.tools.length > 0) {
    out.tools = envelope.tools;
  }
  if (envelope.tool_choice !== undefined && envelope.tool_choice !== null) {
    out.tool_choice = envelope.tool_choice;
  }

  if (Array.isArray(envelope.messages)) {
    const history = chatHistoryFromMessages(envelope.messages);
    if (history) out.chat_history = history;
  }

  if (
    out.system === undefined &&
    out.tools === undefined &&
    out.tool_choice === undefined &&
    out.chat_history === undefined
  ) {
    return null;
  }
  return out;
}

function parseLegacyDecomposed(r: Record<string, unknown>): OpenAICompatMetadata | null {
  const out: OpenAICompatMetadata = {};
  if (typeof r.system === 'string' && r.system.length > 0) out.system = r.system;
  if (Array.isArray(r.tools) && r.tools.length > 0) out.tools = r.tools;
  if (r.tool_choice !== undefined && r.tool_choice !== null) out.tool_choice = r.tool_choice;
  if (Array.isArray(r.chat_history)) {
    const history = parseLegacyChatHistory(r.chat_history);
    if (history) out.chat_history = history;
  }
  if (
    out.system === undefined &&
    out.tools === undefined &&
    out.tool_choice === undefined &&
    out.chat_history === undefined
  ) {
    return null;
  }
  return out;
}

// Strict-or-nothing parser for the legacy `chat_history` field. Mirrors
// the pre-envelope gateway behaviour exactly (e.g. tool entries require
// `content` to be a plain string — no normalisation) — used only by the
// legacy shape path and existing test fixtures.
function parseLegacyChatHistory(raw: unknown[]): OpenAICompatHistoryEntry[] | null {
  if (raw.length === 0) return null;
  const out: OpenAICompatHistoryEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const e = entry as Record<string, unknown>;
    if (e.role === 'user') {
      const content = parseUserOrAssistantContent(e.content);
      if (content === null) return null;
      out.push({ role: 'user', content });
      continue;
    }
    if (e.role === 'assistant') {
      if (Array.isArray(e.tool_calls) && e.tool_calls.length > 0) {
        if (e.content === null || e.content === undefined || e.content === '') {
          out.push({ role: 'assistant', content: null, tool_calls: e.tool_calls });
          continue;
        }
        const content = parseUserOrAssistantContent(e.content);
        if (content === null) return null;
        out.push({ role: 'assistant', content, tool_calls: e.tool_calls });
        continue;
      }
      const content = parseUserOrAssistantContent(e.content);
      if (content === null) return null;
      out.push({ role: 'assistant', content });
      continue;
    }
    if (
      e.role === 'tool' &&
      typeof e.tool_call_id === 'string' &&
      e.tool_call_id.length > 0 &&
      typeof e.content === 'string'
    ) {
      const tool: OpenAICompatHistoryTool = {
        role: 'tool',
        tool_call_id: e.tool_call_id,
        content: e.content,
      };
      if (typeof e.name === 'string' && e.name.length > 0) tool.name = e.name;
      out.push(tool);
      continue;
    }
    return null;
  }
  return out;
}

// Concatenate every `system`/`developer` role entry's text content from
// the inbound OpenAI `messages[]`, joined with `\n`. Returns undefined
// when no such content exists (so callers can omit the system channel
// entirely instead of pushing an empty prompt).
//
// Accepts both string content and OpenAI content-part arrays (the
// `[{type:"text", text:"..."}, ...]` shape used by structured system
// prompts). Non-text parts (image_url etc.) in a system message are
// silently dropped — system channels are text-only on every supported
// backend.
export function collectSystemFromMessages(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const parts: string[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (e.role !== 'system' && e.role !== 'developer') continue;
    const content = e.content;
    if (typeof content === 'string') {
      if (content.trim()) parts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const item of content) {
        if (
          item &&
          typeof item === 'object' &&
          (item as { type?: unknown }).type === 'text' &&
          typeof (item as { text?: unknown }).text === 'string' &&
          (item as { text: string }).text.trim()
        ) {
          parts.push((item as { text: string }).text);
        }
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

// Convert the envelope's `messages[]` into the `chat_history` projection:
// every user/assistant/tool entry in original order, *except* the trailing
// user turn (it rides A2A `parts`; including it here would duplicate the
// turn against backends that prepend the formatted history to the parts
// text). System / developer entries are filtered out — they go through
// the `system` channel.
//
// Returns null when the projection is empty (e.g. a single-turn
// trailing-user-only request) so callers can omit history-replay code
// paths cleanly.
export function chatHistoryFromMessages(
  messages: unknown[],
): OpenAICompatHistoryEntry[] | null {
  // Find the index of the trailing user turn. Per spec it is split into
  // A2A `parts`, so we exclude it from the decomposed chat_history view.
  let trailingUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).role === 'user'
    ) {
      trailingUserIndex = i;
      break;
    }
    // Stop at the first non-trailing role — if the trailing entry isn't
    // a user (tool-continuation), the parts placeholder is empty and the
    // full conversation belongs in chat_history.
    break;
  }

  const out: OpenAICompatHistoryEntry[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (i === trailingUserIndex) continue;
    const entry = messages[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (e.role === 'system' || e.role === 'developer') continue;

    const parsed = parseHistoryEntry(e);
    if (!parsed) {
      // Strict-or-nothing: a single malformed history entry breaks the
      // ordering / id-pairing the model relies on, so drop the whole
      // history projection rather than silently skip the entry.
      return null;
    }
    out.push(parsed);
  }
  return out.length > 0 ? out : null;
}

// Parse a single envelope `messages[]` entry into the chat_history
// projection. Mirrors the historic on-wire shapes — string-or-content-part
// `content`, assistant with optional `tool_calls`, tool result strings —
// while normalising the no-text-with-tool_calls variants to `content: null`
// so downstream backends only have to handle one shape.
function parseHistoryEntry(e: Record<string, unknown>): OpenAICompatHistoryEntry | null {
  if (e.role === 'user') {
    const content = parseUserOrAssistantContent(e.content);
    if (content === null) return null;
    return { role: 'user', content };
  }
  if (e.role === 'assistant') {
    if (Array.isArray(e.tool_calls) && e.tool_calls.length > 0) {
      if (e.content === null || e.content === undefined || e.content === '') {
        return { role: 'assistant', content: null, tool_calls: e.tool_calls };
      }
      const content = parseUserOrAssistantContent(e.content);
      if (content === null) return null;
      return { role: 'assistant', content, tool_calls: e.tool_calls };
    }
    const content = parseUserOrAssistantContent(e.content);
    if (content === null) return null;
    return { role: 'assistant', content };
  }
  if (e.role === 'tool' && typeof e.tool_call_id === 'string' && e.tool_call_id.length > 0) {
    // OpenAI permits string or content-parts for tool result content; the
    // envelope forwards verbatim, so normalise here for backends that
    // assume a plain string.
    const content = normalizeToolResultContent(e.content);
    const tool: OpenAICompatHistoryTool = {
      role: 'tool',
      tool_call_id: e.tool_call_id,
      content,
    };
    if (typeof e.name === 'string' && e.name.length > 0) tool.name = e.name;
    return tool;
  }
  return null;
}

// Flatten an arbitrary tool-result `content` (string, content-parts, or
// raw object) into the plain string every backend expects. Mirrors the
// pre-envelope gateway behaviour so the parser can absorb any of the
// shapes OpenAI Chat Completions accepts.
function normalizeToolResultContent(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const sections: string[] = [];
    for (const item of raw) {
      if (item && typeof item === 'object' && 'text' in (item as Record<string, unknown>)) {
        const text = (item as { text?: unknown }).text;
        if (typeof text === 'string') sections.push(text);
        continue;
      }
      if (typeof item === 'string') sections.push(item);
    }
    return sections.join('\n');
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

// Translate an OpenAI `tool_choice` value into a one-line directive the
// model can act on. Recognises `"auto"` / `"required"` and the
// `{ type:"function", function:{ name } }` shape; unrecognised values
// return null so the caller drops the directive silently rather than
// confusing the model with a shape it can't parse.
//
// Exported so claude's native-MCP system prompt
// (`buildOpenAICompatNativeSystemPrompt`) can reuse the same wording as
// the envelope-contract prompt below — the wording is the model-facing
// contract and must not drift between paths.
export function describeToolChoice(toolChoice: unknown): string | null {
  if (toolChoice === undefined || toolChoice === null) return null;
  if (toolChoice === 'auto') {
    return 'tool_choice="auto": call a function only if appropriate; otherwise answer in natural language.';
  }
  if (toolChoice === 'required') {
    return 'tool_choice="required": you MUST emit a tool_calls envelope — answering in natural language is not allowed for this turn.';
  }
  if (typeof toolChoice === 'object' && !Array.isArray(toolChoice)) {
    const c = toolChoice as { type?: unknown; function?: unknown };
    if (c.type === 'function' && c.function && typeof c.function === 'object') {
      const fn = c.function as { name?: unknown };
      if (typeof fn.name === 'string' && fn.name.length > 0) {
        return `tool_choice: you MUST emit a tool_calls envelope that calls the function named "${fn.name}".`;
      }
    }
  }
  return null;
}

// Build the system-prompt text injected via `--append-system-prompt` when
// the openai-compat extension is active and the backend dispatches caller
// tools via the JSON-envelope contract (the openclaw path). claude's
// native-MCP dispatch path uses `buildOpenAICompatNativeSystemPrompt` in
// claude.ts instead.
//
// Composition rules:
//
//   - User-supplied `system` (if any) is included verbatim, first.
//   - The tool-envelope contract block is included only when `tools` were
//     provided and `tool_choice` is not "none" — without tools the envelope
//     would be a contract the model can't satisfy. With tool_choice="none"
//     we instead emit a short "do not use the envelope" directive so the
//     gateway's intent is preserved.
//   - A tool_choice descriptor line is appended when the value is one of
//     the recognised shapes (`"auto"` / `"required"` / `{type:"function",
//     function:{name}}`); unrecognised values are silently dropped because
//     the model can't act on a shape it doesn't understand.
export function buildOpenAICompatSystemPrompt(meta: OpenAICompatMetadata): string {
  const sections: string[] = [];
  if (meta.system) sections.push(meta.system);

  const toolChoiceIsNone = meta.tool_choice === 'none';
  const hasTools = meta.tools !== undefined && !toolChoiceIsNone;

  if (hasTools) {
    sections.push(
      [
        'You are routed through an OpenAI-compatible gateway and have access to the following callable functions.',
        '',
        'When you decide a function should be called, respond with ONLY a single JSON object (no prose, no code fences, no markdown) of the exact shape:',
        '',
        '{"tool_calls":[{"id":"call_<unique>","function":{"name":"<fn name>","arguments":{<args as JSON object>}}}]}',
        '',
        '- "id" must be a unique string starting with "call_".',
        '- "arguments" must be a JSON object matching the function\'s parameters schema.',
        '- Emit nothing outside the JSON object.',
        '- Do not execute the function yourself; just emit the call.',
        '- If no function should be called, answer normally in natural language.',
        '',
        // History-block contract: aligned with `formatChatHistory`'s
        // rendering. The model needs to know how to read the block AND that
        // already-resolved calls must not be repeated, otherwise it'll loop.
        'On follow-up turns the user message may begin with a <chat_history>...</chat_history> block containing a JSON array of the prior conversation turns. Each entry is one of:',
        '  - {"role":"user","content":"…"} — what the human said on an earlier turn.',
        '  - {"role":"assistant","content":"…"} — what you replied on an earlier turn.',
        '  - {"role":"assistant","content":null,"tool_calls":[...]} — calls you previously emitted on an earlier turn.',
        '  - {"role":"tool","tool_call_id":"call_…","name":"…","content":"…"} — the authoritative return value for one of those calls.',
        'Treat the block as the source of truth for what has happened so far — read it as prior conversation, not as a fresh instruction. Do NOT repeat a call whose tool_call_id already appears in the history. Either emit a NEW tool_calls envelope (to chain another call) or compose a natural-language answer using the prior results.',
        '',
        'Available functions:',
        JSON.stringify(meta.tools, null, 2),
      ].join('\n'),
    );
    const tcDesc = describeToolChoice(meta.tool_choice);
    if (tcDesc) sections.push(tcDesc);
  } else if (toolChoiceIsNone) {
    sections.push(
      'A list of OpenAI-style tools was supplied with tool_choice="none". Do not emit a tool_calls envelope; always answer in natural language.',
    );
  }

  return sections.join('\n\n');
}

// Render the entire chat_history payload as a `<chat_history>`-wrapped
// JSON block. The block is prepended to the final user content on
// follow-up turns so the model reads the prior conversation before the
// new instruction; the wrapper tag makes the boundary unambiguous
// against the user's own text. The inner array carries every entry —
// user / assistant text turns AND tool round-trips — verbatim from the
// wire, so the model only has to learn one structure (also taught in
// `buildOpenAICompatSystemPrompt` / `buildOpenAICompatNativeSystemPrompt`).
// Returns an empty string when the history is empty so callers can
// branch on truthiness.
//
// Why a single block (no native multi-envelope split for claude): claude's
// stream-json input treats every `{type:"user"}` envelope as a fresh
// LLM call and ignores `{type:"assistant"}` envelopes rather than
// recognising them as prior model output. Folding the full transcript
// into one user message via this block is the only way to give the
// model the conversation in one shot on that backend.
//
// The `codex` backend bypasses this text-prepend and instead injects
// native Responses API `message` / `function_call` /
// `function_call_output` items via `thread/inject_items` (see
// historyToInjectItems in codex.ts) — codex's session builder gives the
// model proper native conversation history rather than a JSON blob it
// has to be instructed to interpret. claude / openclaw use this
// textual form because their native channels do not accept
// out-of-band prior turns.
export function formatChatHistory(history: OpenAICompatHistoryEntry[]): string {
  if (history.length === 0) return '';
  return [
    '<chat_history>',
    JSON.stringify(history, null, 2),
    '</chat_history>',
  ].join('\n');
}

// Wire-level diagnostic dump for a single incoming A2A task. Gated by
// the `--openai-compat-trace` operator flag (see cli-args.ts). Emits to
// stderr to keep the trace separate from the bridge's structured stdout
// frames. Designed for paste-into-issue-report ergonomics: parts shape
// summary, metadata key list, then each chat_history entry on its own
// line (clipped to 500 chars per entry so a long tool result doesn't
// flood the operator's terminal).
//
// Lives in `openai-compat.ts` so every backend can share one canonical
// shape — operator support traffic stays grep-able against a single
// `[openai-compat trace]` prefix regardless of which backend handled
// the task.
//
// Intentionally tolerant: any exception inside the formatter swallows
// silently. A diagnostic that crashes the task path is worse than no
// diagnostic.
// Per-entry / per-part clip ceiling. Tool schemas and tool results can
// be large (thousands of chars); 500 keeps an operator's terminal
// scannable without losing the head of each item — enough to spot the
// shape regression that needs investigating.
const TRACE_ITEM_CLIP = 500;

export function dumpOpenAICompatTaskWire(
  backend: string,
  taskId: string,
  parts: readonly Part[] | undefined,
  metadata: Record<string, unknown> | undefined,
): void {
  try {
    // Derive the summary view from metadata in one place so backends never
    // pass a parsed projection — the parser+envelope helpers already cover
    // every shape (envelope contract + legacy decomposed) the dump cares
    // about. Keeps the trace one-line shape stable across backend migration.
    const parsed = parseOpenAICompatMetadata(metadata);
    const envelope = parseOpenAICompatEnvelope(metadata);
    const partsSummary = (parts ?? []).map((p) => {
      if (p.kind === 'text') return { kind: 'text', len: p.text.length };
      if (p.kind === 'file') return { kind: 'file', mime: p.file.mimeType };
      return { kind: 'data' };
    });
    const metaKeys = Object.keys(metadata ?? {});
    const oai = parsed
      ? {
          sys: !!parsed.system,
          tools: parsed.tools?.length ?? 0,
          tool_choice: parsed.tool_choice,
          hist: parsed.chat_history?.length ?? 0,
          // `model` is envelope-only — the legacy decomposed shape never
          // carried it, so it stays `undefined` for legacy-shape traces.
          model:
            envelope && typeof envelope.model === 'string' ? envelope.model : undefined,
        }
      : null;
    console.error(
      `[openai-compat trace] backend=${backend} taskId=${taskId} ` +
        `parts=${JSON.stringify(partsSummary)} ` +
        `metaKeys=${JSON.stringify(metaKeys)} ` +
        `parsed=${JSON.stringify(oai)}`,
    );

    // Tools[] — caller-side function schemas. Dump each entry as
    // `{name}: <clipped JSON>` so the operator can spot a missing /
    // mistyped tool without scrolling through a multi-line JSON dump.
    if (parsed?.tools && parsed.tools.length > 0) {
      console.error(
        `[openai-compat trace] tools (${parsed.tools.length} entries):`,
      );
      for (const [i, t] of parsed.tools.entries()) {
        const name =
          t && typeof t === 'object' && 'function' in t
            ? (t as { function?: { name?: unknown } }).function?.name
            : undefined;
        const label = typeof name === 'string' ? name : '<unnamed>';
        console.error(
          `  [${i}] ${label}: ${JSON.stringify(t).slice(0, TRACE_ITEM_CLIP)}`,
        );
      }
    }

    // Parts payload — the current turn's actual content (trailing user
    // text, data parts JSON, file part metadata). Useful for spotting
    // empty `parts: [{text:""}]` tool-continuation placeholders and
    // diff-ing what the caller actually asked vs. what the model saw.
    if (parts && parts.length > 0) {
      console.error(`[openai-compat trace] parts (${parts.length} entries):`);
      for (const [i, p] of parts.entries()) {
        if (p.kind === 'text') {
          console.error(
            `  [${i}] text: ${JSON.stringify(p.text).slice(0, TRACE_ITEM_CLIP)}`,
          );
        } else if (p.kind === 'data') {
          console.error(
            `  [${i}] data: ${JSON.stringify(p.data).slice(0, TRACE_ITEM_CLIP)}`,
          );
        } else {
          // file part — don't print bytes/base64; just shape.
          const f = p.file;
          const shape = {
            name: f.name,
            mimeType: f.mimeType,
            hasBytes: !!f.bytes,
            uri: f.uri,
          };
          console.error(`  [${i}] file: ${JSON.stringify(shape)}`);
        }
      }
    }

    // Raw envelope dump: surface the inbound conversation so operators can
    // diff what the gateway sent vs. what the backend ended up using. The
    // decomposed `parsed` view above already shows the chat_history
    // projection — this section is the raw shape pre-decomposition.
    //
    // Reads `chat_completions_request.messages[]` (envelope contract,
    // oai2a2a#80) when present; falls back to the legacy `chat_history`
    // shape so pre-envelope gateways still produce a useful trace.
    const ext = metadata?.[OPENAI_COMPAT_EXTENSION_URI];
    if (ext && typeof ext === 'object') {
      const env = (ext as Record<string, unknown>).chat_completions_request;
      if (env && typeof env === 'object') {
        const rawMessages = (env as Record<string, unknown>).messages;
        if (Array.isArray(rawMessages) && rawMessages.length > 0) {
          console.error(
            `[openai-compat trace] envelope.messages (${rawMessages.length} entries):`,
          );
          for (const [i, e] of rawMessages.entries()) {
            console.error(`  [${i}] ${JSON.stringify(e).slice(0, TRACE_ITEM_CLIP)}`);
          }
        }
      } else {
        const rawHist = (ext as Record<string, unknown>).chat_history;
        if (Array.isArray(rawHist) && rawHist.length > 0) {
          console.error(
            `[openai-compat trace] raw chat_history (${rawHist.length} entries):`,
          );
          for (const [i, e] of rawHist.entries()) {
            console.error(`  [${i}] ${JSON.stringify(e).slice(0, TRACE_ITEM_CLIP)}`);
          }
        }
      }
    }
  } catch {
    // Diagnostics must never crash the task.
  }
}

// Attempt to interpret an assistant message as the OpenAI tool-call envelope
// `buildOpenAICompatSystemPrompt` teaches the model to emit. Returns the
// parsed envelope verbatim (preserving unknown keys) when the trimmed text
// parses as a JSON object carrying a `tool_calls` array; otherwise null so
// the caller falls back to a text artifact. Strict: a leading non-`{`
// character (prose preamble, code fence, etc.) short-circuits without
// paying the JSON.parse.
export function tryParseToolCallsEnvelope(
  text: string,
): (Record<string, unknown> & { tool_calls: unknown[] }) | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.tool_calls)) return null;
  return obj as Record<string, unknown> & { tool_calls: unknown[] };
}
