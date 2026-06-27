import { z } from "zod";

import { createRunLogEvent, type JsonObject, type RunLogEvent } from "../logging/jsonl.js";
import type { WorkflowConfig } from "../workflow/config.js";
import { planDryRunDispatches, type DryRunDispatchPlan } from "./dispatch.js";
import {
  planSchedulerDispatch,
  type SchedulerDecision,
  type SchedulerIssue,
  type SchedulerSkip
} from "./scheduler.js";

export interface DryRunReportInput {
  config: WorkflowConfig;
  promptTemplate: string;
  issues: readonly SchedulerIssue[];
  expectedReadyIssueIdentifiers?: readonly string[];
}

export interface IssueSummary {
  id: string | null;
  identifier: string | null;
  title: string | null;
  state: string | null;
}

export interface DryRunSkipSummary extends IssueSummary {
  reason: SchedulerSkip["reason"];
  eligibilityReasons: string[];
  missingLabels: string[];
}

export interface DocsOnlyPilotGateSummary {
  status: "passed" | "failed" | "not_evaluated";
  livePilotPassed: false;
  onlyIntendedReadyIssuesEligible: boolean | null;
  expectedReadyIssueIdentifiers: string[];
  observedReadyIssueIdentifiers: string[];
  criteria: string[];
  notes: string[];
}

export interface DryRunEvidenceReport {
  mode: "dry-run";
  liveExecution: false;
  project: {
    id: string | null;
    slug: string | null;
  };
  requiredLabels: string[];
  terminalStates: string[];
  capacity: SchedulerDecision["capacity"];
  eligibleIssues: IssueSummary[];
  skippedIssues: DryRunSkipSummary[];
  dispatchPlan: DryRunDispatchPlan;
  safety: {
    requiredLabelGating: "checked";
    projectScope: "checked";
    boundedConcurrency: "checked";
    terminalStateHandling: "checked";
    liveCodexLaunch: "disabled";
  };
  pilotGate: DocsOnlyPilotGateSummary;
}

const IssueLabelSchema = z.object({
  name: z.string().nullable().optional()
});

const SchedulerIssueSchema = z
  .object({
    id: z.string().nullable().optional(),
    identifier: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    labels: z.array(z.union([z.string(), IssueLabelSchema])).nullable().optional(),
    projectId: z.string().nullable().optional(),
    projectSlug: z.string().nullable().optional(),
    project: z
      .object({
        id: z.string().nullable().optional(),
        slugId: z.string().nullable().optional(),
        slug: z.string().nullable().optional()
      })
      .nullable()
      .optional(),
    priority: z.number().nullable().optional(),
    createdAt: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    blockedBy: z
      .array(
        z.object({
          id: z.string().nullable().optional(),
          identifier: z.string().nullable().optional(),
          state: z.string().nullable().optional()
        })
      )
      .nullable()
      .optional(),
    blocked_by: z
      .array(
        z.object({
          id: z.string().nullable().optional(),
          identifier: z.string().nullable().optional(),
          state: z.string().nullable().optional()
        })
      )
      .nullable()
      .optional()
  })
  .strip();

export function parseSchedulerIssuesJson(value: unknown): SchedulerIssue[] {
  return z.array(SchedulerIssueSchema).parse(value) as SchedulerIssue[];
}

export function createDryRunReport(input: DryRunReportInput): DryRunEvidenceReport {
  const schedulerDecision = planSchedulerDispatch({
    config: input.config,
    issues: input.issues
  });
  const dispatchPlan = planDryRunDispatches({
    schedulerDecision,
    config: input.config,
    promptTemplate: input.promptTemplate
  });

  const eligibleIssues = schedulerDecision.dispatch.map((entry) => summarizeIssue(entry.issue));
  const skippedIssues = schedulerDecision.skipped.map(summarizeSkip);
  const observedReadyIssueIdentifiers = collectObservedReadyIssueIdentifiers(schedulerDecision);

  return {
    mode: "dry-run",
    liveExecution: false,
    project: {
      id: input.config.tracker.projectId ?? null,
      slug: input.config.tracker.projectSlug ?? null
    },
    requiredLabels: input.config.tracker.requiredLabels,
    terminalStates: input.config.tracker.terminalStates,
    capacity: schedulerDecision.capacity,
    eligibleIssues,
    skippedIssues,
    dispatchPlan,
    safety: {
      requiredLabelGating: "checked",
      projectScope: "checked",
      boundedConcurrency: "checked",
      terminalStateHandling: "checked",
      liveCodexLaunch: "disabled"
    },
    pilotGate: buildPilotGateSummary(input.expectedReadyIssueIdentifiers, observedReadyIssueIdentifiers)
  };
}

