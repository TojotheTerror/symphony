import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

export type WorkspaceErrorCode =
  | "workspace_identifier_invalid"
  | "workspace_path_outside_root"
  | "workspace_target_not_directory";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

export interface IssueWorkspacePlan {
  rootPath: string;
  workspaceKey: string;
  path: string;
}

export interface IssueWorkspace extends IssueWorkspacePlan {
  createdNow: boolean;
}

export function sanitizeWorkspaceKey(issueIdentifier: string): string {
  const trimmed = issueIdentifier.trim();
  if (trimmed.length === 0) {
    throw new WorkspaceError(
      "workspace_identifier_invalid",
      "Issue identifier is required to compute a workspace path."
    );
  }

  const workspaceKey = trimmed.replace(/[^A-Za-z0-9._-]/g, "_");
  if (workspaceKey === "." || workspaceKey === "..") {
    throw new WorkspaceError(
      "workspace_identifier_invalid",
      "Issue identifier resolves to an unsafe workspace key."
    );
  }

  return workspaceKey;
}

export function resolveIssueWorkspace(root: string, issueIdentifier: string): IssueWorkspacePlan {
  const rootPath = path.resolve(root);
  const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);
  const workspacePath = path.resolve(rootPath, workspaceKey);

  assertPathInsideRoot(rootPath, workspacePath);

  return {
    rootPath,
    workspaceKey,
    path: workspacePath
  };
}

export async function ensureIssueWorkspace(
  root: string,
  issueIdentifier: string
): Promise<IssueWorkspace> {
  const plan = resolveIssueWorkspace(root, issueIdentifier);

  try {
    const existing = await stat(plan.path);
    if (!existing.isDirectory()) {
      throw new WorkspaceError(
        "workspace_target_not_directory",
        `Workspace target exists but is not a directory: ${plan.path}`
      );
    }

    return {
      ...plan,
      createdNow: false
    };
  } catch (error) {
    if (error instanceof WorkspaceError) {
      throw error;
    }

    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  try {
    await mkdir(plan.path, { recursive: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      const existing = await stat(plan.path);
      if (existing.isDirectory()) {
        return {
          ...plan,
          createdNow: false
        };
      }
    }

    throw error;
  }

  return {
    ...plan,
    createdNow: true
  };
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(rootPath, candidatePath);

  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function assertPathInsideRoot(root: string, candidate: string): void {
  if (!isPathInsideRoot(root, candidate)) {
    throw new WorkspaceError(
      "workspace_path_outside_root",
      `Workspace path must stay inside workspace root: ${candidate}`
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
