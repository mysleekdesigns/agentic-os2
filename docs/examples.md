# Agent OS — Examples

You have just run `agent-os init` and you want to see something real run.
This doc walks you through the three starter agent templates and the two
starter workflows shipped under `agents/templates/` and `workflows/examples/`,
shows the exact CLI invocations to run and evaluate each one, and tells you
what to expect at every approval gate. The goal is the PRD Phase 13 outcome:
zero to a working agent in under ten minutes on Claude Code Max, with no API
key required.

Prerequisite: run `agent-os agent sync` once. That command loads every
`agents/**/*.md` file, upserts it into the registry table, and mirrors the
canonical files into `.claude/agents/` so Claude Code's native subagent
loader sees them too (see `docs/claude-code-max.md`).

## Example agents

All three templates declare `provider: claude_code_local`, which drives the
Claude Code harness via `@anthropic-ai/claude-agent-sdk` using your existing
Max login. None of them require an API key to run.

### `code_reviewer`

Reviews pull requests for correctness, security, and PRD alignment. It reads
diffs and changed files, groups findings by severity, and never edits source
files — its only write capability is the review-comment artifact, and that
remains gated on explicit approval.

- Provider: `claude_code_local`
- Model: `opus`
- Tools allowed: `fs.read`
- Tools approval-required: `fs.write`
- Permissions: `network: deny`, `file_read: allow`, `file_write: approval_required`, `shell: deny`
- Memory scopes: reads `project`, `user_preferences`; writes `review_notes`
- Source: `agents/templates/code_reviewer.md`

How to run it:

```bash
agent-os run code_reviewer "Review the diff on this branch. Focus on security and PRD §2.5 (risk-tiered approvals)."
```

How to eval it:

```bash
agent-os eval run evals/fixtures/code_reviewer/smoke.yaml
```

Sample expected output: a markdown review with a `## Verdict` line, grouped
`## Blockers` / `## Major` / `## Minor` / `## Nits` sections, file-and-line
citations on every finding, and a `## PRD alignment` block referencing
section numbers.

What would block a real run:

- If the agent attempts to emit a review-comment file, `fs.write` will fire
  an approval request. Accept only if you actually asked for an artifact;
  otherwise reject and ask for the review inline.
- `shell` and `network` are denied outright. The agent should never request
  them; if you see a permission_denied event for either, that is a bug worth
  filing, not a prompt to approve.

### `doc_writer`

Writes and maintains project documentation. It reads existing docs to match
their voice, drafts new markdown, and refuses to invent product behavior it
cannot trace back to the codebase or PRD.

- Provider: `claude_code_local`
- Model: `sonnet`
- Tools allowed: `fs.read`
- Tools approval-required: `fs.write`
- Permissions: `network: deny`, `file_read: allow`, `file_write: approval_required`, `shell: deny`
- Memory scopes: reads `project`, `user_preferences`; writes `doc_notes`
- Source: `agents/templates/doc_writer.md`

How to run it:

```bash
agent-os run doc_writer "Write a short doc at docs/agent-registry.md describing how the agent registry loads templates from agents/templates/. Update docs/README.md to link it."
```

How to eval it:

```bash
agent-os eval run evals/fixtures/doc_writer/smoke.yaml
```

Sample expected output: a `### Files to write` listing, the full markdown of
the new doc inside a fenced block, and a diff hunk for the table-of-contents
update.

What would block a real run:

- Every file the agent wants to write triggers an `fs.write` approval. The
  agent's hard rule is to state exact paths before asking; accept only the
  paths you expected.
- If the doc would document behavior the agent could not verify in source,
  it must stop and flag the discrepancy rather than paper over it. Treat
  that pause as a feature, not an error.

### `research_agent`

Deep web and repository researcher. Plans sub-questions, fetches sources
through Crawlforge MCP tools, triangulates non-trivial claims across at
least two independent sources, and returns a cited synthesis.

- Provider: `claude_code_local`
- Model: `opus`
- Tools allowed: `mcp.crawlforge.search_web`, `mcp.crawlforge.fetch_url`,
  `mcp.crawlforge.extract_text`, `mcp.crawlforge.deep_research`, `fs.read`
- Tools approval-required: `fs.write`, `mcp.crawlforge.scrape_with_actions`
- Permissions: `network: approval_required`, `file_read: allow`,
  `file_write: approval_required`, `shell: deny`
- Memory scopes: reads `project`, `user_preferences`; writes `research_notes`
- Source: `agents/templates/research_agent.md`

