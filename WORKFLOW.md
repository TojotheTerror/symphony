---
tracker:
  kind: linear
  project_id: 58458325-6450-4df7-b795-6752f8e1a64b
  required_labels:
    - symphony-ready
  active_states:
    - Todo
    - In Progress
  review_states:
    - In Review
  terminal_states:
    - Done
    - Canceled
    - Duplicate
agent:
  max_concurrent_agents: 2
  max_turns: 20
codex:
  command: codex app-server
---

# Symphony Workflow Draft

This root workflow is a draft for the TypeScript Symphony v0 scaffold. CODEX-48 covers loading,
config validation, and pure Linear dispatch gating only. It is not a live dispatcher until later
packets implement and test scheduling, workspace management, and Codex runner behavior.

The broad `symphony` label alone is never dispatch-eligible. A Linear issue must have the
`symphony-ready` label before any future dispatcher may consider it eligible.

Repository boundaries:

- `TojotheTerror/symphony` is the only writable repository for this project.
- `openai/symphony` is read-only upstream reference material.
- Upstream push URLs must remain disabled.
- Automation that cannot prove its write target must fail closed.

No auto-merge or auto-land behavior exists in v0. Human review and landing remain explicit future
workflow steps, and this draft must not be treated as permission to merge, land, or release work.

Do not start Intelligent Terminal work from this workflow.

TODO(CODEX-49): Implement workspace manager and scheduler.
TODO(CODEX-50): Implement the Codex runner adapter.
TODO(CODEX-51): Implement observability, dry-run/status, and pilot gates.
