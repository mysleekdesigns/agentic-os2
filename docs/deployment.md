# Deployment

> Status: **opt-in**. The default Agent OS user runs locally on Claude Code
> Max with no container, no API key, and no server. See
> [`claude-code-max.md`](./claude-code-max.md) for that path.
>
> This guide is for users who want to run the `agent-os` CLI inside a
> container — for CI, for a shared dev box, or as the first step toward a
> hosted control plane. The future hosted control plane (Postgres,
> multi-tenant, durable workflow engines) is sketched separately in
> [`cloud-path.md`](./cloud-path.md).

The shipped artifacts are:

- `Dockerfile` — multi-stage Node 20 image for the CLI.
- `docker-compose.yml` — minimal compose stack with a mounted workspace.
- `.dockerignore` — keeps the build context lean.

The container does **not** include the web dashboard (Phase 15). See
[Dashboard in a container](#dashboard-in-a-container) for the deferred plan.

---

## Quickstart — Docker

```sh
# 1. Build the image.
docker build -t agent-os .

# 2. Run the health check against a fresh workspace.
mkdir -p ./workspace
docker run --rm -v "$(pwd)/workspace:/data" agent-os doctor

# 3. Run an agent.
docker run --rm -v "$(pwd)/workspace:/data" agent-os \
  run code_reviewer "review the diff"
```

What each step does:

1. **Build** — multi-stage build compiles `src/` → `dist/`, then assembles a
   slim runtime image that contains only production deps and the compiled
   JS. See [Image size & build](#image-size--build).
2. **Doctor** — runs `agent-os doctor`, which checks the workspace config,
   providers, MCP servers, and database. The mounted `./workspace`
   directory becomes `/data` inside the container; that's where the SQLite
   DB and any user-defined `agents/` and `workflows/` live.
3. **Run an agent** — same volume mount, different CLI args. The container
   inherits whatever provider credentials you pass via `--env` /
   `--env-file`. By default it uses `claude_code_local`, which needs no
   API key.

---

## Quickstart — docker-compose

```sh
# Default service runs `doctor`.
docker compose up agent-os

# Run an agent ad-hoc.
docker compose run --rm agent-os run code_reviewer "review the diff"

# Use --env-file to pass API keys without putting them in the compose file.
docker compose --env-file .env run --rm agent-os run gpt_writer "draft a post"
```

The compose file mounts `./workspace` → `/data`. Create that directory
before the first run so Docker doesn't create it owned by root.

---

## Workspace layout in the container

The `/data` mount is the workspace root inside the container. After a
`doctor` run against a fresh mount you'll see:

```
/data/
  agent-os.config.yaml      # workspace config; overrides image defaults
  agents/                   # your agents (image ships templates only)
  workflows/                # your workflows
  evals/                    # eval fixtures
  .agent-os/
    agent-os.sqlite         # SQLite DB (memory, runs, approvals, logs)
```

The image bakes in the repo's default `agent-os.config.yaml`, `agents/`,
`workflows/`, and `evals/` at `/app/`. They are used only if `/data` does
not already provide them — bind-mounting your own `/data` is the supported
way to customize.

---

## Environment variables

The container honors the same env vars as the local CLI:

| Variable                   | Purpose                                                        | Default                                 |
| -------------------------- | -------------------------------------------------------------- | --------------------------------------- |
| `AGENT_OS_WORKSPACE`       | Workspace root.                                                | `/data`                                 |
| `AGENT_OS_DB`              | Override SQLite path.                                          | `<workspace>/.agent-os/agent-os.sqlite` |
| `AGENT_OS_PROVIDER`        | Default provider id.                                           | `claude_code_local`                     |
| `ANTHROPIC_API_KEY`        | Required only if you enable an Anthropic API-mode provider.    | unset                                   |
| `OPENAI_API_KEY`           | Required only if you enable an OpenAI API-mode provider.       | unset                                   |
| `AGENT_OS_DASHBOARD_TOKEN` | Required for the dashboard service when bound beyond loopback. | unset                                   |

**The container never bakes in API keys.** Pass them at runtime:

```sh
docker run --rm \
  --env-file .env \
  -v "$(pwd)/workspace:/data" \
  agent-os run gpt_writer "..."
```

In Kubernetes / Swarm, use the platform's Secrets primitive rather than
plaintext `ENV`. See [`security.md`](./security.md) and
[`threat-model.md`](./threat-model.md).

---

## Image size & build

- Base: `node:20-bookworm-slim`.
- Two stages: `build` (with `python3`, `make`, `g++` for `better-sqlite3`)
  and `runtime` (build toolchain purged after `npm rebuild`).
- Final compressed image is in the **~200–250 MB** range, dominated by
  Node + production deps. The exact size will drift as dependencies
  change.
- The image is stateless: the workspace volume holds everything that
  changes at runtime, so you can roll forward by re-pulling the image
  without losing data.

`tini` runs as PID 1 so spawned children (e.g. shelled-out MCP servers
or `node` workers) are reaped correctly.

---

## Non-root user

The container runs as **uid 10001** (`agent`). Bind-mounted volumes need
to be writable by that uid, otherwise the CLI will fail to open the
SQLite DB or write logs.

Common fix on Linux hosts:

```sh
sudo chown -R 10001:10001 ./workspace
```

On macOS / Docker Desktop the file-sharing layer usually papers over
uid mismatches; on Linux servers, plan ownership explicitly.

---

## Dashboard in a container

The Phase 15 web dashboard ships as a separate Next.js workspace under
`web/`. Containerizing it cleanly needs its own multi-stage build
(`next build` + `next start` or a static export). That's **out of scope
for the initial image** — the `docker-compose.yml` includes a commented
`dashboard:` stub referencing a future `web/Dockerfile` so the hook-up
is obvious once that file lands.

If you want the dashboard today, run it directly on the host (`npm run
dev` in `web/`) and point it at the same `.agent-os/agent-os.sqlite`
that the container is writing to via the shared volume.

---

## Production checklist

Before deploying the container as anything more than a developer
convenience:

- [ ] **Pin the image by digest** (`agent-os@sha256:...`), not `:local` or
      `:latest`. Build, push to your registry, record the digest in your
      manifest.
- [ ] **Mount the workspace read-write**; mount `agents/`, `workflows/`,
      `evals/` **read-only** if they're managed in-repo and don't change
      at runtime. This narrows the blast radius of a compromised agent.
- [ ] **Pass secrets via your orchestrator's secrets manager** (Kubernetes
      `Secret`, Docker Swarm `secret`, AWS SSM, etc.). Never bake secrets
      into the image and avoid plaintext `ENV` in long-lived compose
      files.
- [ ] **Pin MCP servers**: set `security.pinned_mcp_servers: true` in
      `agent-os.config.yaml` and ship a `command_sha256` for every MCP
      server entry. See [`threat-model.md`](./threat-model.md).
- [ ] **Wire a health check** — `docker exec agent-os agent-os doctor
    --json` exits 0 on success and emits a structured report you can
      scrape. Use it as a Kubernetes `readinessProbe` /
      `livenessProbe`.
- [ ] **Network policy**: by default the CLI container needs outbound to
      whatever providers you've enabled (Anthropic, OpenAI) and to any
      MCP servers you've wired up. It does not need to listen on any
      port.
- [ ] **Log drain**: structured logs go to stdout; route them to your
      log aggregator the same way you would for any other Node service.

---

## Related docs

- [`claude-code-max.md`](./claude-code-max.md) — the local-first default.
- [`cloud-path.md`](./cloud-path.md) — future hosted control plane
  (Postgres, multi-tenant, durable workflows).
- [`api-mode.md`](./api-mode.md) — enabling Anthropic / OpenAI API
  providers.
- [`security.md`](./security.md), [`threat-model.md`](./threat-model.md) —
  what to harden before exposing the system.
- [`architecture.md`](./architecture.md) — overall system shape.
