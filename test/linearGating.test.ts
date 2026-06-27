import { validateWorkflowConfig } from "../src/workflow/config.js";
import { evaluateLinearIssueEligibility } from "../src/linear/eligibility.js";

const tracker = validateWorkflowConfig({
  tracker: {
    kind: "linear",
    project_id: "project-1",
    required_labels: ["symphony-ready", "docs"]
  }
}).tracker;

describe("Linear issue eligibility", () => {
  it("accepts an active issue with all required labels and matching project", () => {
    const result = evaluateLinearIssueEligibility(
      {
        id: "issue-1",
        identifier: "CODEX-48",
        title: "Implement workflow loader",
        state: "Todo",
        labels: ["symphony-ready", { name: "docs" }, { name: "symphony" }],
        projectId: "project-1"
      },
      tracker
    );

    expect(result).toEqual({
      eligible: true,
      reasons: [],
      missingLabels: []
    });
  });

  it("rejects the broad symphony label without symphony-ready", () => {
    const result = evaluateLinearIssueEligibility(
      {
        id: "issue-1",
        identifier: "CODEX-48",
        title: "Implement workflow loader",
        state: "Todo",
        labels: ["symphony", "docs"],
        projectId: "project-1"
      },
      tracker
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("missing_symphony_ready_label");
    expect(result.missingLabels).toContain("symphony-ready");
  });

  it("requires every configured required label", () => {
    const result = evaluateLinearIssueEligibility(
      {
        id: "issue-1",
        identifier: "CODEX-48",
        title: "Implement workflow loader",
        state: "In Progress",
        labels: ["symphony-ready"],
        projectId: "project-1"
      },
      tracker
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("missing_required_label");
    expect(result.missingLabels).toEqual(["docs"]);
  });

  it("rejects issues from a different Linear project", () => {
    const result = evaluateLinearIssueEligibility(
      {
        id: "issue-1",
        identifier: "CODEX-48",
        title: "Implement workflow loader",
        state: "Todo",
        labels: ["symphony-ready", "docs"],
        projectId: "project-2"
      },
      tracker
    );

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("project_scope_mismatch");
  });

  it("supports project slug scoping", () => {
    const slugTracker = validateWorkflowConfig({
      tracker: {
        kind: "linear",
        project_slug: "symphony-foundation",
        required_labels: ["symphony-ready"]
      }
    }).tracker;

    const result = evaluateLinearIssueEligibility(
      {
        id: "issue-1",
        identifier: "CODEX-48",
        title: "Implement workflow loader",
        state: "Todo",
        labels: ["symphony-ready"],
        project: {
          slugId: "symphony-foundation"
        }
      },
      slugTracker
    );

    expect(result.eligible).toBe(true);
  });

  it("rejects review and terminal states for dispatch eligibility", () => {
    const reviewResult = evaluateLinearIssueEligibility(
      {
        id: "issue-1",
        identifier: "CODEX-48",
        title: "Implement workflow loader",
        state: "In Review",
        labels: ["symphony-ready", "docs"],
        projectId: "project-1"
      },
      tracker
    );
    const terminalResult = evaluateLinearIssueEligibility(
      {
        id: "issue-2",
        identifier: "CODEX-49",
        title: "Scheduler",
        state: "Done",
        labels: ["symphony-ready", "docs"],
        projectId: "project-1"
      },
      tracker
    );

    expect(reviewResult.eligible).toBe(false);
    expect(reviewResult.reasons).toContain("state_not_active");
    expect(terminalResult.eligible).toBe(false);
    expect(terminalResult.reasons).toContain("state_terminal");
  });
});
