# Repository Boundary

This TypeScript scaffold starts with inspect/report safety behavior only. It does not mutate Git
remotes, push branches, create PRs, merge, land, or write to Linear.

## Allowed Repository Roles

- Writable repository: `TojotheTerror/symphony`
- Read-only upstream: `openai/symphony`
- Forbidden scope: `TojotheTerror/intelligent-terminal` and `microsoft/intelligent-terminal`

The upstream `openai/symphony` remote may be used as reference material only. Its push URL must be
disabled. If automation cannot prove that its write target is `TojotheTerror/symphony`, it must fail
closed.

## Current Safety Command

```bash
npm run start -- safety check --write-target TojotheTerror/symphony
```

The command inspects `git remote -v`, normalizes GitHub remote URL formats, and reports whether the
configured write target is allowed. It performs no remote mutation.

## Later Work

- CODEX-49: workspace manager and scheduler.
- CODEX-50: Codex runner adapter.
- CODEX-51: observability, dry-run/status, and pilot gate.
