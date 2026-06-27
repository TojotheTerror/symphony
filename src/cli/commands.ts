import { execa } from "execa";
import { z } from "zod";

import {
  formatBoundaryReport,
  parseGitRemoteVerbose,
  validateRepoBoundary
} from "../safety/repoBoundary.js";

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

const HELP = `Symphony v0 TypeScript scaffold

Usage:
  symphony --help
  symphony --version
  symphony safety check --write-target <git-url-or-owner/repo>

Commands:
  safety check   Inspect git remotes and fail closed unless the write target is TojotheTerror/symphony.

This scaffold does not poll Linear, dispatch agents, manage workspaces, launch Codex, or merge PRs.
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
