import { execa } from "execa";
import { z } from "zod";

import { CodexRunnerError, planCodexRun } from "../codex/runner.js";
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

const HELP = `Symphony v0 TypeScript scaffold

Usage:
  symphony --help
  symphony --version
  symphony safety check --write-target <git-url-or-owner/repo>
  symphony runner plan --issue-id <id> --issue-identifier <key> --issue-title <title> [--workflow <path>]

Commands:
  safety check   Inspect git remotes and fail closed unless the write target is TojotheTerror/symphony.
  runner plan    Print a dry-run Codex launch plan without starting live Codex execution.

This scaffold does not poll Linear, mutate issues, launch live Codex sessions, or merge PRs.
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
