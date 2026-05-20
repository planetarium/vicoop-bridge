---
'@vicoop-bridge/client': patch
---

claude backend: namespace internal MCP server registration keys under a
`_vb-` ("vicoop-bridge") prefix so they cannot collide with
operator-supplied servers under the same `--mcp-config` map.

The previous keys were generic enough to clash with operator names —
`caller-tools` in particular looks like something an operator might
name their own MCP server, and claude's `--mcp-config` JSON resolves
collisions last-wins, silently overwriting the bridge's entry.

Renames:

- `vicoop-bridge` → `_vb-send-file`
- `caller-tools` → `_vb-caller-tools`

Resulting model-visible tool ids change accordingly
(`mcp___vb-send-file__send_file`, `mcp___vb-caller-tools__<tool>`); the
bridge's own `--allowedTools` argv is generated from the same map so it
tracks automatically. No A2A wire change.

The merger of the two servers under a single namespace is tracked
separately and naturally lands at `_vb` once #216 (long-lived listener
for caller-tools) ships.
