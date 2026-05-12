---
name: verify-no-api-key
description: Verify that a feature works on Claude Code Max with NO API key set. Trigger when the user asks to "test no-API-key path", "confirm Max mode works", "verify local-first", before marking a phase complete, or invokes /verify-no-api-key. Runs the project's tests and the named feature with ANTHROPIC_API_KEY and OPENAI_API_KEY unset in the environment, and reports pass/fail per PRD §4 quality bar ("works locally with no API key").
---

# verify-no-api-key — local-first quality gate

The Agent OS quality bar (**PRD §4**) requires every feature to "work locally with **no API key**". This skill is the gate. Use it before claiming a phase is complete.

## Hard rules

- Run with `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` explicitly unset in the child env. Do NOT rely on the parent shell.
- Do NOT modify `.env` or `agent-os.config.yaml` to make the test pass. If the feature needs config to be in `claude_code_local` mode, the default config should already do that (PRD §2.2 / §2.5).
- A test that depends on an API key is fine — but it must be tagged so it can be excluded from the no-API-key run. If a test fails because it tries to read `ANTHROPIC_API_KEY`, that is a Blocker finding for this skill.

## Procedure

### Step 1 — Scope the check

Ask the user (or infer from context) what feature is being verified:
- "the whole repo" → run all tests + `agent-os doctor`
- "phase N" → run tests touching files added in phase N (use `git diff main` to scope)
- "agent X" → run `agent-os run X "<sample prompt>"` once that command exists; otherwise run the eval fixtures for X

### Step 2 — Run the no-key suite

Run:

```bash
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CLAUDE_API_KEY npm test
```

(The `env -u` flag explicitly unsets the variable in the child process, even if the parent shell has it set.)

If this passes, also run, in order:

```bash
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CLAUDE_API_KEY npm run typecheck
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CLAUDE_API_KEY npm run lint
```

If the project has a built CLI:

```bash
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CLAUDE_API_KEY node dist/cli/index.js doctor
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CLAUDE_API_KEY node dist/cli/index.js --version
```

(Skip `doctor` if the command does not yet exist — that's a Phase 10 artifact.)

### Step 3 — If a feature-specific run is requested

For example, "verify research_agent works without an API key":

```bash
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u CLAUDE_API_KEY \
  node dist/cli/index.js run research_agent "summarize the README"
```

If this command does not yet exist (Phase 3 not done), say so and stop — there is nothing to verify yet.

### Step 4 — Analyze failures

For any failure, classify:

- **Blocker — reads API key**: stack trace mentions `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, or the code path branches on it.
- **Blocker — provider hardcoded**: code path always selects `anthropic_api` instead of `claude_code_local`.
- **Acceptable — explicitly API-only**: the failing test is tagged for API-mode only (PRD Phase 11) and was inadvertently included; suggest a `.skip` or test-tag fix.
- **Unrelated**: failure has nothing to do with API keys (e.g. type error). Report as a pre-existing issue, not a no-key gate failure.

### Step 5 — Report

Print a 5-line verdict:

```
no-api-key gate: PASS | FAIL

ran: npm test, typecheck, lint, doctor   (or which subset)
unset: ANTHROPIC_API_KEY, OPENAI_API_KEY, CLAUDE_API_KEY
findings:
  - <one line per failure with classification>
next:
  - <recommended fix or "ready to mark phase N complete">
```

## What this skill does not do

- It does NOT modify any source code to fix failures. Report them; the user (or a downstream agent) fixes.
- It does NOT verify API-mode behavior. Use a separate flow for that.
- It does NOT commit anything.
