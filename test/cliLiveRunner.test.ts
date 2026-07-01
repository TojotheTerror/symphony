import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/cli/commands.js";
import type { CodexAppServerClient } from "../src/codex/appServerClient.js";
import { CODEX_APP_SERVER_STDIO_COMMAND } from "../src/codex/launchContract.js";

describe("runner CLI one-shot live guardrails", () => {
  it("requires explicit acknowledgement before creating an app-server client", async () => {
    const tempDir = await setupLiveCliFixture();
    try {
      let clientCreated = false;
      const output = await runCliCollectingOutput(
        [
          "runner",
          "live",
          "--issues",
          path.join(tempDir, "issues.json"),
          "--log",
          path.join(tempDir, "runs.jsonl"),
          "--expect-ready",
          "CODEX-53"
        ],
        tempDir,
        {
          createAppServerClient: () => {
            clientCreated = true;
            return fakeClient();
          }
        }
      );

      expect(output.exitCode).toBe(1);
      expect(output.stderr).toContain("Live runner requires --acknowledge-live-runner.");
      expect(clientCreated).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires exactly one expected ready issue identifier before live execution", async () => {
    const tempDir = await setupLiveCliFixture();
    try {
      let clientCreated = false;
      const output = await runCliCollectingOutput(
        [
          "runner",
          "live",
          "--issues",
          path.join(tempDir, "issues.json"),
          "--log",
          path.join(tempDir, "runs.jsonl"),
          "--expect-ready",
          "CODEX-53,CODEX-56",
          "--acknowledge-live-runner"
        ],
        tempDir,
        {
          createAppServerClient: () => {
            clientCreated = true;
            return fakeClient();
          }
        }
      );

      expect(output.exitCode).toBe(1);
      expect(output.stderr).toContain("Live runner requires exactly one --expect-ready issue identifier.");
      expect(clientCreated).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs one fake app-server client and writes live JSONL evidence", async () => {
    const tempDir = await setupLiveCliFixture();
    try {
      const logPath = path.join(tempDir, "runs.jsonl");
      const output = await runCliCollectingOutput(
        [
          "runner",
          "live",
          "--issues",
          path.join(tempDir, "issues.json"),
          "--log",
          logPath,
          "--expect-ready",
          "CODEX-53",
          "--acknowledge-live-runner"
        ],
        tempDir,
        {
          createAppServerClient: () => fakeClient()
        }
      );

      expect(output.exitCode).toBe(0);
      const stdout = JSON.parse(output.stdout);
      expect(stdout.result).toMatchObject({
        mode: "live",
        exitState: "completed",
        command: CODEX_APP_SERVER_STDIO_COMMAND
      });

      const events = (await readFile(logPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.event)).toEqual([
        "live_issue_started",
        "live_workspace_prepared",
        "session_started",
        "turn_completed",
        "live_issue_completed"
      ]);
      expect(events.find((event) => event.event === "live_workspace_prepared")).toMatchObject({
        result: "created",
        workspace: {
          path: path.join(tempDir, "workspaces", "CODEX-53"),
          createdNow: true
        }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects live workflows that omit --stdio before creating an app-server client", async () => {
    const tempDir = await setupLiveCliFixture("codex app-server");
    try {
      let clientCreated = false;
      const logPath = path.join(tempDir, "runs.jsonl");
      const output = await runCliCollectingOutput(
        [
          "runner",
          "live",
          "--issues",
          path.join(tempDir, "issues.json"),
          "--log",
          logPath,
          "--expect-ready",
          "CODEX-53",
          "--acknowledge-live-runner"
        ],
        tempDir,
        {
          createAppServerClient: () => {
            clientCreated = true;
            return fakeClient();
          }
        }
      );

      expect(output.exitCode).toBe(1);
      expect(output.stderr).toContain("live_codex_command_invalid");
      expect(output.stderr).toContain(CODEX_APP_SERVER_STDIO_COMMAND);
      expect(clientCreated).toBe(false);

      const events = (await readFile(logPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      expect(events).toEqual([
        expect.objectContaining({
          event: "live_issue_blocked",
          reason: "live_codex_command_invalid",
          message: expect.stringContaining(CODEX_APP_SERVER_STDIO_COMMAND)
        })
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function setupLiveCliFixture(command = CODEX_APP_SERVER_STDIO_COMMAND): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "symphony-live-cli-test-"));
  await writeFile(
    path.join(tempDir, "WORKFLOW.md"),
    `---
tracker:
  kind: linear
  project_id: project-1
  required_labels:
    - symphony-ready
agent:
  max_concurrent_agents: 2
workspace:
  root: workspaces
codex:
  command: ${command}
---
Work on {{ issue.identifier }}.
`,
    "utf8"
  );
  await writeFile(
    path.join(tempDir, "issues.json"),
    JSON.stringify([
      {
        id: "issue-1",
        identifier: "CODEX-53",
        title: "Run first live docs/test-only Symphony pilot",
        state: "Todo",
        labels: ["symphony-ready", "docs-only"],
        projectId: "project-1"
      },
      {
        id: "issue-2",
        identifier: "CODEX-56",
        title: "Runtime task",
        state: "Todo",
        labels: ["symphony", "runtime"],
        projectId: "project-1"
      }
    ]),
    "utf8"
  );
  return tempDir;
}

function fakeClient(): CodexAppServerClient {
  return {
    async run(input) {
      input.onEvent?.({
        event: "session_started",
        thread_id: "thread-1",
        workspacePath: input.plan.workspace.path
      });
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
}

async function runCliCollectingOutput(
  args: string[],
  cwd: string,
  context: Pick<Parameters<typeof runCli>[1], "createAppServerClient"> = {}
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(args, {
    cwd,
    stdout: { write: (message) => stdout.push(message) },
    stderr: { write: (message) => stderr.push(message) },
    ...context
  });

  return {
    exitCode,
    stdout: stdout.join(""),
    stderr: stderr.join("")
  };
}
