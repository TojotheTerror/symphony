import { planSchedulerDispatch, CODEX49_DEFERRED_RUNTIME_BEHAVIOR } from "../src/orchestrator/scheduler.js";
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
  }
});

function issue(overrides: Partial<SchedulerIssue> = {}): SchedulerIssue {
  return {
    id: "issue-1",
    identifier: "CODEX-49",
    title: "Implement scheduler",
    state: "Todo",
    labels: ["symphony-ready", "symphony"],
    projectId: "project-1",
    priority: 2,
    createdAt: "2026-06-27T00:00:00.000Z",
    ...overrides
  };
}

describe("scheduler decision layer", () => {
  it("dispatches eligible issues up to the configured capacity", () => {
    const decision = planSchedulerDispatch({
      config,
      issues: [
        issue({ id: "issue-1", identifier: "CODEX-49", priority: 2 }),
        issue({ id: "issue-2", identifier: "CODEX-50", priority: 1 }),
        issue({ id: "issue-3", identifier: "CODEX-51", priority: 3 })
      ]
    });

    expect(decision.capacity).toEqual({
      maxConcurrentAgents: 2,
      runningCount: 0,
      availableSlots: 2
    });
    expect(decision.dispatch.map((entry) => entry.issue.identifier)).toEqual(["CODEX-50", "CODEX-49"]);
    expect(decision.skipped).toEqual([
      expect.objectContaining({
        issue: expect.objectContaining({ identifier: "CODEX-51" }),
        reason: "no_capacity"
      })
    ]);
  });

  it("subtracts running issues and skips already claimed work", () => {
    const decision = planSchedulerDispatch({
      config,
      runningIssueIds: ["issue-running"],
      claimedIssueIds: ["issue-claimed"],
      issues: [
        issue({ id: "issue-running", identifier: "CODEX-49", priority: 1 }),
        issue({ id: "issue-claimed", identifier: "CODEX-50", priority: 2 }),
        issue({ id: "issue-new", identifier: "CODEX-51", priority: 3 })
      ]
    });

    expect(decision.capacity.availableSlots).toBe(1);
    expect(decision.dispatch.map((entry) => entry.issue.id)).toEqual(["issue-new"]);
    expect(decision.skipped.map((entry) => entry.reason)).toEqual(["already_running", "already_claimed"]);
  });

  it("reuses CODEX-48 Linear gating for labels, active states, and project scope", () => {
    const decision = planSchedulerDispatch({
      config,
      issues: [
        issue({ id: "issue-1", identifier: "CODEX-49", labels: ["symphony"] }),
        issue({ id: "issue-2", identifier: "CODEX-50", state: "Done" }),
        issue({ id: "issue-3", identifier: "CODEX-51", projectId: "project-2" })
      ]
    });

    expect(decision.dispatch).toEqual([]);
    expect(decision.skipped).toEqual([
      expect.objectContaining({
        reason: "not_linear_eligible",
        eligibility: expect.objectContaining({ reasons: expect.arrayContaining(["missing_symphony_ready_label"]) })
      }),
      expect.objectContaining({
        reason: "not_linear_eligible",
        eligibility: expect.objectContaining({ reasons: expect.arrayContaining(["state_terminal"]) })
      }),
      expect.objectContaining({
        reason: "not_linear_eligible",
        eligibility: expect.objectContaining({ reasons: expect.arrayContaining(["project_scope_mismatch"]) })
      })
    ]);
  });

  it("blocks Todo issues with non-terminal blockers and allows terminal blockers", () => {
    const decision = planSchedulerDispatch({
      config,
      issues: [
        issue({
          id: "issue-blocked",
          identifier: "CODEX-49",
          priority: 1,
          blockedBy: [{ identifier: "CODEX-48", state: "In Progress" }]
        }),
        issue({
          id: "issue-unblocked",
          identifier: "CODEX-50",
          priority: 2,
          blockedBy: [{ identifier: "CODEX-47", state: "Done" }]
        })
      ]
    });

    expect(decision.dispatch.map((entry) => entry.issue.id)).toEqual(["issue-unblocked"]);
    expect(decision.skipped).toEqual([
      expect.objectContaining({
        issue: expect.objectContaining({ id: "issue-blocked" }),
        reason: "blocked_by_non_terminal",
        blocker: expect.objectContaining({ identifier: "CODEX-48" })
      })
    ]);
  });

  it("sorts deterministically by priority, creation time, and identifier", () => {
    const decision = planSchedulerDispatch({
      config: {
        ...config,
        agent: {
          ...config.agent,
          maxConcurrentAgents: 4
        }
      },
      issues: [
        issue({ id: "issue-c", identifier: "CODEX-51", priority: null, createdAt: "2026-06-27T00:00:00.000Z" }),
        issue({ id: "issue-b", identifier: "CODEX-50", priority: 1, createdAt: "2026-06-27T01:00:00.000Z" }),
        issue({ id: "issue-a", identifier: "CODEX-49", priority: 1, createdAt: "2026-06-26T23:00:00.000Z" }),
        issue({ id: "issue-d", identifier: "CODEX-48", priority: 1, createdAt: "2026-06-27T01:00:00.000Z" })
      ]
    });

    expect(decision.dispatch.map((entry) => entry.issue.identifier)).toEqual([
      "CODEX-49",
      "CODEX-48",
      "CODEX-50",
      "CODEX-51"
    ]);
  });

  it("keeps retry, cancellation, and status behavior explicitly non-live for this packet", () => {
    expect(CODEX49_DEFERRED_RUNTIME_BEHAVIOR).toEqual({
      retry: "Retry timers are not started by this decision layer.",
      cancel: "Cancellation requires a live runner and reconciliation loop.",
      status: "Status can be rendered from the returned decision snapshot."
    });
  });
});
