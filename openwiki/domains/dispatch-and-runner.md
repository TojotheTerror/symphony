# Dispatch and Runner Domain

This page covers the work-claiming, workspace, and Codex-runner parts of the scaffold. It is the area most likely to change as the repository moves from safe planning toward more complete automation.

## Domain model

The code currently treats a piece of work as:

- a Linear-style issue with id, identifier, title, state, labels, project scope, and blockers
- a scheduler decision about whether the issue is eligible and whether capacity exists
- a per-issue workspace rooted under the configured workspace directory
- a Codex run plan with launch command, executable, args, prompt evidence, and timeouts

## Eligibility and dispatch

`src/linear/eligibility.ts` and `src/orchestrator/scheduler.ts` decide whether an issue is ready to be worked.

The scheduler considers:

- required labels
- project scope
- issue state
- running issue ids
- claimed issue ids
- capacity from `agent.max_concurrent_agents`
- Todo issues blocked by non-terminal blockers

The scheduler sorts issues deterministically before deciding dispatch order.

`src/orchestrator/dispatch.ts` converts the scheduler decision into dry-run plans.

## Dry-run vs live-run

The runner distinguishes between two modes:

### Dry-run

Dry-run planning:

- creates a run plan
- produces evidence
- does not launch live Codex execution
- records skipped checks so reviewers can see what was not exercised

### Live-run

Live-run execution is guarded more strictly:

- it requires explicit `--acknowledge-live-runner`
- it requires exactly one expected ready issue identifier
- it refuses to run if the observed ready issue set does not match the expectation
- it validates log freshness before appending a live attempt

The live dispatch gate is there to prevent accidental execution on the wrong issue set.

## Workspace isolation

`src/workspace/manager.ts` turns issue identifiers into workspace keys and paths.

Key behavior:

- issue identifiers are sanitized into safe directory names
- workspace paths are resolved relative to a configured root
- the path must remain inside the root
- existing non-directory targets are rejected
- directories are created explicitly when needed

The workspace model is intentionally simple: one issue, one workspace path.

## Codex runner contracts

`src/codex/runner.ts` owns the run-plan and run-result model.

Important concepts:

- `planCodexRun(...)` builds the plan and evidence without executing live work
- `runCodexPlan(...)` executes according to the chosen adapter
- dry-run mode returns evidence that intentionally lists skipped checks
- live mode is only available when explicitly permitted
- the runner emits follow-up notes for later hardening work

`src/codex/launchContract.ts` and `src/codex/launcher.ts` define how the command is normalized and how the executable is resolved.

`src/codex/appServerClient.ts` implements the app-server transport lifecycle, event emission, and cleanup capture.

## Why this area is sensitive

This domain sits at the boundary between planning and real side effects.

The code has been hardened in several commit stages to ensure:

- launch commands are validated
- launcher resolution is fail-closed
- live execution requires explicit acknowledgement
- the intended issue is the only eligible issue before the live run starts
- workspace creation happens before the live runner can use it

## What to watch out for

- Avoid making dispatch order non-deterministic; tests depend on stable ordering and predictable reason codes.
- Keep workspace derivation safe from path traversal or unsafe identifiers.
- Preserve the distinction between planning a run and actually starting one.
- Keep live-run guards stronger than dry-run guards.

## Where to start when changing this domain

- Eligibility logic: `src/linear/eligibility.ts`
- Scheduler rules: `src/orchestrator/scheduler.ts`
- Dry-run planning: `src/orchestrator/dispatch.ts`
- Live dispatch gating: `src/orchestrator/liveDispatch.ts`
- Run-plan model and adapters: `src/codex/runner.ts`
- App-server transport: `src/codex/appServerClient.ts`
- Executable resolution: `src/codex/launcher.ts`
- Workspace management: `src/workspace/manager.ts`

## Related tests

- `test/scheduler.test.ts`
- `test/dispatch.test.ts`
- `test/liveDispatch.test.ts`
- `test/workspace.test.ts`
- `test/codexRunner.test.ts`
- `test/codexLauncher.test.ts`
- `test/appServerClient.test.ts`
