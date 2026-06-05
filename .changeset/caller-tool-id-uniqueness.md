---
"@vicoop-bridge/client": patch
---

claude backend: mint a conversation-unique `call_<uuid>` for each
caller-tool invocation instead of reusing the MCP JSON-RPC request id.
The request id only counts within a single MCP session, and the bridge
stands up a fresh MCP server per A2A turn, so it reset every turn —
every single-call turn emitted `tool_call_id` "2". Once the OpenAI loop
replayed the accumulated history those duplicate ids collided, breaking
the call↔result pairing and making the model restate its whole plan
before each tool call.
