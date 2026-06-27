# Docs-Only Pilot Gate

CODEX-51 stages the Symphony v0 pilot gate with dry-run evidence only. A live pilot is not claimed
until live Codex execution is explicitly enabled and separately validated.

## Gate Criteria

- The dry run uses `symphony-ready` and project scoping from `WORKFLOW.md`.
- The dry run reports every eligible and ineligible issue from a safe fixture or non-live query.
- The expected docs-only issue identifiers match the observed ready issue identifiers exactly.
- Bounded concurrency is visible in the dry-run capacity summary.
- Terminal-state issues are reported as skipped.
- JSONL evidence includes issue ID, project scope, workspace path, adapter mode, command, result,
  risks, and skipped checks.
- No Intelligent Terminal production files are edited by the pilot gate.

## Non-Claims

- A passing dry-run gate does not mean a live Codex pilot passed.
- A passing dry-run gate does not release CODEX-52 or downstream work.
- A passing dry-run gate does not make broad `symphony` labels dispatch-eligible.

## Operator Commands

Use a safe fixture or non-live Linear export:

```bash
npm run start -- dry-run --issues <issues.json> --expect-ready CODEX-51 --log <runs.jsonl>
npm run start -- status --log <runs.jsonl>
npm run start -- report --log <runs.jsonl>
```

The report must explicitly show `livePilotPassed: false` until a later packet enables and validates
live Codex execution.
