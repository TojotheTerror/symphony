# OpenWiki Quickstart

Symphony is a repository-safe automation scaffold for running work through isolated issue-level agents, with the current active implementation in TypeScript/Node.js. The repository is intentionally staged: it starts with fail-closed safety checks, workflow loading, scheduling/dispatch planning, dry-run observability, and only then guarded live Codex execution.

The root README makes that split explicit: the TypeScript scaffold is the active path, while `elixir/` is reference/prototype material only. The top-level `WORKFLOW.md` is executable configuration, not just prose.

## What this repository does

At a high level, the TypeScript scaffold:

- loads `WORKFLOW.md` as a typed runtime contract
- evaluates Linear issue eligibility and repository boundaries
- plans issue dispatch and per-issue workspaces
- produces dry-run and run-log evidence in JSONL
- guards live Codex app-server execution behind explicit acknowledgement and log freshness checks

It does **not** currently behave as a full autonomous dispatcher. The repository docs and code repeatedly emphasize fail-closed behavior and explicit guardrails.

## Start here

- [Architecture overview](architecture/overview.md)
- [Workflow contract](workflows/workflow-contract.md)
- [CLI, safety, and logs](operations/cli-and-safety.md)
- [Dispatch and runner domain](domains/dispatch-and-runner.md)

## Core source files

These are the main files that define the scaffold today:

- `README.md` — project positioning and current scaffold status
- `WORKFLOW.md` — repo-local workflow/config contract
- `src/main.ts` — CLI entrypoint
- `src/cli/commands.ts` — command surface and orchestration glue
- `src/workflow/*` — workflow parsing and validation
- `src/orchestrator/*` — eligibility, dispatch, and reporting
- `src/codex/*` — Codex runner planning and app-server client logic
- `src/logging/jsonl.ts` — JSONL event logging and summaries
- `src/safety/repoBoundary.ts` — write-target and remote safety checks
- `src/workspace/manager.ts` — per-issue workspace resolution and creation

## Repository shape

The repo is organized around one active TypeScript implementation and one legacy Elixir reference implementation.

- `src/` contains the active TypeScript scaffold.
- `test/` contains the behavioral contract for the scaffold.
- `docs/` contains operational notes and evidence artifacts, including repository boundary guidance.
- `elixir/` contains the older reference implementation and its own docs.

The scaffold is organized as a staged safety path: load and validate workflow config, plan eligible work, produce auditable dry-run evidence, and only then allow explicitly acknowledged live Codex execution.

## Useful first checks

From the repository root:

```bash
npm install
npm run typecheck
npm run test
npm run build
```

For the current safety-only CLI path:

```bash
npm run start -- --help
npm run start -- safety check --write-target TojotheTerror/symphony
```

## If you are changing the code

- Read `WORKFLOW.md` before changing dispatch behavior; it is part of the runtime contract.
- Update or add tests alongside changes under `test/`.
- Treat repo-boundary logic as fail-closed by default.
- Be careful with live Codex paths: they require explicit acknowledgement and log-freshness checks.
- Prefer the TypeScript scaffold unless you are intentionally working on the legacy reference in `elixir/`.

## Next pages

- [Architecture overview](architecture/overview.md) explains how the scaffold is layered.
- [Workflow contract](workflows/workflow-contract.md) explains how `WORKFLOW.md` is parsed and validated.
- [CLI, safety, and logs](operations/cli-and-safety.md) explains the current command surface and guardrails.
- [Dispatch and runner domain](domains/dispatch-and-runner.md) explains eligibility, workspaces, and Codex execution contracts.