How to run it:

```bash
agent-os run research_agent "Compare Drizzle ORM vs Prisma for SQLite-first applications. What are the tradeoffs?"
```

How to eval it:

```bash
agent-os eval run evals/fixtures/research_agent/smoke.yaml
```

Sample expected output: a structured report with `## Answer`, `## Key
findings` (each line cited with an inline URL), a `## Tradeoffs` table,
`## Open questions / inferences`, and a numbered `## Sources` list.

What would block a real run:

- The agent declares `network: approval_required`, so the first outbound
  fetch raises an approval request. Approve once if you trust the topic;
  reject if you wanted a local-only investigation, in which case the agent
  is instructed to fall back to `fs.read` and say so.
- `mcp.crawlforge.scrape_with_actions` (scripted browser actions) is also
  approval-gated. Reject by default unless you specifically asked for a
  browser-driven scrape.
- `fs.write` requests appear only if you explicitly ask the agent to drop
  findings to disk; otherwise the synthesis is returned inline.

## Example workflows

Both workflows live under `workflows/examples/` and are launched by their
`id` (not by path) — `agent-os workflow run` resolves the id against the
loaded workflow definitions.

### `bugfix-loop`

Plan → approve → patch → (unit-tests || lint) → review → approve. A human
sits in front of every disk-writing step, and tests + lint run in parallel
after the patch so the reviewer's verdict has both signals to lean on.

```
plan ─▶ approve-patch ─▶ patch ─▶ verify (parallel) ─▶ review ─▶ approve-merge
                                   ├─ unit-tests
                                   └─ lint
```

Inputs the workflow accepts (from `workflows/examples/bugfix_loop.yaml`):

- `bug_description` (string, required) — natural-language bug report with
  repro steps if known.
- `target_path` (string, required) — file or directory the fix should touch.

Steps in order:

1. `plan` — `code_reviewer` reads the target and emits a structured plan
   (summary, files_to_change, tests_to_add_or_update, risk). No writes.
2. `approve-patch` — human approval gate. Risk tag: `write`. The prompt
   shows the plan summary, planned files, and the risk level.
3. `patch` — `doc_writer` applies the approved plan to disk.
4. `verify` — parallel branch: `code_reviewer` runs the unit tests (with
   one retry, 600 s timeout), and a second `code_reviewer` run executes
   the linter and type-checker (300 s timeout, no auto-fix).
5. `review` — `code_reviewer` cross-checks the patch against the test and
   lint output and returns `{ verdict, notes }`.
6. `approve-merge` — second human approval gate. Risk tag: `write`. Shows
   the bug, patch summary, reviewer verdict, and reviewer notes.

How to run it:

```bash
agent-os workflow run bugfix-loop \
  --input bug_description="CLI crashes on empty config file" \
  --input target_path=src/cli/commands/init.ts
```

What you see at the CLI when an approval gate fires: the run prints
`workflow_paused` event and an instructional line on stderr:

```
workflow paused — resume with `agent-os workflow resume <run-id>`
```

The `<run-id>` is logged as `run_id: <uuid>` at the top of the run. While
the run is paused, decide the approval row with `agent-os approvals approve
<id>` (or `reject` / `revise --action "<new>"`), then resume with
`agent-os workflow resume <run-id>`.

Resume semantics: workflow runs are durable. Each step writes its outputs
to SQLite and to the blob store under `.agent-os/blobs/`, so resuming after
an approval continues from the next pending step rather than re-running the
plan. See `docs/architecture.md` for the data model and durability story.

### `deep-research`

Research a topic, draft a report, review it, then publish or revise based
on the verdict. There are no human approval gates inside this workflow —
the reviewer's `verdict` field drives a conditional fork.

```
research ─▶ write ─▶ review ─▶ route ─┬─▶ publish   (verdict == "approved")
                                      └─▶ revise    (otherwise)
```

Inputs the workflow accepts (from `workflows/examples/deep_research.yaml`):

- `topic` (string, required) — the subject to research and write about.

Steps in order:

1. `research` — `research_agent`, model `opus`, 600 s timeout, two retry
   attempts. Covers at least three reputable independent sources and
   records URL, author, date, and a 2-4 sentence summary per source.
2. `write` — `doc_writer` turns the research findings into a structured
   report (executive summary, Background, Key Findings with inline
   citations, Tradeoffs / Open Questions, References).
3. `review` — `code_reviewer` (reused here as a fact-checker) compares the
   draft against the original research and returns `{ verdict, notes }`.
