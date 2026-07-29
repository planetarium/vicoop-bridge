---
'@vicoop-bridge/client': patch
---

claude: optionally retry a caller-tool turn that described its tool call instead of making one

Under caller-tool dispatch the bridge runs `--max-turns 1`, so a turn that ends
having emitted no tool call leaves the caller nothing to execute and the run is
over. `claude-fable-5` sometimes writes the call out as prose and stops — the
user sees an agent that announced work and then quit. Seen in 4 of 53 observed turns (~7.5%), costing either a
user-visible stall or a full sub-agent restart. The rate is noisy — 3 of 22
across two days of real use, 1 of 5 in a faithful synthetic repro, then 0 of 20
on a later run of that same repro — so treat it as an order of magnitude, not a
figure.

With `--claude-retry-narrated-tool-call` (or `backends.claude.retry_narrated_tool_call`)
the bridge resumes the session once with a short corrective instruction, so the
call actually runs. **Off by default**, because it spends an extra turn whenever
it fires and the detection is a heuristic: the turn completed, emitted zero tool
calls, and its text names one of the tools registered for that task. That is
tuned for precision — across the observed population it catches 3 of 4 known
stalls and leaves all 7 legitimate tool-less turns (complete inline deliverables,
sub-agent completion reports) untouched. The retry happens at most once; a model
that narrates twice will not be argued out of it.

The narrated text has already streamed to the caller and cannot be recalled, so
the caller sees prose followed by the real tool calls — the same trade-off
already accepted for pre-tool-call preamble.
