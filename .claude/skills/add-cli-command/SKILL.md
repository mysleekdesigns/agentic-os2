---
name: add-cli-command
description: Scaffold a new agent-os CLI subcommand using Commander.js. Trigger when the user asks to "add a CLI command", "wire up a command for X", "add `agent-os foo`", or invokes /add-cli-command. Creates the command file under src/cli/commands/, wires it into src/cli/index.ts, adds --json output support, generates a slash-command wrapper under .claude/commands/, and writes a vitest spec. Targets PRD Phase 10.
---

# add-cli-command — Commander.js subcommand scaffold

You scaffold a new subcommand for the `agent-os` CLI. The CLI uses **Commander.js** (see `package.json` dependency) and follows the conventions in **PRD Phase 10**.

## Hard rules

- Every command supports `--json` for programmatic use (PRD Phase 10: "Friendly TTY output + --json everywhere").
- Every command has at least one Vitest spec under `tests/cli/`.
- Commands that perform risky actions (writes, network calls, deletions) must declare them and route through the approval engine when it exists — never bypass.
- New commands are top-level only if they correspond to a top-level subsystem listed in PRD Phase 10. Otherwise nest them under an existing namespace (`agent`, `workflow`, `approvals`, `memory`, `tools`, `eval`, `provider`).

## Procedure

### Step 1 — Confirm the command shape

From the user request, extract:
- **command path**: e.g. `agent-os workflow run <id>` or `agent-os doctor`
- **arguments / flags**: positional args + named flags
- **side effects**: read-only? writes files? network? approval-gated?
- **output**: human-readable lines, table, or JSON object

Restate in one sentence: "Adding `agent-os <path> [args]` — does X, writes to Y."

### Step 2 — Create the command file

File: `src/cli/commands/<namespace>/<verb>.ts` (or `src/cli/commands/<verb>.ts` if top-level).

Skeleton:

```ts
import { Command } from 'commander';

export function register<Verb>Command(parent: Command): void {
  parent
    .command('<verb>')
    .description('<one-line description>')
    .argument('<required-arg>', '<arg description>')
    .option('--json', 'output JSON')
    .option('--<flag>', '<flag description>')
    .action(async (arg, opts) => {
      // 1. Load config
      // 2. Do the work (delegate to src/core/<subsystem>)
      // 3. If opts.json, print JSON.stringify(result); else pretty-print
      // 4. Set exit code: 0 on success, 1 on user error, 2 on system error
    });
}
```

Implementation rules:
- Keep the command file under 80 lines. Delegate to `src/core/<subsystem>/` for the actual work.
- Use the typed `Config` from `src/config/index.ts`. Don't read `agent-os.config.yaml` directly here.
- Errors: throw, don't `process.exit`. The top-level CLI catches and translates.
- Logs go through the observability layer when it exists (Phase 8); until then, `console.log` is fine.

### Step 3 — Wire into the CLI entrypoint

Edit `src/cli/index.ts`:
- Import the new `register<Verb>Command`.
- If top-level: call it on the root program.
- If nested: ensure the namespace subcommand exists (`agent`, `workflow`, etc.) and call it on that subcommand. Create the namespace if needed (mirror the existing pattern).

### Step 4 — Vitest spec

File: `tests/cli/<verb>.test.ts`.

Cover:
- `--help` lists the command (smoke).
- The command runs successfully on a known input and prints the expected output.
- `--json` produces parseable JSON with the expected shape.
- Exit code is correct on the error path.

Use `tsx` or the compiled `dist/cli/index.js` to invoke the CLI; mirror the existing `tests/cli.test.ts` pattern.

### Step 5 — Slash-command wrapper (PRD Phase 10)

File: `.claude/commands/<short-slug>.md`.

Skeleton:

```md
---
description: <one-line description of what the slash command does>
---

Run `agent-os <full command>` with the user-provided arguments and return the output.
```

This lets the user invoke the CLI from inside a Claude Code conversation as `/<slug>`.

### Step 6 — Hand off

Print a 5-line summary:
- Command file: `src/cli/commands/.../<verb>.ts`
- Wired in: `src/cli/index.ts`
- Test: `tests/cli/<verb>.test.ts`
- Slash: `.claude/commands/<slug>.md`
- Run it: `tsx src/cli/index.ts <command>` or after build `agent-os <command>`

Recommend running `npm test` and `npm run typecheck` before committing.

## What this skill does not do

- It does NOT add new dependencies. If Commander.js is missing, stop and ask.
- It does NOT modify `agent-os.config.yaml` schema. Config additions are a separate skill.
- It does NOT run the new command.
