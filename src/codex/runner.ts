import path from "node:path";

import {
  CodexAppServerError,
  createStdioCodexAppServerClient,
  type AppServerCleanupResult,
  type CodexAppServerClient,
  type CodexAppServerEvent
} from "./appServerClient.js";
import { createRunLogEvent, type JsonObject, type RunLogEvent } from "../logging/jsonl.js";
import type { WorkflowConfig } from "../workflow/config.js";
import {
  ensureIssueWorkspace,
  isPathInsideRoot,
  resolveIssueWorkspace,
  type IssueWorkspace,
  type IssueWorkspacePlan
} from "../workspace/manager.js";
import {
  CODEX_APP_SERVER_STDIO_COMMAND,
  isCodexAppServerStdioCommand,
  normalizeCodexLaunchCommand
} from "./launchContract.js";

export type CodexRunnerMode = "dry-run" | "live";
export type CodexRunExitState = "planned" | "dry_run" | "blocked" | "completed" | "failed";
export type CodexLaunchStrategy = "direct" | "shell";

export type CodexRunnerErrorCode =
  | "codex_app_server_contract_unverified"
  | "codex_app_server_malformed"
  | "codex_app_server_port_exit"
  | "codex_app_server_response_error"
  | "codex_app_server_response_timeout"
  | "codex_app_server_turn_cancelled"
  | "codex_app_server_turn_failed"
  | "codex_app_server_turn_input_required"
  | "codex_app_server_turn_stalled"
  | "codex_app_server_turn_timeout"
  | "codex_cleanup_failed"
  | "codex_issue_metadata_invalid"
  | "codex_launch_command_invalid"
  | "codex_launch_wrapper_invalid"
  | "codex_live_acknowledgement_missing"
  | "codex_live_launch_not_enabled"
  | "codex_prompt_empty"
  | "codex_workspace_cwd_mismatch"
  | "codex_workspace_outside_root"
  | "codex_workspace_preparation_failed";

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
  strategy: CodexLaunchStrategy;
  command: string;
  executable: string;
  args: readonly string[];
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

