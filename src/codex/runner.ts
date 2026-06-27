import path from "node:path";

import type { WorkflowConfig } from "../workflow/config.js";
import {
  isPathInsideRoot,
  resolveIssueWorkspace,
  type IssueWorkspacePlan
} from "../workspace/manager.js";

export type CodexRunnerMode = "dry-run" | "live";
export type CodexRunExitState = "planned" | "dry_run" | "blocked";

export type CodexRunnerErrorCode =
  | "codex_app_server_contract_unverified"
  | "codex_issue_metadata_invalid"
  | "codex_launch_command_invalid"
  | "codex_live_launch_not_enabled"
  | "codex_prompt_empty"
  | "codex_workspace_cwd_mismatch"
  | "codex_workspace_outside_root";

export class CodexRunnerError extends Error {
  readonly code: CodexRunnerErrorCode;

  constructor(code: CodexRunnerErrorCode, message: string) {
    super(message);
    this.name = "CodexRunnerError";
    this.code = code;
  }
}

export interface CodexRunIssue {
  id: string;
  identifier: string;
  title: string;
}

export interface CodexLaunchInvocation {
  executable: "bash";
  args: readonly ["-lc", string];
  cwd: string;
}

export interface CodexPromptEvidence {
  length: number;
  preview: string;
}

export interface CodexRunTimeouts {
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface CodexRunEvidence {
  issueId: string;
  issueIdentifier: string;
  workspacePath: string;
  command: string;
  adapterMode: CodexRunnerMode;
  exitState: CodexRunExitState;
  risks: string[];
  skippedChecks: string[];
  followUps: string[];
}

export interface CodexRunPlan {
  mode: CodexRunnerMode;
  issue: CodexRunIssue;
  workspace: IssueWorkspacePlan;
  invocation: CodexLaunchInvocation;
  prompt: CodexPromptEvidence;
  timeouts: CodexRunTimeouts;
  evidence: CodexRunEvidence;
}

export interface CodexRunResult {
  mode: CodexRunnerMode;
  issue: CodexRunIssue;
  workspacePath: string;
  command: string;
  exitState: Exclude<CodexRunExitState, "planned">;
  evidence: CodexRunEvidence;
  error?: {
    code: CodexRunnerErrorCode;
    message: string;
  };
}

export interface PlanCodexRunInput {
  config: Pick<WorkflowConfig, "codex" | "workspace">;
  issue: CodexRunIssue;
  prompt: string;
  mode?: CodexRunnerMode;
}

export interface CodexPlanValidationResult {
  ok: boolean;
  errors: CodexRunnerError[];
}

export interface CodexRunnerAdapter {
  readonly mode: CodexRunnerMode;
  run(plan: CodexRunPlan): Promise<CodexRunResult>;
}

const DRY_RUN_RISKS = [
  "Codex app-server protocol is not exercised by this dry run.",
  "No repository files are modified by the runner adapter."
];

const DRY_RUN_SKIPPED_CHECKS = [
  "live Codex app-server subprocess launch",
  "app-server protocol handshake",
  "thread and turn streaming",
  "runner process lifecycle management"
];

const APP_SERVER_FOLLOW_UPS = [
  "CODEX-51 must add observability around runner events before pilot use.",
  "A later packet must verify the targeted codex app-server protocol schema before live execution."
];

export function planCodexRun(input: PlanCodexRunInput): CodexRunPlan {
  const issue = normalizeIssue(input.issue);
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    throw new CodexRunnerError("codex_prompt_empty", "Codex runner prompt must not be empty.");
  }

  const command = input.config.codex.command.trim();
  if (command.length === 0) {
    throw new CodexRunnerError("codex_launch_command_invalid", "codex.command must not be empty.");
  }

  const workspace = resolveIssueWorkspace(input.config.workspace.root, issue.identifier);
  const mode = input.mode ?? "dry-run";
  const invocation: CodexLaunchInvocation = {
    executable: "bash",
    args: ["-lc", command],
    cwd: workspace.path
  };

  return {
    mode,
    issue,
    workspace,
    invocation,
    prompt: {
      length: prompt.length,
      preview: buildPromptPreview(prompt)
    },
    timeouts: {
      turnTimeoutMs: input.config.codex.turnTimeoutMs,
      readTimeoutMs: input.config.codex.readTimeoutMs,
      stallTimeoutMs: input.config.codex.stallTimeoutMs
    },
    evidence: buildEvidence({
      issue,
      workspacePath: workspace.path,
      command,
      adapterMode: mode,
      exitState: "planned",
      risks: mode === "dry-run" ? DRY_RUN_RISKS : ["Live launch is blocked until the app-server contract is verified."],
      skippedChecks: DRY_RUN_SKIPPED_CHECKS,
      followUps: APP_SERVER_FOLLOW_UPS
    })
  };
}

