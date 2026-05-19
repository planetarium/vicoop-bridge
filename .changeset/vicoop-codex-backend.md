---
'@vicoop-bridge/client': minor
---

Add a new `vicoop-codex` bridge client backend that delegates each A2A
task to the local `vicoop-codex call` CLI (#225).

`--backend vicoop-codex` (or `"backend": "vicoop-codex"` in
`config.json`) is now a first-class backend kind alongside `echo`,
`openclaw`, `claude`, and `codex`. The backend reuses the existing
4-field openai-compat A2A extension schema
(`system` / `tools` / `tool_choice` / `tool_call_history`) — no new
metadata keys, CLI flags, or config knobs are introduced. The
canonical agent card is published on both the server and the client
(`packages/{server,client}/cards/vicoop-codex.json`) and the server
maps the new `backendKind` to it via `card-resolver.ts`.

Request mapping:

| A2A metadata (`OPENAI_COMPAT_EXTENSION_URI`) | `vicoop-codex call` body |
|---|---|
| `system`                | first entry of `messages` (role `system`) |
| `tool_call_history`     | replayed as `assistant` + `tool` messages in order |
| `message.parts` (text / data) | last entry of `messages` (role `user`) |
| `tools`                 | `tools` (verbatim) |
| `tool_choice`           | `tool_choice` (verbatim) |

Response mapping:

- `choices[0].message.content` → `task.artifact` (`text` part)
- `choices[0].message.tool_calls` → `task.artifact` (`data` part:
  `{ tool_calls: [...] }`, `extensions: [OPENAI_COMPAT_EXTENSION_URI]`)
- `task.complete.status.message.metadata[OPENAI_COMPAT_EXTENSION_URI]`
  carries `usage` (with `total = prompt + completion` enforced) plus a
  `chat_completion` echo (`id`, `object`, `created`, `model`,
  `choices`, `usage`).

Exit code → A2A error code:

| `vicoop-codex` exit | `task.fail.error.code` |
|---|---|
| `2` | `invalid_input` |
| `3` | `login_required` |
| `4` | `upstream_error` |
| `5` | `network_error` |
| other | `vicoop_codex_failed` |

Plus backend-internal codes: `empty_prompt`, `serialize_failed`,
`spawn_failed`, `parse_failed`.

The other backends are unchanged.
