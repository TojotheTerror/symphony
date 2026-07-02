# Workflow Contract

`WORKFLOW.md` is a runtime contract in this repository. The TypeScript scaffold reads it, parses it, validates it, and uses it to decide how issues should be scheduled and how Codex should be launched.

## File structure

The workflow file is parsed as:

- YAML front matter at the top
- Markdown body below the closing `---`

`src/workflow/parseFrontMatter.ts` is the parser, and `src/workflow/loadWorkflow.ts` is the file loader.

Executable workflow parsing is strict:

- front matter is required for executable loading
- the front matter must decode to a map/object
- the prompt body must be non-empty
- malformed files fail closed with `WorkflowError`

## Config model

`src/workflow/config.ts` turns the raw workflow front matter into typed config objects:

- `tracker`
- `agent`
- `codex`
- `workspace`

### Tracker config

The tracker config is currently Linear-oriented.

Important behaviors:

- `tracker.kind` must be `linear`
- the workflow must define either `tracker.project_slug` or `tracker.project_id`
- the default required label is `symphony-ready`
- default Linear states are `Todo`, `In Progress`, `In Review`, and terminal states `Done`, `Canceled`, `Duplicate`
- the default API endpoint is `https://api.linear.app/graphql`

This reflects the repository’s current gating model: work is project-scoped and label-scoped before it is eligible for dispatch.

### Agent config

Agent limits control scheduling capacity:

- `max_concurrent_agents` defaults to `2`
- `max_turns` defaults to `20`
- `max_retry_backoff_ms` defaults to `300000`

### Codex config

Codex config controls the launch contract and runtime timeouts:

- `command` defaults to `codex app-server --stdio`
- `executable` defaults to `codex`
- `turn_timeout_ms` defaults to `3600000`
- `read_timeout_ms` defaults to `5000`
- `stall_timeout_ms` defaults to `300000`

The config also preserves optional policy fields such as approval and sandbox settings.

### Workspace config

Workspace config currently only requires a root path. The workspace manager derives per-issue subdirectories under that root.

## Runtime use of the workflow file

The workflow contract flows into multiple parts of the system:

- the CLI loads it before dry-run or live-run planning
- the scheduler uses the typed config for eligibility and capacity
- the runner uses it to build launch plans
- the live runner uses it to decide whether a command is valid for a guarded live launch

## Failure modes that matter

The current implementation is intentionally defensive. Common failure modes include:

- missing `WORKFLOW.md`
- missing front matter
- invalid YAML
- empty prompt body
- unsupported `tracker.kind`
- missing project scope
- empty Codex command/executable values
- non-positive timeout values

These errors exist to prevent silent fallback to unsafe behavior.

## How to change workflow behavior safely

- Update `WORKFLOW.md` and the validation logic together.
- Add or update tests in `test/workflow.test.ts` and `test/config.test.ts`.
- If you add a new config field, decide whether it belongs in the workflow file, the typed config, or both.
- Keep the loader fail-closed; do not silently ignore malformed workflow content.
