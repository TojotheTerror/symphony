import { planDryRunDispatches } from "../src/orchestrator/dispatch.js";
import { planSchedulerDispatch } from "../src/orchestrator/scheduler.js";
import type { SchedulerIssue } from "../src/orchestrator/scheduler.js";
import { validateWorkflowConfig } from "../src/workflow/config.js";

const config = validateWorkflowConfig({
  tracker: {
    kind: "linear",
    project_id: "project-1",
    required_labels: ["symphony-ready"]
  },
  agent: {
    max_concurrent_agents: 1
  },
  workspace: {
    root: "tmp-workspaces"
  }
});

function issue(overrides: Partial<SchedulerIssue> = {}): SchedulerIssue {
  return {
    id: "issue-1",
    identifier: "CODEX-50",
    title: "Implement runner",
    state: "Todo",
    labels: ["symphony-ready"],
    projectId: "project-1",
    priority: 1,
    createdAt: "2026-06-27T00:00:00.000Z",
    ...overrides
  };
}

describe("dry-run dispatch planning", () => {
  it("turns bounded scheduler dispatch decisions into dry-run Codex plans only", () => {
    const schedulerDecision = planSchedulerDispatch({
      config,
      issues: [
        issue({ id: "issue-1", identifier: "CODEX-50", priority: 1 }),
        issue({ id: "issue-2", identifier: "CODEX-51", priority: 2 })
      ]
    });

    const dispatchPlan = planDryRunDispatches({
      schedulerDecision,
      config,
      promptTemplate: "Work on {{ issue.identifier }}."
    });

    expect(dispatchPlan).toMatchObject({
      mode: "dry-run",
      evidence: {
        plannedCount: 1,
        skippedCount: 1,
        maxConcurrentAgents: 1,
        availableSlots: 1
      }
    });
    expect(dispatchPlan.plans.map((plan) => plan.issue.identifier)).toEqual(["CODEX-50"]);
    expect(dispatchPlan.skipped).toEqual([
      expect.objectContaining({
        issue: expect.objectContaining({ identifier: "CODEX-51" }),
        reason: "no_capacity"
      })
    ]);
  });
});
