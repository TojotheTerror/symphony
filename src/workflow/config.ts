import os from "node:os";
import path from "node:path";

import { z } from "zod";

import { CODEX_APP_SERVER_STDIO_COMMAND } from "../codex/launchContract.js";
import { WorkflowError } from "./errors.js";

export const SYMPHONY_READY_LABEL = "symphony-ready";

const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"] as const;
const DEFAULT_REVIEW_STATES = ["In Review"] as const;
const DEFAULT_TERMINAL_STATES = ["Done", "Canceled", "Duplicate"] as const;
const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";

const nonBlankString = z.string().trim().min(1);
const stringList = z.array(z.string());

const rawTrackerSchema = z
  .object({
    kind: z.string().optional(),
    endpoint: z.string().optional(),
    api_key: z.string().optional(),
    project_slug: z.string().optional(),
    project_id: z.string().optional(),
    required_labels: stringList.optional(),
    active_states: stringList.optional(),
    review_states: stringList.optional(),
    terminal_states: stringList.optional()
  })
  .strip();

const rawAgentSchema = z
  .object({
    max_concurrent_agents: z.number().int().positive().optional(),
    max_turns: z.number().int().positive().optional(),
    max_retry_backoff_ms: z.number().int().positive().optional()
  })
  .strip();

const rawCodexSchema = z
  .object({
    command: z.string().optional(),
    approval_policy: z.unknown().optional(),
    thread_sandbox: z.unknown().optional(),
    turn_sandbox_policy: z.unknown().optional(),
    turn_timeout_ms: z.number().int().optional(),
    read_timeout_ms: z.number().int().positive().optional(),
    stall_timeout_ms: z.number().int().optional()
  })
  .strip();

const rawWorkspaceSchema = z
  .object({
    root: z.string().optional()
  })
  .strip();

const rawWorkflowConfigSchema = z
  .object({
    tracker: rawTrackerSchema.optional(),
    agent: rawAgentSchema.optional(),
    codex: rawCodexSchema.optional(),
    workspace: rawWorkspaceSchema.optional()
  })
  .strip();

export interface WorkflowConfigOptions {
  env?: Record<string, string | undefined>;
  workflowFilePath?: string;
  cwd?: string;
}

export interface WorkflowConfig {
  tracker: LinearTrackerConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  workspace: WorkspaceConfig;
}

export interface LinearTrackerConfig {
  kind: "linear";
  endpoint: string;
  requiredLabels: string[];
  activeStates: string[];
  reviewStates: string[];
  terminalStates: string[];
  apiKey?: string;
  projectSlug?: string;
  projectId?: string;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
}

export interface CodexConfig {
  command: string;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
  approvalPolicy?: unknown;
  threadSandbox?: unknown;
  turnSandboxPolicy?: unknown;
}

export interface WorkspaceConfig {
  root: string;
}

export function validateWorkflowConfig(
  rawConfig: Record<string, unknown>,
  options: WorkflowConfigOptions = {}
): WorkflowConfig {
  const parsed = rawWorkflowConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new WorkflowError(
      "workflow_config_invalid",
      "WORKFLOW.md config has invalid field types.",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    );
  }

  const tracker = buildTrackerConfig(parsed.data.tracker, options);
  const agent = buildAgentConfig(parsed.data.agent);
  const codex = buildCodexConfig(parsed.data.codex);
  const workspace = buildWorkspaceConfig(parsed.data.workspace, options);

  return {
    tracker,
    agent,
    codex,
    workspace
  };
}

function buildTrackerConfig(
  raw: z.infer<typeof rawTrackerSchema> | undefined,
  options: WorkflowConfigOptions
): LinearTrackerConfig {
  const kind = raw?.kind ?? "linear";
  if (kind !== "linear") {
    throw new WorkflowError("workflow_config_invalid", "Unsupported tracker.kind.", [
      `tracker.kind must be 'linear', received '${kind}'.`
    ]);
  }

  const endpoint = raw?.endpoint?.trim() || DEFAULT_LINEAR_ENDPOINT;
  const projectSlug = normalizeOptionalString(raw?.project_slug);
  const projectId = normalizeOptionalString(raw?.project_id);
  if (projectSlug === undefined && projectId === undefined) {
    throw new WorkflowError("workflow_config_invalid", "Linear tracker project scope is required.", [
      "Set tracker.project_slug or tracker.project_id so one project's issues cannot dispatch another project's work."
    ]);
  }

  const requiredLabels = normalizeRequiredLabels(raw?.required_labels ?? [SYMPHONY_READY_LABEL]);
  const activeStates = normalizeStateList(raw?.active_states ?? [...DEFAULT_ACTIVE_STATES], "active_states");
  const reviewStates = normalizeStateList(raw?.review_states ?? [...DEFAULT_REVIEW_STATES], "review_states");
  const terminalStates = normalizeStateList(
    raw?.terminal_states ?? [...DEFAULT_TERMINAL_STATES],
    "terminal_states"
  );
  const apiKey = resolveOptionalEnvString(raw?.api_key, options.env ?? process.env);

  return {
    kind: "linear",
    endpoint,
    requiredLabels,
    activeStates,
    reviewStates,
    terminalStates,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(projectSlug !== undefined ? { projectSlug } : {}),
    ...(projectId !== undefined ? { projectId } : {})
  };
}

