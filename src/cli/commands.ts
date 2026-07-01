import { readFile } from "node:fs/promises";
import path from "node:path";

import { execa } from "execa";
import { z } from "zod";

import { type CodexAppServerClient } from "../codex/appServerClient.js";
import {
  CodexRunnerError,
  createLiveCodexRunnerAdapter,
  planCodexRun,
  runCodexPlan
} from "../codex/runner.js";
import {
  appendRunLogEvents,
  createRunLogEvent,
  readRunLog,
  summarizeRunLog,
  validateFreshLiveRunLog
} from "../logging/jsonl.js";
import {
  createDryRunReport,
  dryRunReportToLogEvents,
  parseSchedulerIssuesJson
} from "../orchestrator/report.js";
import { planOneShotLiveDispatch } from "../orchestrator/liveDispatch.js";
import {
  formatBoundaryReport,
  parseGitRemoteVerbose,
  validateRepoBoundary
} from "../safety/repoBoundary.js";
import { formatWorkflowError, WorkflowError } from "../workflow/errors.js";
import { loadWorkflow } from "../workflow/loadWorkflow.js";

export interface CliStreams {
  write(message: string): void;
}

export interface CliContext {
  cwd: string;
  stdout: CliStreams;
  stderr: CliStreams;
  createAppServerClient?: () => CodexAppServerClient;
}

const VERSION = "0.0.0";

const SafetyArgsSchema = z.object({
  writeTarget: z.string().min(1, "--write-target must not be empty")
});

const RunnerPlanArgsSchema = z.object({
  issueId: z.string().min(1, "--issue-id must not be empty"),
  issueIdentifier: z.string().min(1, "--issue-identifier must not be empty"),
  issueTitle: z.string().min(1, "--issue-title must not be empty"),
  workflow: z.string().optional()
});

const DryRunArgsSchema = z.object({
  issues: z.string().min(1, "--issues must not be empty"),
  workflow: z.string().optional(),
  log: z.string().optional(),
  expectReady: z.string().optional()
});

const LogArgsSchema = z.object({
  log: z.string().min(1, "--log must not be empty"),
  limit: z.coerce.number().int().positive().default(5)
});

const RunnerLiveArgsSchema = z.object({
  issues: z.string().min(1, "--issues must not be empty"),
  log: z.string().min(1, "--log must not be empty"),
  expectReady: z.string().min(1, "--expect-ready must name exactly one issue identifier"),
  acknowledgeLiveRunner: z.string().optional(),
  workflow: z.string().optional()
});

const HELP = `Symphony v0 TypeScript scaffold

Usage:
  symphony --help
  symphony --version
  symphony safety check --write-target <git-url-or-owner/repo>
  symphony runner plan --issue-id <id> --issue-identifier <key> --issue-title <title> [--workflow <path>]
  symphony runner live --issues <issues.json> --expect-ready <key> --log <runs.jsonl> --acknowledge-live-runner [--workflow <path>]
  symphony dry-run --issues <issues.json> [--workflow <path>] [--log <runs.jsonl>] [--expect-ready <key,key>]
  symphony status --log <runs.jsonl> [--limit <n>]
  symphony report --log <runs.jsonl>

Commands:
  safety check   Inspect git remotes and fail closed unless the write target is TojotheTerror/symphony.
  runner plan    Print a dry-run Codex launch plan without starting live Codex execution.
  runner live    Run one explicitly acknowledged, exactly matched live issue through Codex app-server.
  dry-run        Evaluate fixture issues, emit dry-run evidence, and optionally append JSONL logs.
  status         Summarize recent JSONL run evidence.
  report         Print the full JSONL-derived run evidence report.

This scaffold does not poll Linear, mutate issues, or merge PRs. Live Codex sessions are available
only through the guarded one-shot runner command.
`;