export function dryRunReportToLogEvents(report: DryRunEvidenceReport): RunLogEvent[] {
  const events: RunLogEvent[] = [];
  const project = jsonProject(report);

  for (const plan of report.dispatchPlan.plans) {
    events.push(
      createRunLogEvent("dry_run_issue_planned", {
        workerRole: "symphony_observability_pilot_worker",
        issueId: plan.issue.id,
        issueIdentifier: plan.issue.identifier,
        project,
        workspace: {
          root: plan.workspace.rootPath,
          key: plan.workspace.workspaceKey,
          path: plan.workspace.path
        },
        adapterMode: plan.mode,
        command: plan.invocation.args[1],
        result: "planned",
        risks: plan.evidence.risks,
        skippedChecks: plan.evidence.skippedChecks
      })
    );
  }

  for (const skipped of report.skippedIssues) {
    events.push(
      createRunLogEvent("dry_run_issue_skipped", {
        workerRole: "symphony_observability_pilot_worker",
        issueId: skipped.id,
        issueIdentifier: skipped.identifier,
        project,
        adapterMode: "dry-run",
        result: "skipped",
        reason: skipped.reason,
        eligibilityReasons: skipped.eligibilityReasons,
        missingLabels: skipped.missingLabels,
        risks: ["Issue was not planned for Codex launch."],
        skippedChecks: ["live Codex app-server subprocess launch"]
      })
    );
  }

  events.push(
    createRunLogEvent("dry_run_completed", {
      workerRole: "symphony_observability_pilot_worker",
      project,
      adapterMode: "dry-run",
      command: report.dispatchPlan.plans[0]?.invocation.args[1] ?? "codex app-server",
      result: report.pilotGate.status === "failed" ? "blocked" : "completed",
      eligibleCount: report.eligibleIssues.length,
      skippedCount: report.skippedIssues.length,
      capacity: {
        maxConcurrentAgents: report.capacity.maxConcurrentAgents,
        runningCount: report.capacity.runningCount,
        availableSlots: report.capacity.availableSlots
      },
      pilotGate: report.pilotGate as unknown as JsonObject,
      risks: ["Dry-run evidence only; live Codex execution remains fail-closed."],
      skippedChecks: ["live Linear polling", "live issue mutation", "live Codex app-server execution"]
    })
  );

  return events;
}

function summarizeIssue(issue: { id?: string | null; identifier?: string | null; title?: string | null; state?: string | null }): IssueSummary {
  return {
    id: issue.id ?? null,
    identifier: issue.identifier ?? null,
    title: issue.title ?? null,
    state: issue.state ?? null
  };
}

function summarizeSkip(skip: SchedulerSkip): DryRunSkipSummary {
  return {
    ...summarizeIssue(skip.issue),
    reason: skip.reason,
    eligibilityReasons: skip.eligibility.reasons,
    missingLabels: skip.eligibility.missingLabels
  };
}

function collectObservedReadyIssueIdentifiers(decision: SchedulerDecision): string[] {
  const identifiers = [
    ...decision.dispatch.map((entry) => entry.issue.identifier),
    ...decision.skipped
      .filter((skip) => skip.eligibility.eligible)
      .map((skip) => skip.issue.identifier)
  ];

  return [...new Set(identifiers.filter((identifier): identifier is string => identifier !== undefined && identifier !== null))];
}

function buildPilotGateSummary(
  expectedReadyIssueIdentifiers: readonly string[] | undefined,
  observedReadyIssueIdentifiers: readonly string[]
): DocsOnlyPilotGateSummary {
  const expected = normalizeIdentifiers(expectedReadyIssueIdentifiers ?? []);
  const observed = normalizeIdentifiers(observedReadyIssueIdentifiers);
  const criteria = [
    "Dry-run evidence exists before any live pilot claim.",
    "Only explicitly expected docs-only issues are dispatch-eligible.",
    "Live Codex execution remains fail-closed until separately approved.",
    "No Intelligent Terminal production files are touched by this packet."
  ];

  if (expected.length === 0) {
    return {
      status: "not_evaluated",
      livePilotPassed: false,
      onlyIntendedReadyIssuesEligible: null,
      expectedReadyIssueIdentifiers: [],
      observedReadyIssueIdentifiers: observed,
      criteria,
      notes: ["No expected ready issue list was supplied, so the docs-only pilot gate is staged but not passed."]
    };
  }

  const onlyExpected = sameStringSet(expected, observed);
  return {
    status: onlyExpected ? "passed" : "failed",
    livePilotPassed: false,
    onlyIntendedReadyIssuesEligible: onlyExpected,
    expectedReadyIssueIdentifiers: expected,
    observedReadyIssueIdentifiers: observed,
    criteria,
    notes: onlyExpected
      ? ["Dry-run evidence indicates only the intended docs-only issues were dispatch-eligible."]
      : ["Dry-run evidence did not match the expected ready issue set."]
  };
}

function normalizeIdentifiers(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => b[index] === value);
}

function jsonProject(report: DryRunEvidenceReport): JsonObject {
  return {
    id: report.project.id,
    slug: report.project.slug
  };
}
