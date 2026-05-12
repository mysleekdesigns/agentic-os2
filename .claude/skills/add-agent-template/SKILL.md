---
name: add-agent-template
description: Scaffold a new agent definition for the Agent OS registry. Trigger when the user asks to "create a new agent", "add an agent template", "add an agent for X", or invokes /add-agent-template. Generates agents/<id>.md (canonical) with YAML frontmatter matching PRD §2.6 (id, name, version, role, provider, model, tools.allowed, tools.approval_required, permissions, memory, eval), writes the instruction body, mirrors the file into .claude/agents/ for Claude Code's native subagent loader, and creates a starter eval fixture.
---

# add-agent-template — new agent scaffold

You create a new agent definition for the Agent OS project, following the canonical shape in **PRD §2.6** and the registry/mirror behavior in **PRD Phase 2**.

## Hard rules

- The canonical file lives at `agents/<id>.md`. A mirror copy lives at `.claude/agents/<id>.md` so Claude Code's native subagent loader picks it up (PRD Phase 2: "Mirror agent files into .claude/agents/").
- Both files must stay in sync. After authoring the canonical file, copy it to the mirror path.
- Default `provider: claude_code_local` (PRD §2.2 priority order) so the agent works with no API key.
- Default tool policy is **deny-by-default** (PRD §1.7 / §2.5). Only list tools the agent actually needs.
- Tag every tool the agent might use by risk: `read | write | network | shell | destructive`. Anything `write|network|shell` goes under `tools.approval_required`, not `tools.allowed`.

## Procedure

### Step 1 — Gather scope

From the user request, extract:
- **id**: kebab_case_id (e.g. `code_reviewer`, `release_notes_writer`)
- **role**: one-sentence description of what the agent does
- **tools needed**: which MCP tools, fs read/write, shell, network calls
- **memory scopes**: read from which, write to which

If anything is ambiguous, make the reasonable call from the role description and proceed.

### Step 2 — Author the canonical file

Write `agents/<id>.md` with this exact frontmatter shape (PRD §2.6):

```yaml
---
id: <id>
name: <Title Case Name>
version: 1
role: <one-line role>
provider: claude_code_local
model: <opus|sonnet|haiku — pick by task complexity>
tools:
  allowed:
    - mcp.<server>.<tool>       # read-only tools only
    - fs.read
  approval_required:
    - fs.write                  # only if the agent writes files
    - mcp.<server>.<write_tool>
permissions:
  network: <allow|approval_required|deny>
  file_read: <allow|approval_required|deny>
  file_write: <allow|approval_required|deny>
  shell: <deny by default>
memory:
  read:  [project, user_preferences]
  write: [<scope_name>]         # named per-agent scope, e.g. research_notes
eval:
  fixtures: evals/fixtures/<id>/*.yaml
  success_criteria:
    - <criterion 1>
    - <criterion 2>
    - <criterion 3>
---
```

Below the frontmatter, write the instruction body in plain markdown. Sections to include:

- `# Instructions` — what the agent should do, in plain prose
- `## Inputs you can expect` — the kinds of prompts that trigger this agent
- `## Procedure` — numbered steps
- `## Output format` — what the agent's final message should look like
- `## Hard rules` — invariants the agent must respect (security, scope limits)

Keep the body under 200 lines. Reference PRD sections rather than restating them.

### Step 3 — Mirror to .claude/agents/

Copy the file to `.claude/agents/<id>.md` so Claude Code's native subagent loader picks it up. The frontmatter Claude Code itself reads (`name`, `description`, optional `tools`, optional `model`) overlaps with — but is not identical to — the Agent OS frontmatter; for the mirror, either:
- (a) keep the same file and document that Claude Code will ignore unknown fields, or
- (b) emit a Claude-Code-only frontmatter subset alongside an `# Agent OS metadata` block.

Pick (a) by default; only do (b) if (a) breaks Claude Code's loader.

The mirror file's `description` field is what Claude Code uses to auto-delegate. Write a strong description that names trigger phrases ("Use PROACTIVELY when the user asks to ...").

### Step 4 — Starter eval fixture

Delegate to the `eval-fixture-author` subagent with the agent id, OR create a starter fixture yourself at `evals/fixtures/<id>/smoke.yaml` covering one happy path. The fixture must have at least one deterministic assert (PRD Phase 9).

### Step 5 — Hand off

Print a 5-line summary:
- Canonical: `agents/<id>.md`
- Mirror: `.claude/agents/<id>.md`
- Eval: `evals/fixtures/<id>/smoke.yaml`
- Test it: `agent-os run <id> "<sample prompt>"` (once Phase 3 lands)
- Recommend running `mcp-security-auditor` on the new agent's tool allowlist.

## What this skill does not do

- It does NOT run the agent.
- It does NOT register the agent in the SQLite registry — that happens automatically via the file loader at Phase 2.
- It does NOT modify `agent-os.config.yaml`.
