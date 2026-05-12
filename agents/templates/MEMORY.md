<!--
  TEMPLATE: Agent OS memory index pattern.

  This file is a TEMPLATE — it documents the shape of a real workspace
  MEMORY.md. It is intentionally placed under `agents/templates/` (not
  `memory/`) so the engine does not treat it as a live memory entry.

  The real per-workspace index lives at:
      <workspaceRoot>/memory/MEMORY.md
  and is auto-maintained by `src/core/memory/files.ts` (`writeMemoryIndex`)
  after every create / update / remove. The engine sorts entries by scope,
  caps the file at ~200 lines, and replaces older lines first when the cap
  would otherwise be exceeded.

  The convention deliberately mirrors what Claude Code's conversation-context
  loader picks up (PRD §1.4 / §3 Phase 7): a short header, then one bulleted
  line per memory entry with a relative link to the markdown file under
  `memory/<scope>/<key>.md` and a one-line hook that summarises the entry.
-->

# MEMORY.md

> Agent OS memory index — auto-maintained by `src/core/memory/files.ts`.
> Edit `<workspaceRoot>/memory/<scope>/<key>.md` directly to change a
> memory; this file is regenerated on every create / update / remove.

## project

- [code-style](./project/code-style.md) — rev 3 · agent doc_writer
- [build-system](./project/build-system.md) — rev 1 · agent code_reviewer

## user_preferences

- [tone](./user_preferences/tone.md) — rev 1 · agent system
- [editor](./user_preferences/editor.md) — rev 2 · agent system _(tombstoned)_

## research_notes

- [drizzle-vs-prisma](./research_notes/drizzle-vs-prisma.md) — rev 1 · agent research_agent

<!--
  Anatomy of a line:
    - [<key>](./<scope>/<sanitized-key>.md) — <hook> [_(tombstoned)_]

  Hooks are kept to a single line so the index stays scannable; the full
  body lives in the linked file.
-->
