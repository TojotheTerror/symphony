import { createDryRunReport, dryRunReportToLogEvents } from "../src/orchestrator/report.js";
import type { SchedulerIssue } from "../src/orchestrator/scheduler.js";
import { validateWorkflowConfig } from "../src/workflow/config.js";

const config = validateWorkflowConfig({
  tracker: {
    kind: "linear",
    project_id: "project-1",
    required_labels: ["symphony-ready"]
  },
  agent: {
    max_concurrent_agents: 2
  },
  workspace: {
    root: "tmp-workspaces"
  }
});

function issue(overrides: Partial<SchedulerIssue> = {}): SchedulerIssue {
  return {
    id: "issue-1",
    identifier: "CODEX-51",
    title: "Docs pilot gate",
    state: "Todo",
    labels: ["symphony-ready", "docs"],
    projectId: "project-1",
    priority: 1,
    createdAt: "2026-06-27T00:00:00.000Z",
    ...overrides
  };
}

describe("dry-run evidence reports", () => {
  it("reports dispatch safety and passes the docs-only gate when only expected issues are ready", () => {
    const report = createDryRunReport({
      config,
      promptTemplate: "Work on {{ issue.identifier }}.",
      expectedReadyIssueIdentifiers: ["CODEX-51"],
      issues: [
        issue(),
        issue({ id: "issue-2", identifier: "CODEX-52", labels: ["symphony"] }),
        issue({ id: "issue-3", identifier: "CODEX-53", state: "Done" }),
        issue({ id: "issue-4", identifier: "CODEX-54", projectId: "project-2" })
      ]
    });

    expect(report).toMatchObject({
      mode: "dry-run",
      liveExecution: false,
      safety: {
        requiredLabelGating: "checked",
        projectScope: "checked",
        boundedConcurrency: "checked",
        terminalStateHandling: "checked",
        liveCodexLaunch: "disabled"
      },
      pilotGate: {
        status: "passed",
        livePilotPassed: false,
        onlyIntendedReadyIssuesEligible: true,
        expectedReadyIssueIdentifiers: ["CODEX-51"],
        observedReadyIssueIdentifiers: ["CODEX-51"]
      }
    });
    expect(report.eligibleIssues.map((entry) => entry.identifier)).toEqual(["CODEX-51"]);
    expect(report.skippedIssues.map((entry) => entry.reason)).toEqual([
      "not_linear_eligible",
      "not_linear_eligible",
      "not_linear_eligible"
    ]);
  });

  it("emits JSONL-ready events with required review evidence", () => {
    const report = createDryRunReport({
      config,
      promptTemplate: "Work on {{ issue.identifier }}.",
      expectedReadyIssueIdentifiers: ["CODEX-51"],
      issues: [issue(), issue({ id: "issue-2", identifier: "CODEX-52", labels: ["symphony"] })]
    });

    expect(dryRunReportToLogEvents(report)).toEqual([
      expect.objectContaining({
        event: "dry_run_issue_planned",
        issueId: "issue-1",
        issueIdentifier: "CODEX-51",
        project: { id: "project-1", slug: null },
        adapterMode: "dry-run",
        command: "codex app-server",
        result: "planned",
        risks: expect.arrayContaining(["Codex app-server protocol is not exercised by this dry run."]),
        skippedChecks: expect.arrayContaining(["live Codex app-server subprocess launch"])
      }),
      expect.objectContaining({
        event: "dry_run_issue_skipped",
        issueId: "issue-2",
        issueIdentifier: "CODEX-52",
        result: "skipped",
        reason: "not_linear_eligible"
      }),
      expect.objectContaining({
        event: "dry_run_completed",
        result: "completed",
        pilotGate: expect.objectContaining({ livePilotPassed: false })
      })
    ]);
  });
});
