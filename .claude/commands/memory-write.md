---
description: Write (create or update) an Agent OS memory entry
---

Run the Agent OS CLI command `agent-os memory write <scope> <key>` from the repository root, substituting `<scope>` and `<key>` with the values the user supplied. Forward optional flags verbatim: `--value <text>` (inline), `--file <path>` (read from disk), `--note <text>` (required when updating an existing entry — explain this if the user is missing it), `--agent-id <id>` (enforce per-agent memory.write policy), and `--overwrite` (admin bypass; warn the user before using). If the user pipes content via stdin, run the command without `--value`/`--file` so stdin is consumed. Use this when the user asks to "save a memory", "write to memory", "remember X for later", or similar.