function buildAgentConfig(raw: z.infer<typeof rawAgentSchema> | undefined): AgentConfig {
  return {
    maxConcurrentAgents: raw?.max_concurrent_agents ?? 2,
    maxTurns: raw?.max_turns ?? 20,
    maxRetryBackoffMs: raw?.max_retry_backoff_ms ?? 300_000
  };
}

function buildCodexConfig(raw: z.infer<typeof rawCodexSchema> | undefined): CodexConfig {
  if (raw?.command !== undefined && raw.command.trim().length === 0) {
    throw new WorkflowError("workflow_config_invalid", "codex.command must not be empty.");
  }

  const command = raw?.command?.trim() || CODEX_APP_SERVER_STDIO_COMMAND;
  const config: CodexConfig = {
    command,
    turnTimeoutMs: raw?.turn_timeout_ms ?? 3_600_000,
    readTimeoutMs: raw?.read_timeout_ms ?? 5_000,
    stallTimeoutMs: raw?.stall_timeout_ms ?? 300_000
  };

  if (config.turnTimeoutMs <= 0) {
    throw new WorkflowError("workflow_config_invalid", "codex.turn_timeout_ms must be positive.");
  }

  if (raw !== undefined && "approval_policy" in raw) {
    config.approvalPolicy = raw.approval_policy;
  }
  if (raw !== undefined && "thread_sandbox" in raw) {
    config.threadSandbox = raw.thread_sandbox;
  }
  if (raw !== undefined && "turn_sandbox_policy" in raw) {
    config.turnSandboxPolicy = raw.turn_sandbox_policy;
  }

  return config;
}

function buildWorkspaceConfig(
  raw: z.infer<typeof rawWorkspaceSchema> | undefined,
  options: WorkflowConfigOptions
): WorkspaceConfig {
  const workflowDir = options.workflowFilePath
    ? path.dirname(path.resolve(options.workflowFilePath))
    : path.resolve(options.cwd ?? process.cwd());
  const rootValue = raw?.root ?? path.join(os.tmpdir(), "symphony_workspaces");

  return {
    root: resolveWorkspaceRoot(rootValue, workflowDir, options.env ?? process.env)
  };
}

function normalizeRequiredLabels(labels: string[]): string[] {
  const normalized = labels.map(normalizeLabel);
  const blankIndex = normalized.findIndex((label) => label.length === 0);
  if (blankIndex !== -1) {
    throw new WorkflowError("workflow_config_invalid", "tracker.required_labels cannot contain blanks.", [
      `Blank required label at index ${blankIndex}.`
    ]);
  }

  const uniqueLabels = [...new Set(normalized)];
  if (!uniqueLabels.includes(SYMPHONY_READY_LABEL)) {
    throw new WorkflowError("workflow_config_invalid", "tracker.required_labels must include symphony-ready.", [
      "The broad 'symphony' label alone is never dispatch-eligible."
    ]);
  }

  return uniqueLabels;
}

function normalizeStateList(states: string[], fieldName: string): string[] {
  const normalized = states.map((state) => state.trim());
  const blankIndex = normalized.findIndex((state) => state.length === 0);
  if (blankIndex !== -1) {
    throw new WorkflowError("workflow_config_invalid", `tracker.${fieldName} cannot contain blanks.`, [
      `Blank state at index ${blankIndex}.`
    ]);
  }

  return [...new Set(normalized)];
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function resolveOptionalEnvString(
  value: string | undefined,
  env: Record<string, string | undefined>
): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (trimmed === undefined) {
    return undefined;
  }

  const envMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (envMatch?.[1] === undefined) {
    return trimmed;
  }

  return normalizeOptionalString(env[envMatch[1]]);
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function resolveWorkspaceRoot(
  value: string,
  workflowDir: string,
  env: Record<string, string | undefined>
): string {
  const rootResult = nonBlankString.safeParse(value);
  if (!rootResult.success) {
    throw new WorkflowError("workflow_config_invalid", "workspace.root must not be empty.");
  }

  const trimmed = rootResult.data;
  const envMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  const envResolved = envMatch?.[1] !== undefined ? env[envMatch[1]] : undefined;
  const expanded = envMatch?.[1] !== undefined ? envResolved : trimmed;

  if (expanded === undefined || expanded.trim().length === 0) {
    throw new WorkflowError("workflow_config_invalid", "workspace.root environment reference is empty.", [
      `workspace.root references ${trimmed}.`
    ]);
  }

  const homeExpanded =
    expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")
      ? path.join(os.homedir(), expanded.slice(2))
      : expanded;

  return path.resolve(workflowDir, homeExpanded);
}
