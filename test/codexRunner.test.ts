import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createLiveCodexRunnerAdapter,
  createDryRunCodexRunnerAdapter,
  createFailClosedLiveCodexRunnerAdapter,
  planCodexRun,
  runCodexPlan,
  validateCodexRunPlan
} from "../src/codex/runner.js";
import type { CodexAppServerClient } from "../src/codex/appServerClient.js";
import { validateWorkflowConfig } from "../src/workflow/config.js";

const config = validateWorkflowConfig({
  tracker: {
    kind: "linear",
    project_id: "project-1",
    required_labels: ["symphony-ready"]
  },
  codex: {
    command: "codex app-server",
    turn_timeout_ms: 1000,
    read_timeout_ms: 500,
    stall_timeout_ms: 2000
  },
  workspace: {
    root: "tmp-workspaces"
  }
});

describe("Codex runner adapter contract", () => {
  it("builds a dry-run launch plan without starting live work", () => {
    const plan = planCodexRun({
      config,
      issue: {
        id: "issue-1",
        identifier: "CODEX-50",
        title: "Implement Codex runner adapter"
      },
      prompt: "Work on {{ issue.identifier }}."
    });

    expect(plan.mode).toBe("dry-run");
    expect(plan.invocation).toEqual({
      executable: "bash",
      args: ["-lc", "codex app-server"],
      cwd: path.join(config.workspace.root, "CODEX-50")
    });
    expect(plan.evidence).toMatchObject({
      issueId: "issue-1",
      issueIdentifier: "CODEX-50",
      command: "codex app-server",
      adapterMode: "dry-run",
      exitState: "planned",
      workspacePath: path.join(config.workspace.root, "CODEX-50")
    });
    expect(plan.evidence.skippedChecks).toContain("live Codex app-server subprocess launch");
  });

  it("returns dry-run evidence instead of launching a process", async () => {
    const plan = planCodexRun({
      config,
      issue: {
        id: "issue-1",
        identifier: "CODEX-50",
        title: "Implement Codex runner adapter"
      },
      prompt: "Prompt"
    });

    const result = await runCodexPlan(plan, createDryRunCodexRunnerAdapter());

    expect(result).toMatchObject({
      mode: "dry-run",
      exitState: "dry_run",
      workspacePath: path.join(config.workspace.root, "CODEX-50"),
      command: "codex app-server"
    });
    expect(result.evidence.skippedChecks).toContain("process launch intentionally skipped");
  });

  it("fails closed for live adapter use unless explicitly allowed", async () => {
    const plan = planCodexRun({
      config,
      issue: {
        id: "issue-1",
        identifier: "CODEX-50",
        title: "Implement Codex runner adapter"
      },
      prompt: "Prompt",
      mode: "live"
    });

    const result = await runCodexPlan(plan, createFailClosedLiveCodexRunnerAdapter());

    expect(result.exitState).toBe("blocked");
    expect(result.error).toEqual({
      code: "codex_live_launch_not_enabled",
      message: "Live Codex launch is not enabled without explicit one-shot live runner acknowledgement."
    });
  });

  it("prepares the live workspace before running a live adapter with acknowledgement", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "symphony-live-runner-test-"));
    try {
      const liveConfig = validateWorkflowConfig({
        tracker: {
          kind: "linear",
          project_id: "project-1",
          required_labels: ["symphony-ready"]
        },
        codex: {
          command: "codex app-server",
          turn_timeout_ms: 1000,
          read_timeout_ms: 500,
          stall_timeout_ms: 2000
        },
        workspace: {
          root: path.join(tempDir, "workspaces")
        }
      });
      const plan = planCodexRun({
        config: liveConfig,
        issue: {
          id: "issue-1",
          identifier: "CODEX-56",
          title: "Implement minimal live runner"
        },
        prompt: "Prompt",
        mode: "live"
      });
      await expect(access(plan.workspace.path)).rejects.toThrow();

      let clientSawPreparedWorkspace = false;
      const client: CodexAppServerClient = {
        async run(input) {
          await access(input.plan.workspace.path);
          clientSawPreparedWorkspace = true;
          input.onEvent?.({
            event: "turn_completed",
            thread_id: "thread-1",
            turn_id: "turn-1",
            session_id: "thread-1-turn-1"
          });
          return {
            threadId: "thread-1",
            turnId: "turn-1",
            sessionId: "thread-1-turn-1",
            cleanup: {
              attempted: true,
              success: true,
              exitCode: 0,
              signal: null,
              error: null
            }
          };
        }
      };

      const result = await runCodexPlan(
        plan,
        createLiveCodexRunnerAdapter({
          acknowledged: true,
          prompt: "Prompt",
          client
        }),
        { allowLive: true }
      );

      expect(clientSawPreparedWorkspace).toBe(true);
      expect(result).toMatchObject({
        mode: "live",
        exitState: "completed",
        threadId: "thread-1",
        turnId: "turn-1",
        sessionId: "thread-1-turn-1"
      });
      expect(result.events?.map((event) => event.event)).toEqual([
        "live_issue_started",
        "live_workspace_prepared",
        "turn_completed",
        "live_issue_completed"
      ]);
      expect(result.events?.find((event) => event.event === "live_workspace_prepared")).toMatchObject({
        result: "created",
        workspace: {
          root: plan.workspace.rootPath,
          key: plan.workspace.workspaceKey,
          path: plan.workspace.path,
          createdNow: true
        }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects empty prompts and incomplete issue metadata", () => {
    expect(() =>
      planCodexRun({
        config,
        issue: {
          id: "issue-1",
          identifier: "CODEX-50",
          title: "Implement Codex runner adapter"
        },
        prompt: "   "
      })
    ).toThrow(expect.objectContaining({ code: "codex_prompt_empty" }));

    expect(() =>
      planCodexRun({
        config,
        issue: {
          id: "",
          identifier: "CODEX-50",
          title: "Implement Codex runner adapter"
        },
        prompt: "Prompt"
      })
    ).toThrow(expect.objectContaining({ code: "codex_issue_metadata_invalid" }));
  });

  it("validates workspace and cwd safety before an adapter can run", () => {
    const plan = planCodexRun({
      config,
      issue: {
        id: "issue-1",
        identifier: "CODEX-50",
        title: "Implement Codex runner adapter"
      },
      prompt: "Prompt"
    });
    const invalidPlan = {
      ...plan,
      invocation: {
        ...plan.invocation,
        cwd: path.dirname(plan.workspace.rootPath)
      }
    };

    expect(validateCodexRunPlan(invalidPlan)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: "codex_workspace_cwd_mismatch" })]
    });
  });
});
