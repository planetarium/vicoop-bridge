---
"@vicoop-bridge/client": minor
---

Keep Codex external-runtime OpenAI API keys and ChatGPT credentials on the host, authenticating each execution through the built-in OpenAI provider with an ephemeral login instead of credential files or token environment variables. Require Codex 0.153.4 or newer and explicit migration of existing credential-mounted runtimes; remove the obsolete container credential-copy and login paths. Wait for execution cleanup before completing or resuming tasks, and preserve forked harness files in persistent runtime storage. Validate reused runtimes before harness injection and correct daemon startup instructions. Host execution and bundled-direct behavior are unchanged.
