import { planCodexRun, validateCodexRunPlan, type CodexRunPlan } from "../codex/runner.js";
import type { WorkflowConfig } from "../workflow/config.js";
import { planSchedulerDispatch, type SchedulerDecision, type SchedulerIssue } from "./scheduler.js";

export type OneShotLiveDispatchBlockReason =
  | "expected_ready_issue_required"
  | "expected_ready_issue_count_invalid"
  | "expected_ready_issue_mismatch"
  | "live_codex_command_invalid"
  | "ready_issue_count_invalid";

export interface OneShotLiveDispatchPlan {
  mode: "live";
  expectedReadyIssueIdentifier: string;
  schedulerDecision: SchedulerDecision;
  plan: CodexRunPlan;
  evidence: {
    eligibleCount: number;
    expectedReadyIssueIdentifier: string;
    observedReadyIssueIdentifiers: string[];
  };
}

export interface BlockedOneShotLiveDispatchPlan {
  mode: "live";
  blocked: true;
  reason: OneShotLiveDispatchBlockReason;
  message: string;
  schedulerDecision?: SchedulerDecision;
  evidence: {
    eligibleCount: number;
    expectedReadyIssueIdentifier: string | null;
    observedReadyIssueIdentifiers: string[];
  };
}

export type OneShotLiveDispatchResult = OneShotLiveDispatchPlan | BlockedOneShotLiveDispatchPlan;

export interface PlanOneShotLiveDispatchInput {
  config: WorkflowConfig;
  promptTemplate: string;
  issues: readonly SchedulerIssue[];
  expectedReadyIssueIdentifiers: readonly string[];
}

export function planOneShotLiveDispatch(input: PlanOneShotLiveDispatchInput): OneShotLiveDispatchResult {
  const expected = normalizeExpectedIdentifiers(input.expectedReadyIssueIdentifiers);
  if (expected.length === 0) {
    return blocked("expected_ready_issue_required", "Exactly one expected ready issue identifier is required.", null, []);
  }
  if (expected.length !== 1) {
    return blocked(
      "expected_ready_issue_count_invalid",
      "One-shot live dispatch requires exactly one expected ready issue identifier.",
      expected.join(","),
      []
    );
  }

  const schedulerDecision = planSchedulerDispatch({
    config: input.config,
    issues: input.issues
  });
  const observedReadyIssues = collectObservedReadyIssues(schedulerDecision);
  const observedReadyIssueIdentifiers = observedReadyIssues.map((issue) => issue.identifier ?? "").filter(Boolean).sort();
  const expectedReadyIssueIdentifier = expected[0] ?? "";

  if (observedReadyIssues.length !== 1) {
    return blocked(
      "ready_issue_count_invalid",
      "One-shot live dispatch requires exactly one currently eligible issue.",
      expectedReadyIssueIdentifier,
      observedReadyIssueIdentifiers,
      schedulerDecision
    );
  }

  const issue = observedReadyIssues[0];
  if (issue?.identifier !== expectedReadyIssueIdentifier) {
    return blocked(
      "expected_ready_issue_mismatch",
      "The only currently eligible issue does not match the expected ready identifier.",
      expectedReadyIssueIdentifier,
      observedReadyIssueIdentifiers,
      schedulerDecision
    );
  }

  const plan = planCodexRun({
    config: input.config,
    issue: {
      id: issue.id ?? "",
      identifier: issue.identifier ?? "",
      title: issue.title ?? ""
    },
    prompt: input.promptTemplate,
    mode: "live"
  });
  const validation = validateCodexRunPlan(plan);
  if (!validation.ok) {
    return blocked(
      "live_codex_command_invalid",
      validation.errors[0]?.message ?? "Live Codex runner configuration is invalid.",
      expectedReadyIssueIdentifier,
      observedReadyIssueIdentifiers,
      schedulerDecision
    );
  }

  return {
    mode: "live",
    expectedReadyIssueIdentifier,
    schedulerDecision,
    plan,
    evidence: {
      eligibleCount: 1,
      expectedReadyIssueIdentifier,
      observedReadyIssueIdentifiers
    }
  };
}

function collectObservedReadyIssues(decision: SchedulerDecision): SchedulerIssue[] {
  return [
    ...decision.dispatch.map((entry) => entry.issue),
    ...decision.skipped.filter((skip) => skip.eligibility.eligible).map((skip) => skip.issue)
  ];
}

function normalizeExpectedIdentifiers(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function blocked(
  reason: OneShotLiveDispatchBlockReason,
  message: string,
  expectedReadyIssueIdentifier: string | null,
  observedReadyIssueIdentifiers: string[],
  schedulerDecision?: SchedulerDecision
): BlockedOneShotLiveDispatchPlan {
  return {
    mode: "live",
    blocked: true,
    reason,
    message,
    ...(schedulerDecision !== undefined ? { schedulerDecision } : {}),
    evidence: {
      eligibleCount: observedReadyIssueIdentifiers.length,
      expectedReadyIssueIdentifier,
      observedReadyIssueIdentifiers
    }
  };
}