4. `route` — conditional step on
   `outputs['review'].verdict === 'approved'`:
   - `then.publish` — `doc_writer` finalizes the report for publication.
   - `else.revise` — `doc_writer` revises the draft against the review
     notes, preserving structure and citations unless flagged.

How to run it:

```bash
agent-os workflow run deep-research \
  --input topic="SQLite WAL vs rollback journal for embedded agent workloads"
```

What you see at the CLI when an approval gate fires: this workflow has no
explicit `kind: approval` steps, but the `research` step's first network
fetch is gated by the `research_agent` template's `network: approval_required`
permission. That triggers a tool-call approval (not a workflow pause) which
the CLI either prompts inline or queues, depending on whether the underlying
`agent-os run` was invoked with `--queue-approvals`. From inside a workflow,
network approvals land in the same approval queue and the run pauses until
the queue is decided.

Resume semantics: identical to `bugfix-loop`. If the run pauses at the
research step's network approval, resume with `agent-os workflow resume
<run-id>` once the queue is cleared. The conditional `route` step is
re-evaluated on resume against the persisted `review.verdict`.

## Running the evals

`agent-os eval run [target]` discovers fixtures under the target (defaults
to `<workspaceRoot>/evals/fixtures`), runs each prompt through the agent's
configured provider, evaluates assertions, persists every `FixtureResult`
to the `eval_results` table, and writes a full `EvalRunReport` JSON
snapshot to `.agent-os/eval-runs/<runId>.json`. The exit code is non-zero
if any fixture failed.

Compare two runs with `agent-os eval diff <run-a> <run-b>`, which reads
the two snapshots and prints a fixture-level status table (or JSON with
`--json`). The diff exits non-zero only when a fixture regressed.

Each fixture has two layers of assertions:

- Deterministic asserts — `icontains`, `contains-all`, `contains-any`,
  `regex`, and inline `javascript` predicates. These compare the agent's
  emitted text against the fixture and run with no model in the loop
  beyond the agent run itself. They work on Claude Code Max with no API
  key.
- Model-graded asserts — `llm-rubric` entries that hand the output and a
  rubric prompt to a separate grader provider. These run only when you
  pass `--enable-model-graded` AND an API-backed provider
  (`anthropic_api` or `openai_api`) is enabled with its env key set. With
  no key, the runner prints a one-line skip notice on stderr and the
  fixture still passes if every deterministic assert holds. See
  `docs/api-mode.md` for how to flip in an API provider.

Run one fixture file:

```bash
agent-os eval run evals/fixtures/code_reviewer/smoke.yaml
```

Run all three starter fixtures:

```bash
agent-os eval run evals/fixtures
```

Run with model-graded scoring enabled (requires
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in env, and the matching provider
enabled in `agent-os.config.yaml`):

```bash
agent-os eval run evals/fixtures --enable-model-graded
```

Override the provider or model for a one-off run without editing the
agent frontmatter:

```bash
agent-os eval run evals/fixtures/research_agent/smoke.yaml \
  --provider anthropic_api --model claude-sonnet-4-5-20250929
```

## Writing your own

When you outgrow the starters, scaffold a new agent with the
`/add-agent-template` slash command. It generates `agents/<id>.md` with
schema-valid frontmatter (id, name, version, role, provider, model,
tools.allowed, tools.approval_required, permissions, memory, eval), mirrors
the file into `.claude/agents/`, and creates a starter fixture under
`evals/fixtures/<id>/smoke.yaml`. The MEMORY.md convention used by every
template is documented under `agents/templates/MEMORY.md`.

Run `agent-os agent sync` after adding a new agent so the registry table
and the `.claude/agents/` mirror catch up. After that, the new agent is
available to `agent-os run`, to workflow steps by id, and to
`agent-os eval run`.

## Cross-links

- `docs/claude-code-max.md` — Max-plan setup, the `agents/` registry, and
  the `.claude/agents/` mirror.
- `docs/api-mode.md` — flipping an agent to an API-backed provider and
  enabling model-graded evals.
- `docs/architecture.md` — high-level diagram, provider abstraction, data
  model, and durability story for workflow runs.
- `docs/memory.md` — scopes, write policy, MEMORY.md index, and how
  memory writes from `review_notes` / `doc_notes` / `research_notes` are
  policed.
- `docs/security.md` — risk tags, policy precedence, approval queue, and
  audit log.
- `docs/threat-model.md` — enumerated threats and mitigations.
