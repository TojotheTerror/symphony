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
import { CODEX_APP_SERVER_STDIO_COMMAND } from "../src/codex/launchContract.js";
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
      strategy: "shell",
      command: "codex app-server",
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
          command: CODEX_APP_SERVER_STDIO_COMMAND,
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
      expect(plan.invocation).toEqual({
        strategy: "direct",
        command: CODEX_APP_SERVER_STDIO_COMMAND,
        executable: "codex",
        args: ["app-server", "--stdio"],
        cwd: path.join(tempDir, "workspaces", "CODEX-56")
      });
      expect(validateCodexRunPlan(plan).ok).toBe(true);
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

  it("keeps the stdio command contract while accepting a configured direct executable path", () => {
    const configuredExecutable = String.raw`C:\Tools\Codex\codex.exe`;
    const liveConfig = validateWorkflowConfig({
      tracker: {
        kind: "linear",
        project_id: "project-1",
        required_labels: ["symphony-ready"]
      },
      codex: {
        command: CODEX_APP_SERVER_STDIO_COMMAND,
        executable: configuredExecutable,
        turn_timeout_ms: 1000,
        read_timeout_ms: 500,
        stall_timeout_ms: 2000
      },
      workspace: {
        root: "tmp-workspaces"
      }
    });

    const plan = planCodexRun({
      config: liveConfig,
      issue: {
        id: "issue-1",
        identifier: "CODEX-60",
        title: "Fix Windows direct Codex spawn"
      },
      prompt: "Prompt",
      mode: "live"
    });

    expect(plan.invocation).toEqual({
      strategy: "direct",
      command: CODEX_APP_SERVER_STDIO_COMMAND,
      executable: configuredExecutable,
      args: ["app-server", "--stdio"],
      cwd: path.join(liveConfig.workspace.root, "CODEX-60")
    });
    expect(validateCodexRunPlan(plan).ok).toBe(true);
  });

  it("rejects live app-server commands that omit the verified stdio flag before client execution", async () => {
    const plan = planCodexRun({
      config,
      issue: {
        id: "issue-1",
        identifier: "CODEX-57",
        title: "Fix live runner stdio launch"
      },
      prompt: "Prompt",
      mode: "live"
    });
    let clientCalled = false;
    const client: CodexAppServerClient = {
      async run() {
        clientCalled = true;
        throw new Error("client must not run");
      }
    };

    expect(validateCodexRunPlan(plan)).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          code: "codex_launch_command_invalid",
          message: expect.stringContaining(CODEX_APP_SERVER_STDIO_COMMAND)
        })
      ]
    });

    const result = await runCodexPlan(
      plan,
      createLiveCodexRunnerAdapter({
        acknowledged: true,
        prompt: "Prompt",
        client
      }),
      { allowLive: true }
    );

    expect(result).toMatchObject({
      exitState: "blocked",
      error: {
        code: "codex_launch_command_invalid",
        message: expect.stringContaining(CODEX_APP_SERVER_STDIO_COMMAND)
      }
    });
    expect(clientCalled).toBe(false);
  });

  it("rejects live shell-wrapper invocations before client execution", async () => {
    const liveConfig = validateWorkflowConfig({
      tracker: {
        kind: "linear",
        project_id: "project-1",
        required_labels: ["symphony-ready"]
      },
      codex: {
        command: CODEX_APP_SERVER_STDIO_COMMAND,
        turn_timeout_ms: 1000,
        read_timeout_ms: 500,
        stall_timeout_ms: 2000
      },
      workspace: {
        root: "tmp-workspaces"
      }
    });
    const plan = planCodexRun({
      config: liveConfig,
      issue: {
        id: "issue-1",
        identifier: "CODEX-58",
        title: "Fix Windows shell wrapper"
      },
      prompt: "Prompt",
      mode: "live"
    });
    const shellWrappedPlan = {
      ...plan,
      invocation: {
        strategy: "shell" as const,
        command: CODEX_APP_SERVER_STDIO_COMMAND,
        executable: "bash",
        args: ["-lc", CODEX_APP_SERVER_STDIO_COMMAND],
        cwd: plan.workspace.path
      }
    };
    let clientCalled = false;
    const client: CodexAppServerClient = {
      async run() {
        clientCalled = true;
        throw new Error("client must not run");
      }
    };

    expect(validateCodexRunPlan(shellWrappedPlan)).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          code: "codex_launch_wrapper_invalid",
          message: expect.stringContaining("must not use a shell wrapper")
        })
      ]
    });

    const result = await runCodexPlan(
      shellWrappedPlan,
      createLiveCodexRunnerAdapter({
        acknowledged: true,
        prompt: "Prompt",
        client
      }),
      { allowLive: true }
    );

    expect(result).toMatchObject({
      exitState: "blocked",
      error: {
        code: "codex_launch_wrapper_invalid",
        message: expect.stringContaining("must not use a shell wrapper")
      }
    });
    expect(clientCalled).toBe(false);
  });
});
