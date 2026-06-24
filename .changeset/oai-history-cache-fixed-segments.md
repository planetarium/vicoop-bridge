---
'@vicoop-bridge/client': patch
---

fix(client): fixed-segment splitting for openai-compat history cache

The default-on history cache (#372) emitted the frozen prefix as a **single
growing block** with one `cache_control` breakpoint. When the conversation
advances a turn the block's bytes change, and because Anthropic's cache matches
at *block boundaries* (read-lookback walks back up to 20 blocks), there is no
boundary at the previous turn's freeze point — so the lookback only re-matches
at the stable system+tools boundary and the **entire history is re-created every
forward turn**.

A controlled fresh-data A/B (no pre-warm) confirmed this and corrected the #372
"caching already works" reading, which had measured pre-warmed cache from
repeated deterministic runs:

| rollover turn (200→210 entries) | non_cached (≈creation) | cache_read |
|---|---:|---:|
| single growing block (before) | 220,929 | 0 |
| fixed segments (after) | 16,013 | 180,468 |

`formatChatHistoryBlocks` now serializes the frozen prefix as **one block per
`FREEZE_STEP_ENTRIES` entries at absolute boundaries** (so older segments never
re-flow), with `cache_control` on **only the last complete segment**. On a
rollover the new breakpoint's read-lookback finds the prior turn's entry one
block back at the previous segment boundary and reads the whole frozen prefix,
re-creating only the new segment + tail — i.e. creation becomes O(step) per turn
instead of O(full history). Validated at production depth (20 segments): the
lookback match is always one block back, well within the 20-block window.

This is what the rolling-anchor approach was reaching for, but it uses **one**
breakpoint (reads ride the lookback, not a second explicit anchor) → claude's
system+tools+1 plus this one = 4, fitting Anthropic's budget. That is why the
rolling-anchor patch tripped `400 maximum of 4 blocks` and this does not. The
concatenated text the model reads is byte-identical
(`serialize(a) + ",\n" + serialize(b) == serialize(a ++ b)`); the existing latch
still falls back to the unsplit block if a breakpoint is ever rejected.
