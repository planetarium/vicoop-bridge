---
'@vicoop-bridge/client': patch
---

Fix the `openai-compat/v1` `params.models` advertise (shipped in 0.23.0)
not reaching the hello frame from a `vicoop-client upgrade`-installed
release binary. The bundled card lookup did
`fileURLToPath(import.meta.url) + '..' + 'cards' + …` and then
`existsSync`. Under `tsx` (dev) or a Node-run `dist/cli.js` that path
resolves to a real file, but inside a `bun build --compile` single-file
binary `import.meta.url` points into Bun's virtual root — the file
doesn't exist on disk, `existsSync` returns false, the lookup returns
`null`, and `agentCard` ends up `undefined`. `Client.resolveEffectiveCard`
short-circuits before `backend.resolveCapabilities()` is even called,
the daemon ships hello with no inline card, and the server falls back
to its own canonical card which has no `params.models`. Symptom for
operators upgrading via `vicoop-client upgrade`: no model advertise
after relaunch, while `pnpm dev:client` (which runs from disk) worked.

Replace the fs-based lookup with static JSON imports of the five
bundled cards (`claude` / `codex` / `echo` / `openclaw` /
`vicoop-codex`) — Bun's `--compile` embeds statically imported JSON
into the binary, so dev and release paths converge. Operator-supplied
`--card <path>` stays fs-based.
