import {
  planCodexRun,
  type CodexRunIssue,
  type CodexRunPlan
} from "../codex/runner.js";
import type { WorkflowConfig } from "../workflow/config.js";
import type { SchedulerDecision, SchedulerIssue, SchedulerSkip } from "./scheduler.js";

export interface DryRunDispatchPlan {
  mode: "dry-run";
  capacity: SchedulerDecision["capacity"];
  plans: CodexRunPlan[];
  skipped: SchedulerSkip[];
  evidence: {
    plannedCount: number;
    skippedCount: number;
    maxConcurrentAgents: number;
    availableSlots: number;
  };
}

export interface PlanDryRunDispatchesInput {
  schedulerDecision: SchedulerDecision;
  config: Pick<WorkflowConfig, "codex" | "workspace">;
  promptTemplate: string;
}

export function planDryRunDispatches(input: PlanDryRunDispatchesInput): DryRunDispatchPlan {
  const plans = input.schedulerDecision.dispatch.map((entry) =>
    planCodexRun({
      config: input.config,
      issue: toCodexRunIssue(entry.issue),
      prompt: input.promptTemplate
    })
  );

  return {
    mode: "dry-run",
    capacity: input.schedulerDecision.capacity,
    plans,
    skipped: input.schedulerDecision.skipped,
    evidence: {
      plannedCount: plans.length,
      skippedCount: input.schedulerDecision.skipped.length,
      maxConcurrentAgents: input.schedulerDecision.capacity.maxConcurrentAgents,
      availableSlots: input.schedulerDecision.capacity.availableSlots
    }
  };
}

function toCodexRunIssue(issue: SchedulerIssue): CodexRunIssue {
  return {
    id: issue.id ?? "",
    identifier: issue.identifier ?? "",
    title: issue.title ?? ""
  };
}
