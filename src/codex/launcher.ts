import { access } from "node:fs/promises";
import path from "node:path";

import type { JsonObject } from "../logging/jsonl.js";

export interface CodexLauncherDiagnostics extends JsonObject {
  requestedExecutable: string;
  resolvedExecutable: string | null;
  platform: string;
  reason: string;
  pathCandidates: string[];
  rejectedCandidates: string[];
}

export interface CodexExecutableResolution extends JsonObject {
  requestedExecutable: string;
  resolvedExecutable: string;
  platform: string;
  source: "configured-path" | "path";
  pathCandidates: string[];
  rejectedCandidates: string[];
}

export interface CodexExecutableResolveOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  accessFile?: (filePath: string) => Promise<void>;
}

export class CodexLauncherError extends Error {
  readonly diagnostics: CodexLauncherDiagnostics;

  constructor(message: string, diagnostics: CodexLauncherDiagnostics) {
    super(message);
    this.name = "CodexLauncherError";
    this.diagnostics = diagnostics;
  }
}

export async function resolveCodexExecutableForSpawn(
  requestedExecutable: string,
  options: CodexExecutableResolveOptions = {}
): Promise<CodexExecutableResolution> {
  const executable = requestedExecutable.trim();
  const platform = options.platform ?? process.platform;
  const accessFile = options.accessFile ?? ((filePath: string) => access(filePath));
  if (executable.length === 0) {
    throw launcherError("Codex executable must not be empty.", {
      requestedExecutable,
      resolvedExecutable: null,
      platform,
      reason: "empty_executable",
      pathCandidates: [],
      rejectedCandidates: []
    });
  }

  if (platform !== "win32") {
    return {
      requestedExecutable: executable,
      resolvedExecutable: executable,
      platform,
      source: isPathLike(executable) ? "configured-path" : "path",
      pathCandidates: [],
      rejectedCandidates: []
    };
  }

  if (isPathLike(executable)) {
    const resolvedExecutable = path.win32.resolve(executable);
    await assertWindowsCandidateExists(resolvedExecutable, accessFile);
    const rejectionReason = classifyRejectedWindowsCandidate(resolvedExecutable);
    if (rejectionReason !== undefined) {
      throw launcherError(`Codex executable is not spawnable: ${rejectionReason}.`, {
        requestedExecutable: executable,
        resolvedExecutable,
        platform,
        reason: rejectionReason,
        pathCandidates: [resolvedExecutable],
        rejectedCandidates: [resolvedExecutable]
      });
    }

    return {
      requestedExecutable: executable,
      resolvedExecutable,
      platform,
      source: "configured-path",
      pathCandidates: [resolvedExecutable],
      rejectedCandidates: []
    };
  }

  const candidates = await findWindowsPathCandidates(executable, options.env ?? process.env, accessFile);
  const rejectedCandidates: string[] = [];
  for (const candidate of candidates) {
    const rejectionReason = classifyRejectedWindowsCandidate(candidate);
    if (rejectionReason === undefined) {
      return {
        requestedExecutable: executable,
        resolvedExecutable: candidate,
        platform,
        source: "path",
        pathCandidates: candidates,
        rejectedCandidates
      };
    }
    rejectedCandidates.push(candidate);
  }

  const reason = selectRejectedCandidateReason(rejectedCandidates);
  throw launcherError("Codex executable could not be resolved to a spawnable Windows binary.", {
    requestedExecutable: executable,
    resolvedExecutable: null,
    platform,
    reason: reason ?? "not_found",
    pathCandidates: candidates,
    rejectedCandidates
  });
}

function selectRejectedCandidateReason(rejectedCandidates: readonly string[]): string {
  const reasons = rejectedCandidates
    .map((candidate) => classifyRejectedWindowsCandidate(candidate))
    .filter((reason): reason is string => reason !== undefined);
  if (reasons.includes("windows_execution_alias")) {
    return "windows_execution_alias";
  }
  return reasons[0] ?? "not_found";
}

function launcherError(message: string, diagnostics: CodexLauncherDiagnostics): CodexLauncherError {
  return new CodexLauncherError(message, diagnostics);
}

async function findWindowsPathCandidates(
  executable: string,
  env: Record<string, string | undefined>,
  accessFile: (filePath: string) => Promise<void>
): Promise<string[]> {
  const pathValue = readEnv(env, "PATH");
  if (pathValue === undefined || pathValue.trim().length === 0) {
    return [];
  }

  const names = executableNames(executable, readEnv(env, "PATHEXT"));
  const matches: string[] = [];
  for (const directory of pathValue.split(";").map((entry) => entry.trim()).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.win32.join(directory, name);
      if (matches.some((match) => match.toLowerCase() === candidate.toLowerCase())) {
        continue;
      }
      try {
        await accessFile(candidate);
        matches.push(candidate);
      } catch {
        // Continue searching PATH; the caller reports a single fail-closed diagnostic if no spawnable target exists.
      }
    }
  }
  return matches;
}

function executableNames(executable: string, pathExt: string | undefined): string[] {
  if (path.win32.extname(executable).length > 0) {
    return [executable];
  }

  const extensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  const spawnableExtensions = extensions.filter((extension) => isSpawnableWindowsExtension(extension));
  const otherExtensions = extensions.filter((extension) => !isSpawnableWindowsExtension(extension));
  return [
    ...spawnableExtensions.map((extension) => `${executable}${extension.toLowerCase()}`),
    ...spawnableExtensions.map((extension) => `${executable}${extension.toUpperCase()}`),
    executable,
    ...otherExtensions.map((extension) => `${executable}${extension.toLowerCase()}`),
    ...otherExtensions.map((extension) => `${executable}${extension.toUpperCase()}`)
  ];
}

async function assertWindowsCandidateExists(
  executable: string,
  accessFile: (filePath: string) => Promise<void>
): Promise<void> {
  try {
    await accessFile(executable);
  } catch {
    throw launcherError("Configured Codex executable was not found.", {
      requestedExecutable: executable,
      resolvedExecutable: executable,
      platform: "win32",
      reason: "not_found",
      pathCandidates: [executable],
      rejectedCandidates: []
    });
  }
}

function classifyRejectedWindowsCandidate(candidate: string): string | undefined {
  const normalized = candidate.toLowerCase();
  if (normalized.includes("\\windowsapps\\")) {
    return "windows_execution_alias";
  }

  const extension = path.win32.extname(candidate).toLowerCase();
  if (extension === ".cmd" || extension === ".bat" || extension === ".ps1") {
    return "shell_shim";
  }
  if (extension.length === 0) {
    return "extensionless_windows_target";
  }
  if (!isSpawnableWindowsExtension(extension)) {
    return "unsupported_extension";
  }

  return undefined;
}

function isSpawnableWindowsExtension(extension: string): boolean {
  const normalized = extension.toLowerCase();
  return normalized === ".exe" || normalized === ".com";
}

function isPathLike(executable: string): boolean {
  return (
    path.win32.isAbsolute(executable) ||
    executable.includes("\\") ||
    executable.includes("/") ||
    executable.startsWith(".")
  );
}

function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) {
    return direct;
  }

  const match = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return match === undefined ? undefined : env[match];
}
