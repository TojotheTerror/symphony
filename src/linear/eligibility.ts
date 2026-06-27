import { type LinearTrackerConfig, SYMPHONY_READY_LABEL } from "../workflow/config.js";

export interface LinearIssueLabel {
  name?: string | null;
}

export interface LinearIssueProject {
  id?: string | null;
  slugId?: string | null;
  slug?: string | null;
}

export interface LinearIssueForEligibility {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
  state?: string | null;
  labels?: readonly (string | LinearIssueLabel)[] | null;
  projectId?: string | null;
  projectSlug?: string | null;
  project?: LinearIssueProject | null;
}

export type LinearIneligibilityReason =
  | "missing_required_field"
  | "state_not_active"
  | "state_terminal"
  | "missing_required_label"
  | "missing_symphony_ready_label"
  | "project_scope_mismatch";

export interface LinearEligibilityResult {
  eligible: boolean;
  reasons: LinearIneligibilityReason[];
  missingLabels: string[];
}

export function evaluateLinearIssueEligibility(
  issue: LinearIssueForEligibility,
  tracker: LinearTrackerConfig
): LinearEligibilityResult {
  const reasons = new Set<LinearIneligibilityReason>();
  const missingLabels: string[] = [];

  if (!hasRequiredIdentityFields(issue)) {
    reasons.add("missing_required_field");
  }

  const state = issue.state?.trim();
  if (state === undefined || state.length === 0) {
    reasons.add("missing_required_field");
  } else {
    if (stateMatches(state, tracker.terminalStates)) {
      reasons.add("state_terminal");
    }
    if (!stateMatches(state, tracker.activeStates)) {
      reasons.add("state_not_active");
    }
  }

  const labels = collectNormalizedLabels(issue.labels);
  for (const requiredLabel of tracker.requiredLabels) {
    if (!labels.has(requiredLabel)) {
      missingLabels.push(requiredLabel);
      reasons.add(
        requiredLabel === SYMPHONY_READY_LABEL
          ? "missing_symphony_ready_label"
          : "missing_required_label"
      );
    }
  }

  if (!projectMatches(issue, tracker)) {
    reasons.add("project_scope_mismatch");
  }

  return {
    eligible: reasons.size === 0,
    reasons: [...reasons],
    missingLabels
  };
}

function hasRequiredIdentityFields(issue: LinearIssueForEligibility): boolean {
  return [issue.id, issue.identifier, issue.title].every(
    (value) => value !== undefined && value !== null && value.trim().length > 0
  );
}

function collectNormalizedLabels(
  labels: readonly (string | LinearIssueLabel)[] | null | undefined
): Set<string> {
  const normalized = new Set<string>();

  for (const label of labels ?? []) {
    const name = typeof label === "string" ? label : label.name;
    const trimmed = name?.trim().toLowerCase();
    if (trimmed !== undefined && trimmed.length > 0) {
      normalized.add(trimmed);
    }
  }

  return normalized;
}

function stateMatches(state: string, candidates: readonly string[]): boolean {
  const normalizedState = state.toLowerCase();
  return candidates.some((candidate) => candidate.toLowerCase() === normalizedState);
}

function projectMatches(issue: LinearIssueForEligibility, tracker: LinearTrackerConfig): boolean {
  const expectedProjectId = tracker.projectId?.trim();
  const expectedProjectSlug = tracker.projectSlug?.trim();
  const actualProjectId = firstNonBlank(issue.projectId, issue.project?.id);
  const actualProjectSlug = firstNonBlank(issue.projectSlug, issue.project?.slugId, issue.project?.slug);

  if (expectedProjectId !== undefined && actualProjectId !== expectedProjectId) {
    return false;
  }

  if (
    expectedProjectSlug !== undefined &&
    actualProjectSlug?.toLowerCase() !== expectedProjectSlug.toLowerCase()
  ) {
    return false;
  }

  return true;
}

function firstNonBlank(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}