export async function runCli(args: string[], context: CliContext): Promise<number> {
  const [command, subcommand, ...rest] = args;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    context.stdout.write(HELP);
    return 0;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    context.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (command === "safety" && subcommand === "check") {
    return runSafetyCheck(rest, context);
  }

  if (command === "runner" && subcommand === "plan") {
    return runRunnerPlan(rest, context);
  }

  if (command === "runner" && subcommand === "live") {
    return runRunnerLive(rest, context);
  }

  if (command === "dry-run") {
    return runDryRun([subcommand, ...rest].filter((arg): arg is string => arg !== undefined), context);
  }

  if (command === "status") {
    return runStatus([subcommand, ...rest].filter((arg): arg is string => arg !== undefined), context);
  }

  if (command === "report") {
    return runReport([subcommand, ...rest].filter((arg): arg is string => arg !== undefined), context);
  }

  context.stderr.write(`Unknown command: ${args.join(" ")}\n\n${HELP}`);
  return 1;
}

async function runSafetyCheck(args: string[], context: CliContext): Promise<number> {
  const parsedArgs = parseSafetyArgs(args);
  const argsResult = SafetyArgsSchema.safeParse(parsedArgs);

  if (!argsResult.success) {
    context.stderr.write(`${argsResult.error.issues.map((issue) => issue.message).join("\n")}\n`);
    return 1;
  }

  const { stdout } = await execa("git", ["remote", "-v"], { cwd: context.cwd });
  const remotes = parseGitRemoteVerbose(stdout);
  const report = validateRepoBoundary({
    remotes,
    requestedWriteTarget: argsResult.data.writeTarget
  });

  const formatted = formatBoundaryReport(report);
  if (report.ok) {
    context.stdout.write(`${formatted}\n`);
    return 0;
  }

  context.stderr.write(`${formatted}\n`);
  return 1;
}

function parseSafetyArgs(args: string[]): { writeTarget?: string } {
  const parsed: { writeTarget?: string } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--write-target") {
      parsed.writeTarget = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (arg?.startsWith("--write-target=")) {
      parsed.writeTarget = arg.slice("--write-target=".length);
    }
  }

  return parsed;
}