export function validateCodexRunPlan(plan: CodexRunPlan): CodexPlanValidationResult {
  const errors: CodexRunnerError[] = [];

  if (!isPathInsideRoot(plan.workspace.rootPath, plan.workspace.path)) {
    errors.push(
      new CodexRunnerError(
        "codex_workspace_outside_root",
        "Codex runner workspace must stay inside the configured workspace root."
      )
    );
  }

  if (path.resolve(plan.invocation.cwd) !== path.resolve(plan.workspace.path)) {
    errors.push(
      new CodexRunnerError(
        "codex_workspace_cwd_mismatch",
        "Codex runner invocation cwd must equal the per-issue workspace path."
      )
    );
  }

  if (plan.invocation.executable !== "bash" || plan.invocation.args[0] !== "-lc") {
    errors.push(
      new CodexRunnerError(
        "codex_launch_command_invalid",
        "Codex runner invocation must use bash -lc <codex.command>."
      )
    );
  }

  const command = plan.invocation.args[1].trim();
  if (command.length === 0 || command !== plan.evidence.command) {
    errors.push(
      new CodexRunnerError(
        "codex_launch_command_invalid",
        "Codex runner command evidence must match a non-empty launch command."
      )
    );
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function createDryRunCodexRunnerAdapter(): CodexRunnerAdapter {
  return {
    mode: "dry-run",
    async run(plan) {
      const validation = validateCodexRunPlan(plan);
      if (!validation.ok) {
        return blockedResult(plan, validation.errors[0] ?? unknownBlockedError());
      }

      return {
        mode: "dry-run",
        issue: plan.issue,
        workspacePath: plan.workspace.path,
        command: plan.invocation.args[1],
        exitState: "dry_run",
        evidence: {
          ...plan.evidence,
          adapterMode: "dry-run",
          exitState: "dry_run",
          skippedChecks: [...plan.evidence.skippedChecks, "process launch intentionally skipped"]
        }
      };
    }
  };
}

export function createFailClosedLiveCodexRunnerAdapter(): CodexRunnerAdapter {
  return {
    mode: "live",
    async run(plan) {
      return blockedResult(
        plan,
        new CodexRunnerError(
          "codex_app_server_contract_unverified",
          "Live Codex app-server execution is blocked until the protocol contract is verified."
        )
      );
    }
  };
}

export async function runCodexPlan(
  plan: CodexRunPlan,
  adapter: CodexRunnerAdapter = createDryRunCodexRunnerAdapter()
): Promise<CodexRunResult> {
  if (adapter.mode === "live") {
    return blockedResult(
      plan,
      new CodexRunnerError(
        "codex_live_launch_not_enabled",
        "Live Codex launch is not enabled by default in CODEX-50."
      )
    );
  }

  return adapter.run(plan);
}

function normalizeIssue(issue: CodexRunIssue): CodexRunIssue {
  const id = issue.id.trim();
  const identifier = issue.identifier.trim();
  const title = issue.title.trim();

  if (id.length === 0 || identifier.length === 0 || title.length === 0) {
    throw new CodexRunnerError(
      "codex_issue_metadata_invalid",
      "Codex runner requires issue id, identifier, and title."
    );
  }

  return { id, identifier, title };
}

function buildPromptPreview(prompt: string): string {
  return prompt.length <= 120 ? prompt : `${prompt.slice(0, 117)}...`;
}

function buildEvidence(input: {
  issue: CodexRunIssue;
  workspacePath: string;
  command: string;
  adapterMode: CodexRunnerMode;
  exitState: CodexRunExitState;
  risks: string[];
  skippedChecks: string[];
  followUps: string[];
}): CodexRunEvidence {
  return {
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    workspacePath: input.workspacePath,
    command: input.command,
    adapterMode: input.adapterMode,
    exitState: input.exitState,
    risks: input.risks,
    skippedChecks: input.skippedChecks,
    followUps: input.followUps
  };
}

function blockedResult(plan: CodexRunPlan, error: CodexRunnerError): CodexRunResult {
  return {
    mode: plan.mode,
    issue: plan.issue,
    workspacePath: plan.workspace.path,
    command: plan.invocation.args[1],
    exitState: "blocked",
    evidence: {
      ...plan.evidence,
      exitState: "blocked",
      risks: [...plan.evidence.risks, error.message]
    },
    error: {
      code: error.code,
      message: error.message
    }
  };
}

function unknownBlockedError(): CodexRunnerError {
  return new CodexRunnerError("codex_app_server_contract_unverified", "Codex runner validation failed.");
}
