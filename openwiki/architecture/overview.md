# Architecture Overview

The active repository path is a layered TypeScript scaffold. The code is intentionally structured so that safety and planning logic can be tested independently from any live Codex execution.

## Layered responsibilities

### CLI entrypoint

`src/main.ts` hands control to `src/cli/commands.ts`, which defines the command surface and wires the rest of the system together.

The current commands are:

- `safety check`
- `runner plan`
- `runner live`
- `dry-run`
- `status`
- `report`

The CLI is not a generic application shell; it is a focused orchestration layer for repository-safe dispatch.

### Workflow loading and config validation

`src/workflow/parseFrontMatter.ts`, `src/workflow/loadWorkflow.ts`, and `src/workflow/config.ts` treat `WORKFLOW.md` as a runtime input.

That means the workflow file is parsed into:

- YAML front matter for typed config
- a Markdown prompt body for the Codex runner

Validation is deliberately strict and fail-closed:

- missing front matter is rejected for executable workflow loading
- malformed YAML is rejected
- non-map front matter is rejected
- empty prompts are rejected
- unsafe or incomplete config fails with typed `WorkflowError` values

### Scheduler and dispatch planning

`src/orchestrator/scheduler.ts` evaluates issue eligibility and capacity before any runner work begins.

It combines:

- Linear-style eligibility checks from `src/linear/eligibility.ts`
- running/claimed issue tracking
- capacity limits from workflow config
- blocked-by inspection for Todo issues

`src/orchestrator/dispatch.ts` then maps the scheduler decision into dry-run Codex plans.

`src/orchestrator/liveDispatch.ts` adds the stricter live-run path: it requires exactly one expected ready issue and blocks if the observed eligible issue set does not match.

### Codex planning and launch contracts

`src/codex/runner.ts` turns an issue/workflow pair into a run plan and result model.

Key ideas:

- dry-run mode produces evidence but does not launch live work
- live mode is only allowed when explicitly acknowledged
- workspace paths are derived from the issue identifier
- launch details are normalized into a command/executable/args contract

`src/codex/launchContract.ts` defines the current default app-server command, while `src/codex/launcher.ts` handles executable resolution, especially on Windows, in a fail-closed way.

`src/codex/appServerClient.ts` implements the app-server transport/client behavior, captures diagnostics, and normalizes app-server lifecycle events.

### Workspaces

`src/workspace/manager.ts` isolates each issue into a derived workspace path rooted under the configured workspace root.

The workspace manager is intentionally defensive:

- issue identifiers are sanitized before path derivation
- paths are checked to remain inside the configured root
- existing non-directory targets are rejected
- workspace creation is explicit rather than implicit

### Logging and evidence

`src/logging/jsonl.ts` handles run-log creation, append, reading, status summaries, and live-run reuse policy checks.

That file is what makes the scaffold auditable. It supports:

- JSONL event appends
- summarized status output
- live-run attempt classification
- detection of accidental log reuse
- diagnostic summaries for runner defects and environment warnings

`src/orchestrator/report.ts` converts scheduler decisions into dry-run evidence reports and log events.

### Safety and repository boundaries

`src/safety/repoBoundary.ts` inspects Git remotes and only accepts a proven write target of `TojotheTerror/symphony`.

It normalizes several GitHub remote URL formats and fails closed if the repository boundary cannot be proven.

## Why this architecture exists

The architecture separates eligibility, planning, evidence, and live execution so the system can prove work is eligible, bounded, and observable before any live action.

## Where to start when changing this area

- Command changes: `src/cli/commands.ts`
- Workflow contract changes: `src/workflow/*`
- Eligibility and dispatch changes: `src/orchestrator/*` and `src/linear/eligibility.ts`
- Runner changes: `src/codex/*`
- Workspace changes: `src/workspace/manager.ts`
- Safety changes: `src/safety/repoBoundary.ts`
- Log/report changes: `src/logging/jsonl.ts` and `src/orchestrator/report.ts`

## Watch-outs

- Do not assume live execution is available without the explicit guardrails in code.
- Do not weaken fail-closed parsing just to make a workflow file easier to accept.
- Keep scheduler logic deterministic; tests rely on repeatable ordering and reason codes.
- Keep run logs append-only and fresh by default.
