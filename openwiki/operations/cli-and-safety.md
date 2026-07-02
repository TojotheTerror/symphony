# CLI, Safety, and Logs

This repository’s active CLI is a control surface for safety checks, dry-run planning, guarded live execution, and run-log inspection.

## Command surface

`src/cli/commands.ts` exposes the current commands:

- `safety check --write-target <owner/repo>`
- `runner plan --issue-id ... --issue-identifier ... --issue-title ...`
- `runner live --issues ... --expect-ready ... --log ... --acknowledge-live-runner`
- `dry-run --issues ...`
- `status --log ...`
- `report --log ...`

The CLI help text is explicit that this scaffold does not poll Linear, mutate issues, or merge PRs.

## Safety gate

`src/safety/repoBoundary.ts` is the main repository-boundary check.

It:

- parses `git remote -v`
- normalizes GitHub remote URL formats
- recognizes the writable repo `TojotheTerror/symphony`
- recognizes the read-only upstream `openai/symphony`
- fails closed if the write target cannot be proven

This is not a convenience helper; it is a guardrail around automation scope.

The documented boundary in `docs/repo-boundary.md` matches the current implementation and should be treated as part of the operational contract.

## Dry-run and status/report logs

`src/logging/jsonl.ts` owns the run-log format and the summary logic.

It supports:

- append-only JSONL event writing
- safe reading of missing logs as empty
- summary output for `status`
- full event output for `report`
- live-run attempt classification
- detection of accidental log reuse

The live-run path in particular uses log freshness policy to block reuse of a log file that already contains prior live attempts.

## Why the log policy exists

The live-run guardrails exist because the scaffold separates dry-run evidence from explicit live execution.

The log policy prevents:

- accidental re-use of a stale live log
- ambiguous retry history
- silent mixing of attempts from different runs

## What to watch out for

- `runner live` is not a generic launch command; it requires explicit acknowledgement.
- The live path only accepts exactly one expected ready issue identifier.
- Status/report commands read logs only; they do not modify them.
- Safety checks should remain fail-closed if provenance cannot be proven.

## Where to change things

- CLI parsing and command routing: `src/cli/commands.ts`
- Repo-boundary logic: `src/safety/repoBoundary.ts`
- Log formats and summaries: `src/logging/jsonl.ts`
- Dry-run evidence generation: `src/orchestrator/report.ts`
- Live-run policy and log checks: `src/orchestrator/liveDispatch.ts`

## Related docs

- [Architecture overview](../architecture/overview.md)
- [Workflow contract](../workflows/workflow-contract.md)
- `docs/repo-boundary.md`
