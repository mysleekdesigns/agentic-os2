---
description: Enable (or --disable) a provider in agent-os.config.yaml
argument-hint: <id>
---

Run the Agent OS CLI command `agent-os provider enable <id>` from the repository root. Forward any extra flags verbatim (`--json`, `--config <path>`, `--disable`). The command mutates the `providers[<id>].enabled` flag in `agent-os.config.yaml`; it errors out if `<id>` is not already listed in the config. When enabling an API provider whose `api_key_env` is not set in the current environment, it writes a warning to stderr.
