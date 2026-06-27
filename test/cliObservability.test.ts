import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli/commands.js";

describe("observability CLI commands", () => {
  it("runs a fixture dry-run, writes JSONL evidence, and reports status", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "symphony-observability-cli-test-"));
    try {
      await writeFile(
        path.join(tempDir, "WORKFLOW.md"),
        `---
tracker:
  kind: linear
  project_id: project-1
  required_labels:
    - symphony-ready
agent:
  max_concurrent_agents: 2
workspace:
  root: workspaces
codex:
  command: codex app-server
---
Work on {{ issue.identifier }}.
`,
        "utf8"
      );
      const issuesPath = path.join(tempDir, "issues.json");
      const logPath = path.join(tempDir, "runs.jsonl");
      await writeFile(
        issuesPath,
        JSON.stringify([
          {
            id: "issue-1",
            identifier: "CODEX-51",
            title: "Docs pilot gate",
            state: "Todo",
            labels: ["symphony-ready", "docs"],
            projectId: "project-1"
          },
          {
            id: "issue-2",
            identifier: "CODEX-52",
            title: "Implementation work",
            state: "Todo",
            labels: ["symphony"],
            projectId: "project-1"
          },
          {
            id: "issue-3",
            identifier: "CODEX-53",
            title: "Already done",
            state: "Done",
            labels: ["symphony-ready"],
            projectId: "project-1"
          }
        ]),
        "utf8"
      );

      const dryRunOutput = await runCliCollectingOutput([
        "dry-run",
        "--issues",
        issuesPath,
        "--log",
        logPath,
        "--expect-ready",
        "CODEX-51"
      ], tempDir);
      expect(dryRunOutput.exitCode).toBe(0);
      const dryRunReport = JSON.parse(dryRunOutput.stdout);
      expect(dryRunReport.pilotGate).toMatchObject({
        status: "passed",
        livePilotPassed: false,
        onlyIntendedReadyIssuesEligible: true
      });

      const statusOutput = await runCliCollectingOutput(["status", "--log", logPath], tempDir);
      expect(statusOutput.exitCode).toBe(0);
      const status = JSON.parse(statusOutput.stdout);
      expect(status.totalEvents).toBe(4);
      expect(status.eventCounts).toEqual({
        dry_run_issue_planned: 1,
        dry_run_issue_skipped: 2,
        dry_run_completed: 1
      });

      const reportOutput = await runCliCollectingOutput(["report", "--log", logPath], tempDir);
      expect(reportOutput.exitCode).toBe(0);
      const report = JSON.parse(reportOutput.stdout);
      expect(report.events.at(-1).pilotGate.livePilotPassed).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function runCliCollectingOutput(args: string[], cwd: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(args, {
    cwd,
    stdout: { write: (message) => stdout.push(message) },
    stderr: { write: (message) => stderr.push(message) }
  });

  return {
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join("")
  };
}
