---
"@vicoop-bridge/client": patch
---

Fix `start --detach` exiting immediately on the released (Bun-compiled) binary. The self re-exec reconstructed the child argv with `process.argv.slice(1)`, which on a Bun single-file executable includes the embedded `/$bunfs/…` virtual entry path — the relaunched daemon then parsed it as a subcommand (`Unexpected option or subcommand: /$bunfs/…`) and died. The reconstruction now drops the embedded entry for compiled binaries while keeping the script path for node, and is covered by tests against both argv shapes. Also drops a stray issue number from the `--detach` `--help` text.
