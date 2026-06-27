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
});
