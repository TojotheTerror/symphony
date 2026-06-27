import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli/commands.js";

describe("runner CLI dry-run planning", () => {
  it("prints a Codex dry-run launch plan without live execution", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "symphony-runner-cli-test-"));
    try {
      await writeFile(
        path.join(tempDir, "WORKFLOW.md"),
        `---
tracker:
  kind: linear
  project_id: project-1
  required_labels:
    - symphony-ready
workspace:
  root: workspaces
codex:
  command: codex app-server
---
Work on {{ issue.identifier }}.
`,
        "utf8"
      );

      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(
        [
          "runner",
          "plan",
          "--issue-id",
          "issue-1",
          "--issue-identifier",
          "CODEX-50",
          "--issue-title",
          "Implement Codex runner adapter"
        ],
        {
          cwd: tempDir,
          stdout: { write: (message) => stdout.push(message) },
          stderr: { write: (message) => stderr.push(message) }
        }
      );

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      const plan = JSON.parse(stdout.join(""));
      expect(plan).toMatchObject({
        mode: "dry-run",
        issue: {
          id: "issue-1",
          identifier: "CODEX-50",
          title: "Implement Codex runner adapter"
        },
        invocation: {
          executable: "bash",
          args: ["-lc", "codex app-server"],
          cwd: path.join(tempDir, "workspaces", "CODEX-50")
        },
        evidence: {
          adapterMode: "dry-run",
          exitState: "planned"
        }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
