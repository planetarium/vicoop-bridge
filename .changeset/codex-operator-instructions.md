---
"@vicoop-bridge/client": minor
---

Support caller-runtime operatorInstructions for Codex and Claude, accept systemPrompt as a compatibility alias, and prevent reuse of Codex threads with stale developer instructions. Keep caller-supplied OpenAI-compatible instructions at user priority when operator instructions are configured. Document restart behavior and migration without resetting caller storage or grants.
