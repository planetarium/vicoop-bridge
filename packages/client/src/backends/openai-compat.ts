// Shared wire-format types, parser, and renderers for the openai-compat
// A2A extension (planetarium/oai2a2a/extensions/openai-compat/v1).
//
// Every backend in this package (claude / codex / vicoop-codex / openclaw)
// consumes this extension off `Message.metadata[OPENAI_COMPAT_EXTENSION_URI]`,
// so the parsing/normalisation/rendering live here rather than in any one
// backend module. Backend-specific helpers (e.g. claude's native-MCP system
// prompt, codex's `thread/inject_items` mapping) stay in the respective
// backend file.

import { OPENAI_COMPAT_EXTENSION_URI } from '@vicoop-bridge/protocol';

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

// Payload of the openai-compat A2A extension as carried under
// `Message.metadata[OPENAI_COMPAT_EXTENSION_URI]`. Each field is optional and
// is forwarded verbatim from the OpenAI-shaped originating request.
export interface OpenAICompatMetadata {
  system?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  chat_history?: OpenAICompatHistoryEntry[];
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

// Whole-array validator for `chat_history`. Returns null (caller drops the
// field) on ANY malformed entry rather than skipping it — order and
// id-pairings between `assistant.tool_calls` and `role:"tool"` results
// matter, so dropping a middle entry would silently break the model's view
// of the prior conversation. Strict-or-nothing is safer than
// forgiving-with-holes.
function parseChatHistory(raw: unknown[]): OpenAICompatHistoryEntry[] | null {
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
      // Discriminate by `tool_calls` presence: assistant turns may be
      // plain text, a pure tool-call envelope, or a hybrid (text +
      // tool_calls — the model emits a brief explanation before
      // calling). All three shapes are valid OpenAI Chat Completions.
      if (Array.isArray(e.tool_calls) && e.tool_calls.length > 0) {
        // No-text variants (`null` / missing field / `""`) normalise to
        // `null`. Any other shape is parsed as message content and
        // preserved alongside the tool_calls so downstream backends can
        // re-emit the explanation before the function calls.
        if (
          e.content === null ||
          e.content === undefined ||
          e.content === ''
        ) {
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
      const toolEntry: OpenAICompatHistoryTool = {
        role: 'tool',
        tool_call_id: e.tool_call_id,
        content: e.content,
      };
      if (typeof e.name === 'string' && e.name.length > 0) toolEntry.name = e.name;
      out.push(toolEntry);
      continue;
    }
    return null;
  }
  return out;
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

// Extract and shape-check the openai-compat metadata key. Returns null when
// the metadata key is absent, malformed, or actionably empty (all four
// fields missing or trivial) so the caller can fall back to its non-extension
// path without conditional null-checks on every read.
export function parseOpenAICompatMetadata(
  metadata: Record<string, unknown> | undefined,
): OpenAICompatMetadata | null {
  if (!metadata) return null;
  const raw = metadata[OPENAI_COMPAT_EXTENSION_URI];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: OpenAICompatMetadata = {};
  if (typeof r.system === 'string' && r.system.length > 0) out.system = r.system;
  if (Array.isArray(r.tools) && r.tools.length > 0) out.tools = r.tools;
  if (r.tool_choice !== undefined && r.tool_choice !== null) out.tool_choice = r.tool_choice;
  if (Array.isArray(r.chat_history)) {
    const history = parseChatHistory(r.chat_history);
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
