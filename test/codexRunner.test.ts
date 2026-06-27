import path from "node:path";

import {
  createDryRunCodexRunnerAdapter,
  createFailClosedLiveCodexRunnerAdapter,
  planCodexRun,
  runCodexPlan,
  validateCodexRunPlan
} from "../src/codex/runner.js";
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

  it("fails closed for live adapter use in CODEX-50", async () => {
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
      message: "Live Codex launch is not enabled by default in CODEX-50."
    });
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
