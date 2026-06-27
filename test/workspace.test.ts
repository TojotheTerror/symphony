import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensureIssueWorkspace,
  isPathInsideRoot,
  resolveIssueWorkspace,
  sanitizeWorkspaceKey
} from "../src/workspace/manager.js";

describe("workspace manager", () => {
  it("sanitizes issue identifiers into deterministic workspace keys", () => {
    expect(sanitizeWorkspaceKey(" CODEX-49 ")).toBe("CODEX-49");
    expect(sanitizeWorkspaceKey("TEAM/123:fix workspace")).toBe("TEAM_123_fix_workspace");
  });

  it("rejects empty and path-traversal workspace keys", () => {
    expect(() => sanitizeWorkspaceKey("   ")).toThrow(
      expect.objectContaining({ code: "workspace_identifier_invalid" })
    );
    expect(() => resolveIssueWorkspace(path.join(os.tmpdir(), "symphony-root"), "..")).toThrow(
      expect.objectContaining({ code: "workspace_identifier_invalid" })
    );
  });

  it("computes per-issue paths under the configured root", () => {
    const root = path.join(os.tmpdir(), "symphony-workspaces");
    const workspace = resolveIssueWorkspace(root, "CODEX-49");

    expect(workspace).toEqual({
      rootPath: path.resolve(root),
      workspaceKey: "CODEX-49",
      path: path.join(path.resolve(root), "CODEX-49")
    });
    expect(isPathInsideRoot(root, workspace.path)).toBe(true);
    expect(isPathInsideRoot(root, root)).toBe(false);
  });

  it("creates missing workspaces and reuses existing directories", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "symphony-workspace-test-"));
    try {
      const created = await ensureIssueWorkspace(tempDir, "CODEX-49");
      expect(created.createdNow).toBe(true);
      await expect(stat(created.path)).resolves.toSatisfy((entry) => entry.isDirectory());

      const reused = await ensureIssueWorkspace(tempDir, "CODEX-49");
      expect(reused).toEqual({
        ...created,
        createdNow: false
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when the workspace target is an existing file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "symphony-workspace-test-"));
    try {
      const plan = resolveIssueWorkspace(tempDir, "CODEX-49");
      await writeFile(plan.path, "not a directory", "utf8");

      await expect(ensureIssueWorkspace(tempDir, "CODEX-49")).rejects.toThrow(
        expect.objectContaining({ code: "workspace_target_not_directory" })
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
