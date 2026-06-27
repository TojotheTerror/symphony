import {
  evaluateLinearIssueEligibility,
  type LinearEligibilityResult,
  type LinearIssueForEligibility
} from "../linear/eligibility.js";
import type { WorkflowConfig } from "../workflow/config.js";

export interface SchedulerIssueBlocker {
  id?: string | null;
  identifier?: string | null;
  state?: string | null;
}

export interface SchedulerIssue extends LinearIssueForEligibility {
  priority?: number | null;
  createdAt?: string | null;
  created_at?: string | null;
  blockedBy?: readonly SchedulerIssueBlocker[] | null;
  blocked_by?: readonly SchedulerIssueBlocker[] | null;
}

export type SchedulerSkipReason =
  | "not_linear_eligible"
  | "already_running"
  | "already_claimed"
  | "blocked_by_non_terminal"
  | "no_capacity";

export interface SchedulerDecisionInput {
  config: Pick<WorkflowConfig, "agent" | "tracker">;
  issues: readonly SchedulerIssue[];
  runningIssueIds?: Iterable<string>;
  claimedIssueIds?: Iterable<string>;
}

export interface SchedulerCapacity {
  maxConcurrentAgents: number;
  runningCount: number;
  availableSlots: number;
}

export interface SchedulerDispatch {
  issue: SchedulerIssue;
}

export interface SchedulerSkip {
  issue: SchedulerIssue;
  reason: SchedulerSkipReason;
  eligibility: LinearEligibilityResult;
  blocker?: SchedulerIssueBlocker;
}

export interface SchedulerDecision {
  dispatch: SchedulerDispatch[];
  skipped: SchedulerSkip[];
  capacity: SchedulerCapacity;
}

export const CODEX49_DEFERRED_RUNTIME_BEHAVIOR = {
  retry: "Retry timers are not started by this decision layer.",
  cancel: "Cancellation requires a live runner and reconciliation loop.",
  status: "Status can be rendered from the returned decision snapshot."
} as const;

export function planSchedulerDispatch(input: SchedulerDecisionInput): SchedulerDecision {
  const runningIssueIds = normalizeIdSet(input.runningIssueIds);
  const claimedIssueIds = normalizeIdSet(input.claimedIssueIds);
  const runningCount = runningIssueIds.size;
  const maxConcurrentAgents = input.config.agent.maxConcurrentAgents;
  const capacity: SchedulerCapacity = {
    maxConcurrentAgents,
    runningCount,
    availableSlots: Math.max(maxConcurrentAgents - runningCount, 0)
  };

  const dispatch: SchedulerDispatch[] = [];
  const skipped: SchedulerSkip[] = [];

  for (const issue of [...input.issues].sort(compareIssuesForDispatch)) {
    const eligibility = evaluateLinearIssueEligibility(issue, input.config.tracker);
    if (!eligibility.eligible) {
      skipped.push({ issue, reason: "not_linear_eligible", eligibility });
      continue;
    }

    const issueId = issue.id?.trim();
    if (issueId !== undefined && runningIssueIds.has(issueId)) {
      skipped.push({ issue, reason: "already_running", eligibility });
      continue;
    }

    if (issueId !== undefined && claimedIssueIds.has(issueId)) {
      skipped.push({ issue, reason: "already_claimed", eligibility });
      continue;
    }

    const blocker = findNonTerminalTodoBlocker(issue, input.config.tracker.terminalStates);
    if (blocker !== undefined) {
      skipped.push({ issue, reason: "blocked_by_non_terminal", eligibility, blocker });
      continue;
    }

    if (dispatch.length >= capacity.availableSlots) {
      skipped.push({ issue, reason: "no_capacity", eligibility });
      continue;
    }

    dispatch.push({ issue });
  }

  return {
    dispatch,
    skipped,
    capacity
  };
}

export function compareIssuesForDispatch(a: SchedulerIssue, b: SchedulerIssue): number {
  return (
    comparePriority(a.priority, b.priority) ||
    compareTimestamp(a.createdAt ?? a.created_at, b.createdAt ?? b.created_at) ||
    compareIdentifier(a.identifier, b.identifier)
  );
}

function findNonTerminalTodoBlocker(
  issue: SchedulerIssue,
  terminalStates: readonly string[]
): SchedulerIssueBlocker | undefined {
  if (!stateMatches(issue.state, ["Todo"])) {
    return undefined;
  }

  return collectBlockers(issue).find((blocker) => !stateMatches(blocker.state, terminalStates));
}

function collectBlockers(issue: SchedulerIssue): readonly SchedulerIssueBlocker[] {
  return issue.blockedBy ?? issue.blocked_by ?? [];
}

function comparePriority(a: number | null | undefined, b: number | null | undefined): number {
  const priorityA = normalizePriority(a);
  const priorityB = normalizePriority(b);

  return priorityA - priorityB;
}

function normalizePriority(priority: number | null | undefined): number {
  return priority === undefined || priority === null ? Number.POSITIVE_INFINITY : priority;
}

function compareTimestamp(a: string | null | undefined, b: string | null | undefined): number {
  return normalizeTimestamp(a) - normalizeTimestamp(b);
}

function normalizeTimestamp(timestamp: string | null | undefined): number {
  if (timestamp === undefined || timestamp === null || timestamp.trim().length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function compareIdentifier(a: string | null | undefined, b: string | null | undefined): number {
  return normalizeText(a).localeCompare(normalizeText(b));
}

function normalizeText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function stateMatches(state: string | null | undefined, candidates: readonly string[]): boolean {
  const normalizedState = state?.trim().toLowerCase();
  if (normalizedState === undefined || normalizedState.length === 0) {
    return false;
  }

  return candidates.some((candidate) => candidate.trim().toLowerCase() === normalizedState);
}

function normalizeIdSet(values: Iterable<string> | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }

  return normalized;
}
