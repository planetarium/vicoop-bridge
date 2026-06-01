---
'@vicoop-bridge/client': patch
---

Fix `agent callers list/remove <AGENT_ID>` failing to parse. The
sub-subcommands shared the literal names `list`/`remove` with the
top-level `agent list`/`agent remove` commands, and optique's
`longestMatch` resolved the tie in favour of the all-optional top-level
commands — dropping the `AGENT_ID` positional and erroring with
"Unexpected option or subcommand: <id>". Reordered the `agent` command
group so `callers` is matched first.