async function runDryRun(args: string[], context: CliContext): Promise<number> {
  const parsedArgs = parseKeyValueArgs(args);
  const argsResult = DryRunArgsSchema.safeParse(parsedArgs);

  if (!argsResult.success) {
    context.stderr.write(`${argsResult.error.issues.map((issue) => issue.message).join("\n")}\n`);
    return 1;
  }

  try {
    const workflow = await loadWorkflow({
      cwd: context.cwd,
      ...(argsResult.data.workflow !== undefined ? { workflowPath: argsResult.data.workflow } : {})
    });
    const issueContents = await readFile(resolveCliPath(context.cwd, argsResult.data.issues), "utf8");
    const issues = parseSchedulerIssuesJson(JSON.parse(issueContents));
    const report = createDryRunReport({
      config: workflow.typedConfig,
      promptTemplate: workflow.promptTemplate,
      issues,
      expectedReadyIssueIdentifiers: parseCsv(argsResult.data.expectReady)
    });

    if (argsResult.data.log !== undefined) {
      await appendRunLogEvents(resolveCliPath(context.cwd, argsResult.data.log), dryRunReportToLogEvents(report));
    }

    context.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    context.stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

async function runStatus(args: string[], context: CliContext): Promise<number> {
  const parsedArgs = parseKeyValueArgs(args);
  const argsResult = LogArgsSchema.safeParse(parsedArgs);

  if (!argsResult.success) {
    context.stderr.write(`${argsResult.error.issues.map((issue) => issue.message).join("\n")}\n`);
    return 1;
  }

  try {
    const events = await readRunLog(resolveCliPath(context.cwd, argsResult.data.log));
    context.stdout.write(`${JSON.stringify(summarizeRunLog(events, argsResult.data.limit), null, 2)}\n`);
    return 0;
  } catch (error) {
    context.stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

async function runReport(args: string[], context: CliContext): Promise<number> {
  const parsedArgs = parseKeyValueArgs(args);
  const argsResult = LogArgsSchema.safeParse(parsedArgs);

  if (!argsResult.success) {
    context.stderr.write(`${argsResult.error.issues.map((issue) => issue.message).join("\n")}\n`);
    return 1;
  }

  try {
    const events = await readRunLog(resolveCliPath(context.cwd, argsResult.data.log));
    context.stdout.write(`${JSON.stringify({ status: summarizeRunLog(events, argsResult.data.limit), events }, null, 2)}\n`);
    return 0;
  } catch (error) {
    context.stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

async function runRunnerPlan(args: string[], context: CliContext): Promise<number> {
  const parsedArgs = parseRunnerPlanArgs(args);
  const argsResult = RunnerPlanArgsSchema.safeParse(parsedArgs);

  if (!argsResult.success) {
    context.stderr.write(`${argsResult.error.issues.map((issue) => issue.message).join("\n")}\n`);
    return 1;
  }

  let plan: ReturnType<typeof planCodexRun>;
  try {
    const workflow = await loadWorkflow({
      cwd: context.cwd,
      ...(argsResult.data.workflow !== undefined ? { workflowPath: argsResult.data.workflow } : {})
    });
    plan = planCodexRun({
      config: workflow.typedConfig,
      issue: {
        id: argsResult.data.issueId,
        identifier: argsResult.data.issueIdentifier,
        title: argsResult.data.issueTitle
      },
      prompt: workflow.promptTemplate
    });
  } catch (error) {
    context.stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }

  context.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  return 0;
}

async function runRunnerLive(args: string[], context: CliContext): Promise<number> {
  const parsedArgs = parseKeyValueArgs(args);
  const argsResult = RunnerLiveArgsSchema.safeParse(parsedArgs);

  if (!argsResult.success) {
    context.stderr.write(`${argsResult.error.issues.map((issue) => issue.message).join("\n")}\n`);
    return 1;
  }

  if (argsResult.data.acknowledgeLiveRunner !== "true") {
    context.stderr.write("Live runner requires --acknowledge-live-runner.\n");
    return 1;
  }

  const expectedReadyIssueIdentifiers = parseCsv(argsResult.data.expectReady);
  if (expectedReadyIssueIdentifiers.length !== 1) {
    context.stderr.write("Live runner requires exactly one --expect-ready issue identifier.\n");
    return 1;
  }
  const expectedReadyIssueIdentifier = expectedReadyIssueIdentifiers[0] ?? "";
  const logPath = resolveCliPath(context.cwd, argsResult.data.log);

  try {
    const existingLogEvents = await readRunLog(logPath);
    const logPolicy = validateFreshLiveRunLog(existingLogEvents, expectedReadyIssueIdentifier);
    if (!logPolicy.ok) {
      context.stderr.write(`${logPolicy.reason}: ${logPolicy.message}\n`);
      return 1;
    }

    const workflow = await loadWorkflow({
      cwd: context.cwd,
      ...(argsResult.data.workflow !== undefined ? { workflowPath: argsResult.data.workflow } : {})
    });
    const issueContents = await readFile(resolveCliPath(context.cwd, argsResult.data.issues), "utf8");
    const issues = parseSchedulerIssuesJson(JSON.parse(issueContents));
    const dispatchPlan = planOneShotLiveDispatch({
      config: workflow.typedConfig,
      promptTemplate: workflow.promptTemplate,
      issues,
      expectedReadyIssueIdentifiers
    });

    if ("blocked" in dispatchPlan) {
      await appendRunLogEvents(logPath, [
        createRunLogEvent("live_issue_blocked", {
          workerRole: "symphony_one_shot_live_runner",
          result: "blocked",
          reason: dispatchPlan.reason,
          message: dispatchPlan.message,
          evidence: dispatchPlan.evidence
        }, { level: "error" })
      ]);
      context.stderr.write(`${dispatchPlan.reason}: ${dispatchPlan.message}\n`);
      return 1;
    }

    const client = context.createAppServerClient?.();
    const result = await runCodexPlan(
      dispatchPlan.plan,
      createLiveCodexRunnerAdapter({
        acknowledged: true,
        prompt: workflow.promptTemplate,
        attemptMetadata: {
          attempt: logPolicy.attempt,
          logFresh: logPolicy.logFresh,
          appendEnabled: logPolicy.appendEnabled
        },
        ...(client !== undefined ? { client } : {})
      }),
      { allowLive: true }
    );

    await appendRunLogEvents(logPath, result.events ?? []);
    context.stdout.write(`${JSON.stringify({ dispatch: dispatchPlan.evidence, result }, null, 2)}\n`);
    return result.exitState === "completed" ? 0 : 1;
  } catch (error) {
    context.stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

function parseRunnerPlanArgs(args: string[]): {
  issueId?: string;
  issueIdentifier?: string;
  issueTitle?: string;
  workflow?: string;
} {
  const parsed: {
    issueId?: string;
    issueIdentifier?: string;
    issueTitle?: string;
    workflow?: string;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1] ?? "";

    if (arg === "--issue-id") {
      parsed.issueId = value;
      index += 1;
      continue;
    }

    if (arg === "--issue-identifier") {
      parsed.issueIdentifier = value;
      index += 1;
      continue;
    }

    if (arg === "--issue-title") {
      parsed.issueTitle = value;
      index += 1;
      continue;
    }

    if (arg === "--workflow") {
      parsed.workflow = value;
      index += 1;
      continue;
    }

    if (arg?.startsWith("--issue-id=")) {
      parsed.issueId = arg.slice("--issue-id=".length);
      continue;
    }

    if (arg?.startsWith("--issue-identifier=")) {
      parsed.issueIdentifier = arg.slice("--issue-identifier=".length);
      continue;
    }

    if (arg?.startsWith("--issue-title=")) {
      parsed.issueTitle = arg.slice("--issue-title=".length);
      continue;
    }

    if (arg?.startsWith("--workflow=")) {
      parsed.workflow = arg.slice("--workflow=".length);
    }
  }

  return parsed;
}

function parseKeyValueArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1] ?? "";

    if (arg === "--issues") {
      parsed.issues = value;
      index += 1;
      continue;
    }

    if (arg === "--workflow") {
      parsed.workflow = value;
      index += 1;
      continue;
    }

    if (arg === "--log") {
      parsed.log = value;
      index += 1;
      continue;
    }

    if (arg === "--expect-ready") {
      parsed.expectReady = value;
      index += 1;
      continue;
    }

    if (arg === "--limit") {
      parsed.limit = value;
      index += 1;
      continue;
    }

    if (arg === "--acknowledge-live-runner") {
      parsed.acknowledgeLiveRunner = "true";
      continue;
    }

    if (arg?.startsWith("--issues=")) {
      parsed.issues = arg.slice("--issues=".length);
      continue;
    }

    if (arg?.startsWith("--workflow=")) {
      parsed.workflow = arg.slice("--workflow=".length);
      continue;
    }

    if (arg?.startsWith("--log=")) {
      parsed.log = arg.slice("--log=".length);
      continue;
    }

    if (arg?.startsWith("--expect-ready=")) {
      parsed.expectReady = arg.slice("--expect-ready=".length);
      continue;
    }

    if (arg?.startsWith("--limit=")) {
      parsed.limit = arg.slice("--limit=".length);
      continue;
    }

    if (arg?.startsWith("--acknowledge-live-runner=")) {
      parsed.acknowledgeLiveRunner = arg.slice("--acknowledge-live-runner=".length);
    }
  }

  return parsed;
}

function parseCsv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter((item) => item.length > 0) ?? [];
}

function resolveCliPath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function formatCliError(error: unknown): string {
  if (error instanceof WorkflowError) {
    return formatWorkflowError(error);
  }

  if (error instanceof CodexRunnerError) {
    return `${error.code}: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
