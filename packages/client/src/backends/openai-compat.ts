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
//
// Takes the envelope's `tools` and `tool_choice` directly so callers in the
// envelope-direct migration (#302) don't have to go through the decomposed
// metadata view.
export function callerToolDispatchActive(
  tools: unknown,
  toolChoice: unknown,
): boolean {
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return toolChoice !== 'none';
}

// Extract the openai-compat extension's request envelope verbatim. Reads
// `metadata[OPENAI_COMPAT_EXTENSION_URI].chat_completions_request` (the
// symmetric envelope contract — oai2a2a#80 — places the full inbound
// OpenAI Chat Completions request body there) and returns it without
// decomposition.
//
// Backends consume the envelope's fields directly (`model`, `tools`,
// `tool_choice`, `messages[]`) and reuse the exported projection helpers
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
export function buildOpenAICompatSystemPrompt(
  system: string | undefined,
  tools: unknown,
  toolChoice: unknown,
): string {
  const sections: string[] = [];
  if (system) sections.push(system);

  const toolChoiceIsNone = toolChoice === 'none';
  const hasTools = Array.isArray(tools) && tools.length > 0 && !toolChoiceIsNone;

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
        JSON.stringify(tools, null, 2),
      ].join('\n'),
    );
    const tcDesc = describeToolChoice(toolChoice);
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

// Return a copy of `history` with every caller-tool reference renamed via
// `rename`. Touches the `function.name` on each `assistant.tool_calls[]`
// entry and the `name` on each `tool` result entry; everything else passes
// through unchanged (and unknown `tool_calls[]` item shapes are left intact).
//
// Why this exists: the wire history records each prior tool call by the
// caller's bare OpenAI function name (e.g. `read`), but a backend whose live
// tool surface exposes caller tools under a transport-specific id (claude's
// native MCP dispatch registers them as `mcp___vb-caller-tools__<name>`) needs
// the replayed history to use that id too. Replaying the bare names conditions
// the model to re-emit them; the backend then has no such tool and rejects the
// call ("No such tool available: read"), the call never reaches the capture
// path, the model retries, and the run dies at its turn cap. `rename` receives
// the wire name and returns the backend id — return the input unchanged to
// leave a name alone (e.g. names that aren't registered caller tools).
export function requalifyHistoryToolNames(
  history: OpenAICompatHistoryEntry[],
  rename: (name: string) => string,
): OpenAICompatHistoryEntry[] {
  return history.map((entry) => {
    if (
      entry.role === 'assistant' &&
      'tool_calls' in entry &&
      Array.isArray(entry.tool_calls)
    ) {
      return {
        ...entry,
        tool_calls: entry.tool_calls.map((call) => {
          if (!call || typeof call !== 'object') return call;
          const fn = (call as { function?: unknown }).function;
          if (!fn || typeof fn !== 'object') return call;
          const name = (fn as { name?: unknown }).name;
          if (typeof name !== 'string') return call;
          return { ...call, function: { ...(fn as object), name: rename(name) } };
        }),
      };
    }
    if (entry.role === 'tool' && typeof entry.name === 'string') {
      return { ...entry, name: rename(entry.name) };
    }
    return entry;
  });
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
    // Derive the summary view from the envelope in one place so backends
    // never pass a parsed projection. The trace one-line shape is stable
    // across backend migration; absent / malformed metadata produces
    // `parsed=null` for the operator's quick at-a-glance check.
    const envelope = parseOpenAICompatEnvelope(metadata);
    const partsSummary = (parts ?? []).map((p) => {
      if (p.kind === 'text') return { kind: 'text', len: p.text.length };
      if (p.kind === 'file') return { kind: 'file', mime: p.file.mimeType };
      return { kind: 'data' };
    });
    const metaKeys = Object.keys(metadata ?? {});
    const envelopeTools =
      envelope && Array.isArray(envelope.tools) ? envelope.tools : undefined;
    const envelopeSystem = envelope ? collectSystemFromMessages(envelope.messages) : undefined;
    const envelopeHistory =
      envelope && Array.isArray(envelope.messages)
        ? chatHistoryFromMessages(envelope.messages)
        : null;
    const oai = envelope
      ? {
          sys: !!envelopeSystem,
          tools: envelopeTools?.length ?? 0,
          tool_choice: envelope.tool_choice,
          hist: envelopeHistory?.length ?? 0,
          model: typeof envelope.model === 'string' ? envelope.model : undefined,
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
    if (envelopeTools && envelopeTools.length > 0) {
      console.error(
        `[openai-compat trace] tools (${envelopeTools.length} entries):`,
      );
      for (const [i, t] of envelopeTools.entries()) {
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
    // `parsed` summary above already shows the chat_history projection —
    // this section is the raw shape pre-decomposition.
    if (envelope && Array.isArray(envelope.messages) && envelope.messages.length > 0) {
      console.error(
        `[openai-compat trace] envelope.messages (${envelope.messages.length} entries):`,
      );
      for (const [i, e] of envelope.messages.entries()) {
        console.error(`  [${i}] ${JSON.stringify(e).slice(0, TRACE_ITEM_CLIP)}`);
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
