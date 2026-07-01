import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendRunLogEvents,
  createRunLogEvent,
  readRunLog,
  summarizeRunLog
} from "../src/logging/jsonl.js";

describe("JSONL run logging", () => {
  it("writes structured JSONL events and summarizes recent evidence", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "symphony-log-test-"));
    try {
      const logPath = path.join(tempDir, "runs.jsonl");
      await appendRunLogEvents(logPath, [
        createRunLogEvent(
          "dry_run_issue_planned",
          {
            issueId: "issue-1",
            issueIdentifier: "CODEX-51",
            project: { id: "project-1", slug: null },
            workspace: { path: path.join(tempDir, "workspaces", "CODEX-51") },
            adapterMode: "dry-run",
            command: "codex app-server",
            result: "planned",
            risks: ["dry-run only"],
            skippedChecks: ["live Codex app-server subprocess launch"]
          },
          { timestamp: "2026-06-27T00:00:00.000Z" }
        )
      ]);

      const events = await readRunLog(logPath);
      expect(events).toEqual([
        expect.objectContaining({
          event: "dry_run_issue_planned",
          issueId: "issue-1",
          issueIdentifier: "CODEX-51",
          result: "planned"
        })
      ]);
      expect(summarizeRunLog(events)).toEqual({
        totalEvents: 1,
        latestTimestamp: "2026-06-27T00:00:00.000Z",
        eventCounts: { dry_run_issue_planned: 1 },
        resultCounts: { planned: 1 },
        recentEvents: events
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces duplicate live attempts as a report caveat instead of a clean pass", () => {
    const events = [
      createRunLogEvent(
        "live_issue_started",
        { issueId: "issue-1", issueIdentifier: "CODEX-53", result: "started" },
        { timestamp: "2026-07-01T00:00:00.000Z" }
      ),
      createRunLogEvent(
        "turn_failed",
        {
          issueId: "issue-1",
          issueIdentifier: "CODEX-53",
          method: "turn/completed",
          payload: {
            params: {
              turn: {
                status: "failed",
                error: { message: "stream disconnected before completion" }
              }
            }
          }
        },
        { timestamp: "2026-07-01T00:00:01.000Z", level: "error" }
      ),
      createRunLogEvent(
        "app_server_cleanup_completed",
        {
          issueId: "issue-1",
          issueIdentifier: "CODEX-53",
          cleanup: { attempted: true, success: true, exitCode: null, signal: "SIGTERM", error: null }
        },
        { timestamp: "2026-07-01T00:00:02.000Z" }
      ),
      createRunLogEvent(
        "live_issue_failed",
        { issueId: "issue-1", issueIdentifier: "CODEX-53", result: "failed" },
        { timestamp: "2026-07-01T00:00:03.000Z", level: "error" }
      ),
      createRunLogEvent(
        "live_issue_started",
        { issueId: "issue-1", issueIdentifier: "CODEX-53", result: "started" },
        { timestamp: "2026-07-01T00:00:04.000Z" }
      ),
      createRunLogEvent(
        "turn_completed",
        {
          issueId: "issue-1",
          issueIdentifier: "CODEX-53",
          method: "turn/completed",
          payload: {
            params: {
              turn: {
                status: "completed"
              }
            }
          }
        },
        { timestamp: "2026-07-01T00:00:05.000Z" }
      ),
      createRunLogEvent(
        "live_issue_completed",
        { issueId: "issue-1", issueIdentifier: "CODEX-53", result: "completed" },
        { timestamp: "2026-07-01T00:00:06.000Z" }
      )
    ];

    const status = summarizeRunLog(events);

    expect(status.liveAttempts).toMatchObject({
      totalAttempts: 2,
      classification: "accidental-duplicate-log-reuse",
      issueAttemptCounts: { "CODEX-53": 2 },
      hasPriorFailures: true,
      diagnostics: {
        runnerDefects: ["multiple top-level live attempts were recorded without append/retry metadata"]
      }
    });
    expect(status.liveAttempts?.notes).toEqual(
      expect.arrayContaining([
        "Live log contains multiple top-level attempts without complete retry metadata.",
        "A prior live attempt failed before the final terminal event."
      ])
    );
  });

  it("distinguishes metadata-backed append retries from accidental duplicate log reuse", () => {
    const firstCleanup = { attempted: true, success: true, exitCode: null, signal: "SIGTERM", error: null };
    const events = [
      createRunLogEvent(
        "live_issue_started",
        {
          issueId: "issue-1",
          issueIdentifier: "CODEX-53",
          result: "started",
          attempt: 1,
          log_fresh: true,
          append_enabled: false,
          retry_of: null,
          retry_reason: null,
          prior_cleanup_proof: null
        },
        { timestamp: "2026-07-01T00:00:00.000Z" }
      ),
      createRunLogEvent(
        "app_server_cleanup_completed",
        {
          issueId: "issue-1",
          issueIdentifier: "CODEX-53",
          cleanup: firstCleanup
        },
        { timestamp: "2026-07-01T00:00:01.000Z" }
      ),
      createRunLogEvent(
        "live_issue_failed",
        { issueId: "issue-1", issueIdentifier: "CODEX-53", result: "failed" },
        { timestamp: "2026-07-01T00:00:02.000Z", level: "error" }
      ),
      createRunLogEvent(
        "live_issue_started",
        {
          issueId: "issue-1",
          issueIdentifier: "CODEX-53",
          result: "started",
          attempt: 2,
          log_fresh: false,
          append_enabled: true,
          retry_of: "attempt:1",
          retry_reason: "stream disconnected before completion",
          prior_cleanup_proof: firstCleanup
        },
        { timestamp: "2026-07-01T00:00:03.000Z" }
      ),
      createRunLogEvent(
        "live_issue_completed",
        { issueId: "issue-1", issueIdentifier: "CODEX-53", result: "completed" },
        { timestamp: "2026-07-01T00:00:04.000Z" }
      )
    ];

    expect(summarizeRunLog(events).liveAttempts).toMatchObject({
      totalAttempts: 2,
      classification: "append-enabled-retry-run",
      attempts: [
        expect.objectContaining({ attempt: 1, metadataComplete: true, appendEnabled: false }),
        expect.objectContaining({
          attempt: 2,
          retryOf: "attempt:1",
          retryReason: "stream disconnected before completion",
          priorCleanupProof: firstCleanup,
          metadataComplete: true,
          appendEnabled: true
        })
      ],
      diagnostics: {
        runnerDefects: []
      }
    });
  });
});
