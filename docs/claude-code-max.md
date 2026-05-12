# Claude Code Max and the `agents/` registry

## Purpose

Agent OS is a local-first developer operating layer for AI agents. The default
runtime is the Claude Code CLI running under a Claude Max login — no API key
required. Everything in this repository is designed so that the same file-based
agent definitions drive both the Agent OS core and Claude Code's native
subagent system, with no duplication of source of truth.

## The `agents/` registry

Canonical agent definitions live at `agents/<id>.md`. Each file is a markdown
document with a YAML frontmatter block matching the shape defined in
**PRD §2.6** (`id`, `name`, `version`, `role`, `provider`, `model`, `tools`,
`permissions`, `memory`, `eval`). The body is the instruction prompt.

The Agent OS loader reads these files at startup, validates them against the
PRD §2.6 Zod schema, and registers each agent in the SQLite registry so the
CLI, the task runner, and the evals harness can resolve agents by id.

Starter templates live under `agents/templates/`. Templates are read-only
references shipped with the repo; they are not auto-registered. To use one,
copy it into `agents/<id>.md` and edit.

## Mirror to `.claude/agents/`

Claude Code itself looks for subagents in `.claude/agents/<id>.md` (project
scope) or `~/.claude/agents/<id>.md` (user scope). To make a single source of
truth drive both surfaces, Agent OS ships an `agent sync` command:

```
agent-os agent sync
```

`agent sync` reads every canonical file under `agents/<id>.md` and writes a
mirror copy to `.claude/agents/<id>.md`. The mirror gets a synthesized
`description` field (used by Claude Code for auto-delegation) derived from the
canonical `role` plus the success criteria. Unknown fields in the canonical
frontmatter are preserved in the mirror — Claude Code ignores fields it does
not recognize, so this is safe.

The mirror is generated output. Do not edit it by hand; edit the canonical
file and re-run `agent sync`.

## Why this dual purpose

The two runtimes read overlapping but non-identical metadata:

- **Claude Code** reads `name`, `description`, optional `tools`, optional
  `model`. Unknown frontmatter fields are ignored.
- **Agent OS** reads the full PRD §2.6 schema: `id`, `version`, `role`,
  `provider`, `tools.allowed` and `tools.approval_required`, `permissions`,
  `memory.read` and `memory.write`, `eval.fixtures` and
  `eval.success_criteria`.

By writing one canonical file per agent and mirroring it into
`.claude/agents/`, both runtimes work from the same source. Agent OS gets the
full schema for policy enforcement and evals; Claude Code gets the subset it
needs for its native subagent loader. No duplication.

## What this means for users

To add a new agent:

1. Copy a starter template from `agents/templates/` into `agents/<id>.md`.
2. Edit the frontmatter — set the `id`, `role`, tool allowlist, permissions,
   memory scopes, and eval fixtures path.
3. Edit the instruction body.
4. Run `agent-os agent sync` to refresh the mirror.

After sync, Claude Code's `/agents` slash command will list the new agent and
the Agent OS CLI will resolve it by id. Tool calls flow through the same
deny-by-default policy regardless of which surface invoked the agent (PRD
§1.7, §2.5).

## The three starter templates

The repository ships three templates under `agents/templates/`:

- **`research_agent`** — deep web and repository researcher; uses Crawlforge
  MCP tools and `fs.read`; writes a `research_notes` memory scope. Opus.
- **`code_reviewer`** — reads diffs and flags correctness, security, and
  PRD-alignment issues; never writes source files; writes a `review_notes`
  memory scope. Opus.
- **`doc_writer`** — drafts and updates project documentation matching the
  existing voice; reads code, requests approval to write markdown; writes a
  `doc_notes` memory scope. Sonnet.

Each template is a minimal, deny-by-default starting point. Customize freely;
keep the PRD §2.6 frontmatter shape intact so the loader accepts it.

## Status

Phase 2. The registry loader, the `agent sync` mirror command, and these
starter templates land together. See PRD §2.6 and Phase 2 checklist for the
canonical shape and exit criteria.
