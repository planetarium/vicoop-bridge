---
'@vicoop-bridge/client': patch
---

claude: log a caller-tool turn that completes without emitting any tool call

Under caller-tool dispatch the bridge runs `--max-turns 1`: the model gets one
turn, its calls are captured, and the caller executes them and returns results
next turn. A turn that ends having emitted no tool calls hands the caller
nothing to run. That is correct when the text was a final answer or a completion
report, and a silent dead end when it was an announcement of work about to be
done — the model says it will do something, the run ends, and the user sees an
agent that stopped mid-task.

The dead-end case has been observed on `claude-fable-5` (#441), where it costs a
user-visible stall or a full sub-agent restart. It is invisible today: the task
completes normally with `artifacts=1` and nothing distinguishes it in the logs.

This logs every such turn at `info` without trying to tell the two apart. Both
renderings seen so far differ completely — one serialized the call as
`**todowrite**` + `Request` + a fenced block, the other as a bare `Read`
followed by JSON — so a text matcher tuned on either keeps missing the other,
and a classifier built on the two sessions observed so far would be overfit.
Measuring the rate comes first. The line carries `taskId` for joining to the
session transcript and `textLen` as the one cheap signal separating a 72-char
"I'll start now" from a 4957-char final report, without copying model output
into the logs.

The line's `textLen` is resolved through a small `resolveTurnText` helper rather
than inline, because the rule is `||` and not `??`: a `result` event routinely
carries `result: ""` on a turn that spent itself on tool calls, and `??` would
keep that empty string instead of falling back to the text the model streamed —
reporting an empty turn and discarding the one signal that separates a
short announcement from a long final report.
