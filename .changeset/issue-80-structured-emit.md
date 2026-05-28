---
"@vicoop-bridge/client": minor
---

Align with the **structured-field contract** for the `openai-compat/v1` A2A extension (companion to planetarium/oai2a2a#80 / planetarium/oai2a2a#82).

**Wire-breaking** for advertising agents (client major bump expected once the project crosses 1.0; using minor under the 0.x convention).

**Alternative design to the envelope variant** (planetarium/vicoop-bridge#297). Only one of the two PR pairs lands.

codex backend now emits `metadata[URI].{tool_calls, finish_reason}` on the terminal A2A status message — first-class structured fields rather than an envelope mirror. Streaming tool_calls flow only through the terminal status event; the per-artifact delta emit is removed. Content stays in A2A `artifact.parts[].text` (native A2A channel).

The codec on the gateway side (companion PR planetarium/oai2a2a#82) reads these structured fields and translates them into the OpenAI ChatCompletion response shape.

Out of scope: `claude.ts`, `openclaw.ts`, and `vicoop-codex.ts` backend migrations to the structured emit — same migration pattern, deferred to a follow-up should this design land. Card description updates for the codex backend included.
