---
"@vicoop-bridge/client": patch
---

Fix the claude backend under-advertising `contextWindow` for models that run 1M by default. The tier correction capped every bare-advertised id at the 200k base, but `claude-fable-5` runs the full 1M window bare in Claude Code (Anthropic documents it as 1M-by-default with no `[1m]` variant), so it was advertised at 200k instead of 1M. Bare-advertised `claude-fable-5` now uses its Models-API ceiling; models where 1M is an opt-in `[1m]` tier (Opus 4.x, Sonnet 4.6) keep the 200k-unless-`[1m]` behavior. The 1M-default classification is a small explicit set (currently just `claude-fable-5`) because there is no reliable runtime signal to tell a 1M-default model from a 1M-opt-in one; a model is added only once released and confirmed, so a 200k-default or not-yet-shipped model is never over-advertised.