export interface CodexRunPolicies {
  approvalPolicy?: unknown;
  threadSandbox?: unknown;
  turnSandboxPolicy?: unknown;
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
  policies: CodexRunPolicies;
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
  threadId?: string;
  turnId?: string;
  sessionId?: string;
  cleanup?: AppServerCleanupResult;
  events?: RunLogEvent[];
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

export interface LiveCodexRunnerAdapterOptions {
  acknowledged: boolean;
  prompt: string;
  client?: CodexAppServerClient;
}

export interface RunCodexPlanOptions {
  allowLive?: boolean;
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

const LIVE_RISKS = [
  "Live Codex app-server execution can mutate the issue workspace and must remain explicitly acknowledged."
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
  const invocation = buildLaunchInvocation(mode, command, workspace.path);

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
    policies: {
      ...(input.config.codex.approvalPolicy !== undefined
        ? { approvalPolicy: input.config.codex.approvalPolicy }
        : {}),
      ...(input.config.codex.threadSandbox !== undefined
        ? { threadSandbox: input.config.codex.threadSandbox }
        : {}),
      ...(input.config.codex.turnSandboxPolicy !== undefined
        ? { turnSandboxPolicy: input.config.codex.turnSandboxPolicy }
        : {})
    },
    evidence: buildEvidence({
      issue,
      workspacePath: workspace.path,
      command,
      adapterMode: mode,
      exitState: "planned",
      risks: mode === "dry-run" ? DRY_RUN_RISKS : LIVE_RISKS,
      skippedChecks: mode === "dry-run" ? DRY_RUN_SKIPPED_CHECKS : [],
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

  const command = plan.invocation.command.trim();
  if (command.length === 0 || command !== plan.evidence.command) {
    errors.push(
      new CodexRunnerError(
        "codex_launch_command_invalid",
        "Codex runner command evidence must match a non-empty launch command."
      )
    );
  }

  if (plan.mode === "dry-run" && !isShellInvocation(plan)) {
    errors.push(
      new CodexRunnerError(
        "codex_launch_wrapper_invalid",
        "Dry-run Codex runner invocation must preserve bash -lc <codex.command> planning evidence."
      )
    );
  }

  if (plan.mode === "live" && !isCodexAppServerStdioCommand(command)) {
    errors.push(
      new CodexRunnerError(
        "codex_launch_command_invalid",
        `Live Codex runner requires CODEX-54 verified stdio command: ${CODEX_APP_SERVER_STDIO_COMMAND}.`
      )
    );
  }

  if (plan.mode === "live" && !isDirectInvocation(plan)) {
    errors.push(
      new CodexRunnerError(
        "codex_launch_wrapper_invalid",
        "Live Codex runner must use direct process launch and must not use a shell wrapper."
      )
    );
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function buildLaunchInvocation(mode: CodexRunnerMode, command: string, cwd: string): CodexLaunchInvocation {
  if (mode === "live") {
    const [executable = "", ...args] = normalizeCodexLaunchCommand(command).split(" ").filter(Boolean);
    return {
      strategy: "direct",
      command,
      executable,
      args,
      cwd
    };
  }

  return {
    strategy: "shell",
    command,
    executable: "bash",
    args: ["-lc", command],
    cwd
  };
}

function isShellInvocation(plan: CodexRunPlan): boolean {
  return (
    plan.invocation.strategy === "shell" &&
    plan.invocation.executable === "bash" &&
    plan.invocation.args.length === 2 &&
    plan.invocation.args[0] === "-lc" &&
    plan.invocation.args[1] === plan.invocation.command
  );
}

function isDirectInvocation(plan: CodexRunPlan): boolean {
  const [expectedExecutable = "", ...expectedArgs] = normalizeCodexLaunchCommand(plan.invocation.command)
    .split(" ")
    .filter(Boolean);

  return (
    plan.invocation.strategy === "direct" &&
    plan.invocation.executable === expectedExecutable &&
    plan.invocation.args.length === expectedArgs.length &&
    plan.invocation.args.every((arg, index) => arg === expectedArgs[index])
  );
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
        command: plan.invocation.command,
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

export function createLiveCodexRunnerAdapter(options: LiveCodexRunnerAdapterOptions): CodexRunnerAdapter {
  return {
    mode: "live",
    async run(plan) {
      if (!options.acknowledged) {
        return blockedResult(
          plan,
          new CodexRunnerError(
            "codex_live_acknowledgement_missing",
            "Live Codex launch requires explicit acknowledgement."
          )
        );
      }

      const validation = validateCodexRunPlan(plan);
      if (!validation.ok) {
        return blockedResult(plan, validation.errors[0] ?? unknownBlockedError());
      }

      const events: RunLogEvent[] = [];
      const appendEvent = (event: string, fields: Record<string, unknown> = {}, level: RunLogEvent["level"] = "info") => {
        events.push(
          createRunLogEvent(
            event,
            normalizeEventFields({
              workerRole: "symphony_one_shot_live_runner",
              issueId: plan.issue.id,
              issueIdentifier: plan.issue.identifier,
              adapterMode: "live",
              command: plan.invocation.command,
              workspace: {
                root: plan.workspace.rootPath,
                key: plan.workspace.workspaceKey,
                path: plan.workspace.path
              },
              ...fields
            }),
            { level }
          )
        );
      };

      appendEvent("live_issue_started", {
        result: "started",
        timeouts: {
          readTimeoutMs: plan.timeouts.readTimeoutMs,
          turnTimeoutMs: plan.timeouts.turnTimeoutMs,
          stallTimeoutMs: plan.timeouts.stallTimeoutMs
        }
      });

      try {
        const workspace = await prepareLiveWorkspace(plan);
        appendEvent("live_workspace_prepared", {
          result: workspace.createdNow ? "created" : "verified",
          workspace: {
            root: workspace.rootPath,
            key: workspace.workspaceKey,
            path: workspace.path,
            createdNow: workspace.createdNow
          }
        });

        const client = options.client ?? createStdioCodexAppServerClient();
        const result = await client.run({
          plan,
          prompt: options.prompt,
          onEvent: (event) => appendAppServerEvent(event, appendEvent)
        });
        appendEvent("live_issue_completed", {
          result: "completed",
          thread_id: result.threadId,
          turn_id: result.turnId,
          session_id: result.sessionId,
          cleanup: result.cleanup
        });

        return {
          mode: "live",
          issue: plan.issue,
          workspacePath: plan.workspace.path,
          command: plan.invocation.command,
          exitState: "completed",
          evidence: {
            ...plan.evidence,
            adapterMode: "live",
            exitState: "completed",
            skippedChecks: []
          },
          threadId: result.threadId,
          turnId: result.turnId,
          sessionId: result.sessionId,
          cleanup: result.cleanup,
          events
        };
      } catch (error) {
        const runnerError = normalizeLiveRunnerError(error);
        appendEvent(
          "live_issue_failed",
          {
            result: "failed",
            error: {
              code: runnerError.code,
              message: runnerError.message
            }
          },
          "error"
        );

        return {
          ...blockedResult(plan, runnerError),
          exitState: "failed",
          evidence: {
            ...plan.evidence,
            adapterMode: "live",
            exitState: "failed",
            risks: [...plan.evidence.risks, runnerError.message],
            skippedChecks: []
          },
          events
        };
      }
    }
  };
}

export async function runCodexPlan(
  plan: CodexRunPlan,
  adapter: CodexRunnerAdapter = createDryRunCodexRunnerAdapter(),
  options: RunCodexPlanOptions = {}
): Promise<CodexRunResult> {
  if (adapter.mode === "live" && options.allowLive !== true) {
    return blockedResult(
      plan,
      new CodexRunnerError(
        "codex_live_launch_not_enabled",
        "Live Codex launch is not enabled without explicit one-shot live runner acknowledgement."
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
    command: plan.invocation.command,
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

async function prepareLiveWorkspace(plan: CodexRunPlan): Promise<IssueWorkspace> {
  try {
    const workspace = await ensureIssueWorkspace(plan.workspace.rootPath, plan.issue.identifier);
    if (
      path.resolve(workspace.rootPath) !== path.resolve(plan.workspace.rootPath) ||
      workspace.workspaceKey !== plan.workspace.workspaceKey ||
      path.resolve(workspace.path) !== path.resolve(plan.workspace.path)
    ) {
      throw new CodexRunnerError(
        "codex_workspace_cwd_mismatch",
        "Prepared workspace must match the planned per-issue workspace path."
      );
    }

    return workspace;
  } catch (error) {
    if (error instanceof CodexRunnerError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new CodexRunnerError("codex_workspace_preparation_failed", message);
  }
}

function appendAppServerEvent(
  event: CodexAppServerEvent,
  appendEvent: (event: string, fields?: Record<string, unknown>, level?: RunLogEvent["level"]) => void
): void {
  const { event: eventName, ...fields } = event;
  const level = eventName.includes("failed") || eventName === "malformed" ? "error" : "info";
  appendEvent(eventName, fields, level);
}

function normalizeLiveRunnerError(error: unknown): CodexRunnerError {
  if (error instanceof CodexRunnerError) {
    return error;
  }

  if (error instanceof CodexAppServerError) {
    return new CodexRunnerError(mapAppServerErrorCode(error.code), error.message);
  }

  if (error instanceof Error) {
    return new CodexRunnerError("codex_app_server_response_error", error.message);
  }

  return new CodexRunnerError("codex_app_server_response_error", String(error));
}

function mapAppServerErrorCode(code: CodexAppServerError["code"]): CodexRunnerErrorCode {
  switch (code) {
    case "cleanup_failed":
      return "codex_cleanup_failed";
    case "malformed":
      return "codex_app_server_malformed";
    case "port_exit":
      return "codex_app_server_port_exit";
    case "response_error":
      return "codex_app_server_response_error";
    case "response_timeout":
      return "codex_app_server_response_timeout";
    case "turn_cancelled":
      return "codex_app_server_turn_cancelled";
    case "turn_failed":
      return "codex_app_server_turn_failed";
    case "turn_input_required":
      return "codex_app_server_turn_input_required";
    case "turn_stalled":
      return "codex_app_server_turn_stalled";
    case "turn_timeout":
      return "codex_app_server_turn_timeout";
  }
}

function normalizeEventFields(fields: Record<string, unknown>): JsonObject {
  return dropUndefinedForJson(fields) as JsonObject;
}

function dropUndefinedForJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(dropUndefinedForJson);
  }

  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      if (fieldValue !== undefined) {
        output[key] = dropUndefinedForJson(fieldValue);
      }
    }
    return output;
  }

  return value;
}
