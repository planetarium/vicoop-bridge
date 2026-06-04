---
"@vicoop-bridge/client": minor
---

Cut claude-backend openai-compat per-request token/cost. These turns are stateless (a fresh claude session each request), so any fixed prefix is re-paid every time. We now: replace claude's default coding-agent prompt with a slim per-request `--system-prompt` (also more correct for a chat/completions proxy), drop the skills catalogue (`--disable-slash-commands`), spawn in an isolated empty cwd so no operator `CLAUDE.md` / project settings / hooks load, and opt these spawns into Anthropic's 1-hour prompt cache so the byte-stable system+tools prefix survives multi-minute gaps between turns. Scoped to openai-compat tasks; plain A2A tasks are unchanged.
