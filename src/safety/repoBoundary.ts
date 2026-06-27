export const WRITABLE_REPOSITORY = "tojotheterror/symphony";
export const READ_ONLY_UPSTREAM_REPOSITORY = "openai/symphony";

const DISABLED_PUSH_VALUES = new Set(["disabled", "no_push", "no-push", "none"]);

export interface GitRemote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

export interface RemoteAssessment {
  name: string;
  fetchSlug: string | null;
  pushSlug: string | null;
  pushDisabled: boolean;
}

export interface RepoBoundaryValidationInput {
  remotes: readonly GitRemote[];
  requestedWriteTarget?: string | null;
}

export interface RepoBoundaryValidation {
  ok: boolean;
  writeTargetSlug: string | null;
  remotes: RemoteAssessment[];
  errors: string[];
  warnings: string[];
}

export function parseGitRemoteVerbose(output: string): GitRemote[] {
  const byName = new Map<string, GitRemote>();

  for (const line of output.split(/\r?\n/)) {
    const match = /^(?<name>\S+)\s+(?<url>.+)\s+\((?<kind>fetch|push)\)$/.exec(line.trim());
    if (!match?.groups) {
      continue;
    }

    const groups = match.groups as { name: string; url: string; kind: "fetch" | "push" };
    const existing: GitRemote = byName.get(groups.name) ?? { name: groups.name };
    if (groups.kind === "fetch") {
      existing.fetchUrl = groups.url;
    } else {
      existing.pushUrl = groups.url;
    }
    byName.set(groups.name, existing);
  }

  return [...byName.values()];
}

export function validateRepoBoundary(input: RepoBoundaryValidationInput): RepoBoundaryValidation {
  const remotes = input.remotes.map(assessRemote);
  const writeTargetSlug = normalizeRepositorySlug(input.requestedWriteTarget);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (writeTargetSlug === null) {
    errors.push("No provable write target was supplied; automation must fail closed.");
  } else if (writeTargetSlug !== WRITABLE_REPOSITORY) {
    errors.push(
      `Write target '${writeTargetSlug}' is not allowed; expected '${WRITABLE_REPOSITORY}'.`
    );
  }

  const writablePushRemote = remotes.find((remote) => remote.pushSlug === WRITABLE_REPOSITORY);
  if (writeTargetSlug === WRITABLE_REPOSITORY && writablePushRemote === undefined) {
    errors.push(
      `No configured push remote proves write access to '${WRITABLE_REPOSITORY}'.`
    );
  }

  for (const remote of remotes) {
    const touchesUpstream =
      remote.fetchSlug === READ_ONLY_UPSTREAM_REPOSITORY ||
      remote.pushSlug === READ_ONLY_UPSTREAM_REPOSITORY;

    if (touchesUpstream && !remote.pushDisabled) {
      errors.push(
        `Remote '${remote.name}' points at read-only upstream '${READ_ONLY_UPSTREAM_REPOSITORY}' without a disabled push URL.`
      );
    }

    if (remote.pushSlug !== null && remote.pushSlug !== WRITABLE_REPOSITORY) {
      errors.push(
        `Remote '${remote.name}' has forbidden push target '${remote.pushSlug}'.`
      );
    }

    if (remote.fetchSlug === null) {
      warnings.push(`Remote '${remote.name}' fetch URL is not a recognized GitHub repository URL.`);
    }
  }

  return {
    ok: errors.length === 0,
    writeTargetSlug,
    remotes,
    errors,
    warnings
  };
}

export function assessRemote(remote: GitRemote): RemoteAssessment {
  const pushDisabled = isDisabledPushUrl(remote.pushUrl);
  return {
    name: remote.name,
    fetchSlug: normalizeRepositorySlug(remote.fetchUrl),
    pushSlug: pushDisabled ? null : normalizeRepositorySlug(remote.pushUrl),
    pushDisabled
  };
}

export function normalizeRepositorySlug(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || isDisabledPushUrl(trimmed)) {
    return null;
  }

  const ownerRepoOnly = /^(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
    trimmed
  );
  if (ownerRepoOnly?.groups) {
    const groups = ownerRepoOnly.groups as { owner: string; repo: string };
    return toSlug(groups.owner, groups.repo);
  }

  const scpLike = /^git@github\.com:(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/.exec(trimmed);
  if (scpLike?.groups) {
    const groups = scpLike.groups as { owner: string; repo: string };
    return toSlug(groups.owner, groups.repo);
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") {
      return null;
    }

    const pathParts = url.pathname.replace(/^\/+/, "").split("/");
    const owner = pathParts[0];
    const repo = pathParts[1];
    if (owner === undefined || repo === undefined) {
      return null;
    }

    return toSlug(owner, repo.replace(/\.git$/, ""));
  } catch {
    return null;
  }
}

export function formatBoundaryReport(report: RepoBoundaryValidation): string {
  const status = report.ok ? "Repository boundary check passed." : "Repository boundary check failed.";
  const lines = [
    status,
    `Writable repository: ${WRITABLE_REPOSITORY}`,
    `Read-only upstream: ${READ_ONLY_UPSTREAM_REPOSITORY}`,
    `Requested write target: ${report.writeTargetSlug ?? "unproven"}`
  ];

  if (report.errors.length > 0) {
    lines.push("Errors:");
    lines.push(...report.errors.map((error) => `- ${error}`));
  }

  if (report.warnings.length > 0) {
    lines.push("Warnings:");
    lines.push(...report.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
}

function isDisabledPushUrl(value: string | null | undefined): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  return DISABLED_PUSH_VALUES.has(value.trim().toLowerCase());
}

function toSlug(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase().replace(/\.git$/, "")}`;
}
