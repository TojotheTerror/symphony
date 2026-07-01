# CODEX-53 Live Pilot Evidence Summary

Date: 2026-07-01
Issue: CODEX-53
Repository: TojotheTerror/symphony
Result: Accepted as the first successful live app-server pilot, with evidence caveat.

## Summary

CODEX-53 completed the first controlled live docs/test-only Symphony pilot.

The final live run evidence contained two CODEX-53 top-level sequences:

1. First sequence failed with `turn_failed` / `live_issue_failed` due to `stream disconnected before completion`.
2. Second sequence completed with `turn_completed` / `live_issue_completed`.

No other issue was dispatched.

## Validated safety constraints

- Eligible issue set was CODEX-53 only.
- No Intelligent Terminal files were touched.
- No upstream write was attempted.
- No commit, push, PR, tag, or release was created by the live runner.
- Max concurrency remained <= 2.
- Broad `symphony` label alone was not sufficient.
- `symphony-ready` was required for dispatch.
- App-server process cleanup completed with SIGTERM.
- CODEX-53 was moved out of dispatch eligibility after review.

## Evidence caveat

The raw JSONL log is not clean single-attempt evidence. It contains one failed same-issue sequence followed by one successful same-issue sequence.

CODEX-62 reviewed this and classified the second sequence as an unannotated second top-level invocation caused by log reuse / rerun behavior, not app-server recovery.

CODEX-63 added a live-runner attempt/log guard so future live runs fail closed on accidental log reuse before workspace prep, client creation, or app-server launch.

## Raw evidence handling

Raw JSONL evidence is intentionally kept local and untracked.

Reason: the raw log includes local filesystem paths, command transcripts, plugin/MCP diagnostics, auth-error text, rate-limit metadata, and `.codex` memory excerpts. It should not be committed without a separate redaction pass.

## Local raw evidence files

- docs/pilot/CODEX-53-live-run-20260701-final.jsonl
- docs/pilot/CODEX-53-live-run-20260701-013207.jsonl
- docs/pilot/CODEX-53-prelive-dry-run-20260701-012612.jsonl
- docs/pilot/CODEX-53-live-issues.json

## Follow-up status

- CODEX-53: Done
- CODEX-62: Done
- CODEX-63: Done

## Local commit stack at closeout

- e590860 Add live runner attempt log guard
- 5cb7f93 Add fail-closed Codex launcher resolution
- 30fbd62 Fix guarded Codex app-server live launch