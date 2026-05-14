---
"@vicoop-bridge/client": minor
---

Add an opt-in `openaiCompatAgent` / `backends.openclaw.openai_compat_agent` / `OPENCLAW_OAI_COMPAT_AGENT` option that routes tasks carrying the openai-compat extension metadata to a secondary OpenClaw agent name (encoded in the `chat.send.sessionKey` `agent:<name>:<contextId>` prefix), instead of the default `agent`. The operator pairs this with an `agents.list` entry in the OpenClaw gateway config whose `tools.deny=["*"]` disables the host model's native tools (Bash, browser, weather skills, etc.) so the model has no in-host alternative to the envelope contract.

Motivation: the text-injected envelope contract competes with whatever native tools the host agent advertises in its own system prompt. When both are present, the model frequently satisfies the request with a native skill (Bash + wttr.in, browser, etc.) and ignores the envelope-emit directive. Pilot measurement on anthropic `claude-sonnet-4-6` (`N=10` per arm) on a tool-call-prone weather prompt: envelope compliance was 5/10 with the default `main` agent (full tools), 10/10 when the same request was routed to an `oai` agent configured with `tools.profile=minimal` + `tools.deny=["*"]`. Non-extension tasks continue to flow through the default `agent`, so the split is invisible to callers that don't request the extension.

When the option is unset (default), all tasks — extension or not — use the single configured `agent`, preserving today's behavior.
