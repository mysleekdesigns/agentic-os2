---
description: Show details of an Agent OS memory entry by id or scope:key
---

Run the Agent OS CLI command `agent-os memory show <id-or-scope:key>` from the repository root, substituting the argument with the memory id or `scope:key` shorthand the user provided. Render the memory row and its current value to the user. Forward any additional flags (such as `--json`) verbatim. Use this when the user asks to "show memory <ref>", "open memory entry", or "what's in memory X".
