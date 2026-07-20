---
'@vicoop-bridge/client': patch
---

claude: discourage the pre-tool-call preamble on openai-compat turns. Tool-enabled requests now teach the model that a tool-call turn is the tool call alone, so it stops prefixing "I'll now fetch that URL…" narration to its `tool_use` blocks. Genuine natural-language answers are unaffected.
