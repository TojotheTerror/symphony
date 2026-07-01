import { planOneShotLiveDispatch } from "../src/orchestrator/liveDispatch.js";
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
    identifier: "CODEX-53",
    title: "Run first live docs/test-only Symphony pilot",
    state: "Todo",
    labels: ["symphony-ready", "symphony"],
    projectId: "project-1",
    priority: 1,
    createdAt: "2026-06-28T00:00:00.000Z",
    ...overrides
  };
}

describe("one-shot live dispatch planning", () => {
  it("plans exactly one expected eligible issue in live mode", () => {
    const result = planOneShotLiveDispatch({
      config,
      promptTemplate: "Work on {{ issue.identifier }}.",
      issues: [
        issue(),
        issue({ id: "issue-2", identifier: "CODEX-56", labels: ["symphony"], title: "Implementation" })
      ],
      expectedReadyIssueIdentifiers: ["CODEX-53"]
    });

    expect(result).toMatchObject({
      mode: "live",
      expectedReadyIssueIdentifier: "CODEX-53",
      evidence: {
        eligibleCount: 1,
        observedReadyIssueIdentifiers: ["CODEX-53"]
      },
      plan: {
        mode: "live",
        issue: {
          identifier: "CODEX-53"
        }
      }
    });
  });

  it("blocks live planning unless exactly one expected ready identifier is supplied", () => {
    expect(
      planOneShotLiveDispatch({
        config,
        promptTemplate: "Prompt",
        issues: [issue()],
        expectedReadyIssueIdentifiers: []
      })
    ).toMatchObject({
      blocked: true,
      reason: "expected_ready_issue_required"
    });

    expect(
      planOneShotLiveDispatch({
        config,
        promptTemplate: "Prompt",
        issues: [issue()],
        expectedReadyIssueIdentifiers: ["CODEX-53", "CODEX-56"]
      })
    ).toMatchObject({
      blocked: true,
      reason: "expected_ready_issue_count_invalid"
    });
  });

  it("blocks when zero, multiple, or mismatched issues are dispatch-eligible", () => {
    expect(
      planOneShotLiveDispatch({
        config,
        promptTemplate: "Prompt",
        issues: [issue({ labels: ["symphony"] })],
        expectedReadyIssueIdentifiers: ["CODEX-53"]
      })
    ).toMatchObject({
      blocked: true,
      reason: "ready_issue_count_invalid",
      evidence: {
        eligibleCount: 0
      }
    });

    expect(
      planOneShotLiveDispatch({
        config,
        promptTemplate: "Prompt",
        issues: [issue(), issue({ id: "issue-2", identifier: "CODEX-56", title: "Runtime task" })],
        expectedReadyIssueIdentifiers: ["CODEX-53"]
      })
    ).toMatchObject({
      blocked: true,
      reason: "ready_issue_count_invalid",
      evidence: {
        eligibleCount: 2,
        observedReadyIssueIdentifiers: ["CODEX-53", "CODEX-56"]
      }
    });

    expect(
      planOneShotLiveDispatch({
        config,
        promptTemplate: "Prompt",
        issues: [issue()],
        expectedReadyIssueIdentifiers: ["CODEX-56"]
      })
    ).toMatchObject({
      blocked: true,
      reason: "expected_ready_issue_mismatch"
    });
  });
});
