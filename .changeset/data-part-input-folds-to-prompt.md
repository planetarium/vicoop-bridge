---
"@vicoop-bridge/client": patch
---

Accept A2A `data` parts on the `codex`, `claude`, and `openclaw` backends (#150). Previously, a task whose message included an `application/json` data part alongside the user text failed immediately with `unsupported_part_kind` (claude/codex) or `unsupported_data_part` (openclaw), surprising callers that attach structured metadata as auxiliary context.

The three backends now serialize each `DataPart.data` into a deterministic, grep-friendly block that is folded into the prompt the LLM sees:

```
<context kind="application/json">
{ ...JSON.stringify(data, null, 2)... }
</context>
```

For codex/openclaw the block is appended to the prompt text (after any text parts); for claude it is emitted as an additional `type: 'text'` content block following the primary text. Mixed `text+data`, `data`-only, and `text+data+file` messages are all accepted; only a fully empty message still fails with `empty_prompt`. The canonical server agent cards for `codex`, `claude`, and `openclaw` now advertise `application/json` in `defaultInputModes` so callers can discover the capability from the card.
