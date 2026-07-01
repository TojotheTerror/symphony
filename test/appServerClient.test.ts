import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import {
  BoundedStderrCapture,
  CodexAppServerError,
  MAX_STDERR_DIAGNOSTIC_BYTES,
  createStdioCodexAppServerClient,
  type AppServerCleanupResult,
  type AppServerDiagnostics,
  type AppServerSpawnProcess,
  type AppServerTransport
} from "../src/codex/appServerClient.js";
import type { CodexExecutableResolution } from "../src/codex/launcher.js";
import { CODEX_APP_SERVER_STDIO_COMMAND } from "../src/codex/launchContract.js";
import { planCodexRun } from "../src/codex/runner.js";
import type { JsonObject } from "../src/logging/jsonl.js";
import { validateWorkflowConfig } from "../src/workflow/config.js";

const baseConfig = {
  tracker: {
    kind: "linear",
    project_id: "project-1",
    required_labels: ["symphony-ready"]
  },
  codex: {
    command: "fake-codex app-server",
    read_timeout_ms: 50,
    turn_timeout_ms: 100,
    stall_timeout_ms: 25
  },
  workspace: {
    root: "tmp-workspaces"
  }
};

const config = validateWorkflowConfig(baseConfig);

function livePlan(codexOverrides: Record<string, unknown> = {}) {
  const planConfig =
    Object.keys(codexOverrides).length === 0
      ? config
      : validateWorkflowConfig({
          ...baseConfig,
          codex: {
            ...baseConfig.codex,
            ...codexOverrides
          }
        });

  return planCodexRun({
    config: planConfig,
    issue: {
      id: "issue-1",
      identifier: "CODEX-56",
      title: "Implement live runner"
    },
    prompt: "Do the work.",
    mode: "live"
  });
}

describe("Codex app-server stdio client", () => {
  it("runs the verified initialize/thread/turn lifecycle over a fake transport", async () => {
    const transport = new FakeTransport([
      jsonLine({ id: 1, result: {} }),
      jsonLine({ id: 2, result: { thread: { id: "thread-1" } } }),
      jsonLine({ id: 3, result: { turn: { id: "turn-1" } } }),
      jsonLine({ method: "turn/completed", params: { turn: { id: "turn-1" } } })
    ]);
    const events: string[] = [];
    const client = createStdioCodexAppServerClient({
      transportFactory: async () => transport
    });

    const result = await client.run({
      plan: livePlan(),
      prompt: "Prompt text",
      onEvent: (event) => events.push(event.event)
    });

    expect(result).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      sessionId: "thread-1-turn-1",
      cleanup: expect.objectContaining({ success: true })
    });
    expect(transport.sent.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start"
    ]);
    expect(transport.sent.at(3)).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "Prompt text" }]
      }
    });
    expect(events).toEqual([
      "app_server_started",
      "app_server_initialized",
      "thread_started",
      "session_started",
      "turn_started",
      "turn_completed",
      "app_server_cleanup_completed"
    ]);
  });

  it("does not reset startup response timeouts for noisy unrelated messages", async () => {
    let nowMs = 0;
    const transport = new FakeTransport(
      [
        { line: jsonLine({ method: "$/progress", params: { message: "still starting" } }), advanceMs: 20 },
        { line: "diagnostic: booting", advanceMs: 20 },
        { line: jsonLine({ id: 999, result: {} }), advanceMs: 20 }
      ],
      {
        advanceClock: (ms) => {
          nowMs += ms;
        }
      }
    );
    const client = createStdioCodexAppServerClient({
      transportFactory: async () => transport,
      now: () => nowMs
    });

    await expect(
      client.run({
        plan: livePlan(),
        prompt: "Prompt text"
      })
    ).rejects.toThrow(expect.objectContaining({ code: "response_timeout" }));
    expect(transport.readTimeouts).toEqual([50, 30, 10]);
    expect(transport.sent.map((message) => message.method)).toEqual(["initialize"]);
    expect(transport.closed).toBe(true);
  });

  it("captures bounded startup stderr diagnostics in cleanup evidence", async () => {
    const stderr = new BoundedStderrCapture();
    stderr.append(`startup diagnostic:${"x".repeat(9000)}`);
    const startupDiagnostics = stderr.diagnostics();
    if (startupDiagnostics === undefined) {
      throw new Error("Expected fake stderr diagnostics.");
    }
    const transport = new FakeTransport(
      [
        jsonLine({ id: 1, result: {} }),
        jsonLine({ id: 2, result: { thread: { id: "thread-1" } } }),
        jsonLine({ id: 3, result: { turn: { id: "turn-1" } } }),
        jsonLine({ method: "turn/completed", params: { turn: { id: "turn-1" } } })
      ],
      {
        diagnostics: startupDiagnostics
      }
    );
    const events: JsonObject[] = [];
    const client = createStdioCodexAppServerClient({
      transportFactory: async () => transport
    });
    const result = await client.run({
      plan: livePlan(),
      prompt: "Prompt text",
      onEvent: (event) => events.push(event)
    });

    expect(result).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1"
    });
    const cleanupDiagnostics = readCleanupDiagnostics(events);
    expect(cleanupDiagnostics?.stderr).toMatchObject({
      retainedBytes: MAX_STDERR_DIAGNOSTIC_BYTES,
      maxBytes: MAX_STDERR_DIAGNOSTIC_BYTES,
      truncated: true
    });
    expect(cleanupDiagnostics?.stderr.bytes).toBeGreaterThan(MAX_STDERR_DIAGNOSTIC_BYTES);
    expect(cleanupDiagnostics?.stderr.text).toContain("startup diagnostic:");
  });

  it("does not parse stderr as stdout JSON-RPC protocol", async () => {
    const stderr = new BoundedStderrCapture();
    stderr.append(`${JSON.stringify({ id: 1, result: {} })}\n`);
    const stderrDiagnostics = stderr.diagnostics();
    if (stderrDiagnostics === undefined) {
      throw new Error("Expected fake stderr diagnostics.");
    }
    const transport = new FakeTransport([], {
      diagnostics: stderrDiagnostics
    });
    const events: JsonObject[] = [];
    const client = createStdioCodexAppServerClient({
      transportFactory: async () => transport
    });

    await expect(
      client.run({
        plan: livePlan(),
        prompt: "Prompt text",
        onEvent: (event) => events.push(event)
      })
    ).rejects.toThrow(expect.objectContaining({ code: "response_timeout" }));

    expect(events.map((event) => event.event)).not.toContain("app_server_initialized");
    const cleanupDiagnostics = readCleanupDiagnostics(events);
    expect(cleanupDiagnostics?.stderr.text).toContain('"id":1');
  });

  it("reports pre-spawn EPERM as a launcher failure instead of a protocol timeout", async () => {
    const child = new FakeChildProcess();
    const spawnError = Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
    const spawnProcess: AppServerSpawnProcess = vi.fn(
      (_executable: string, _args: string[], _options: SpawnOptionsWithoutStdio) => {
        queueMicrotask(() => child.emit("error", spawnError));
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    );
    const events: JsonObject[] = [];
    const client = createStdioCodexAppServerClient({
      executableResolver: async (executable) => fakeExecutableResolution(executable),
      spawnProcess
    });

    await expect(
      client.run({
        plan: livePlan({ command: CODEX_APP_SERVER_STDIO_COMMAND }),
        prompt: "Prompt text",
        onEvent: (event) => events.push(event)
      })
    ).rejects.toThrow(expect.objectContaining({ code: "launcher_failed" }));

    expect(spawnProcess).toHaveBeenCalledWith(
      String.raw`C:\Tools\Codex\codex.exe`,
      ["app-server", "--stdio"],
      expect.objectContaining({
        shell: false
      })
    );
    expect(events.map((event) => event.event)).toEqual(["app_server_launch_failed"]);
    expect(events[0]).toMatchObject({
      error: {
        code: "launcher_failed",
        details: {
          reason: "spawn_denied",
          errorCode: "EPERM"
        }
      },
      diagnostics: {
        launcher: {
          reason: "spawn_denied",
          resolvedExecutable: String.raw`C:\Tools\Codex\codex.exe`
        }
      }
    });
  });

  it("fails closed when the turn asks for input or approval", async () => {
    const transport = new FakeTransport([
      jsonLine({ id: 1, result: {} }),
      jsonLine({ id: 2, result: { thread: { id: "thread-1" } } }),
      jsonLine({ id: 3, result: { turn: { id: "turn-1" } } }),
      jsonLine({ method: "item/commandExecution/requestApproval", id: "approval-1", params: {} })
    ]);
    const client = createStdioCodexAppServerClient({
      transportFactory: async () => transport
    });

    await expect(
      client.run({
        plan: livePlan(),
        prompt: "Prompt text"
      })
    ).rejects.toThrow(expect.objectContaining({ code: "turn_input_required" }));
    expect(transport.closed).toBe(true);
  });

  it("reports turn timeout distinctly from stall timeout", async () => {
    let nowMs = 0;
    const transport = new FakeTransport(
      [
        jsonLine({ id: 1, result: {} }),
        jsonLine({ id: 2, result: { thread: { id: "thread-1" } } }),
        jsonLine({ id: 3, result: { turn: { id: "turn-1" } } }),
        { line: jsonLine({ method: "turn/started", params: { turn: { id: "turn-1" } } }), advanceMs: 31 }
      ],
      {
        advanceClock: (ms) => {
          nowMs += ms;
        }
      }
    );
    const client = createStdioCodexAppServerClient({
      transportFactory: async () => transport,
      now: () => nowMs
    });

    await expect(
      client.run({
        plan: livePlan({ turn_timeout_ms: 30, stall_timeout_ms: 100 }),
        prompt: "Prompt text"
      })
    ).rejects.toThrow(expect.objectContaining({ code: "turn_timeout" }));
  });

  it("fails closed on failed, interrupted, and cancelled terminal turn statuses", async () => {
    const cases: Array<{ payload: JsonObject; code: CodexAppServerError["code"] }> = [
      {
        payload: { method: "turn/failed", params: { error: { message: "boom" } } },
        code: "turn_failed"
      },
      {
        payload: { method: "turn/completed", params: { turn: { id: "turn-1", status: "interrupted" } } },
        code: "turn_cancelled"
      },
      {
        payload: { method: "turn/cancelled", params: { turn: { id: "turn-1" } } },
        code: "turn_cancelled"
      }
    ];

    for (const testCase of cases) {
      const transport = new FakeTransport([
        jsonLine({ id: 1, result: {} }),
        jsonLine({ id: 2, result: { thread: { id: "thread-1" } } }),
        jsonLine({ id: 3, result: { turn: { id: "turn-1" } } }),
        jsonLine(testCase.payload)
      ]);
      const client = createStdioCodexAppServerClient({
        transportFactory: async () => transport
      });

      await expect(
        client.run({
          plan: livePlan(),
          prompt: "Prompt text"
        })
      ).rejects.toThrow(expect.objectContaining({ code: testCase.code }));
      expect(transport.closed).toBe(true);
    }
  });

  it("fails closed when the subprocess exits before a terminal turn event", async () => {
    const transport = new FakeTransport([
      jsonLine({ id: 1, result: {} }),
      jsonLine({ id: 2, result: { thread: { id: "thread-1" } } }),
      jsonLine({ id: 3, result: { turn: { id: "turn-1" } } }),
      new CodexAppServerError("port_exit", "Fake app-server subprocess exited.")
    ]);
    const client = createStdioCodexAppServerClient({
      transportFactory: async () => transport
    });

    await expect(
      client.run({
        plan: livePlan(),
        prompt: "Prompt text"
      })
    ).rejects.toThrow(expect.objectContaining({ code: "port_exit" }));
    expect(transport.closed).toBe(true);
  });

  it("fails closed and emits cleanup evidence when transport cleanup fails", async () => {
    const transport = new FakeTransport(
      [
        jsonLine({ id: 1, result: {} }),
        jsonLine({ id: 2, result: { thread: { id: "thread-1" } } }),
        jsonLine({ id: 3, result: { turn: { id: "turn-1" } } }),
        jsonLine({ method: "turn/completed", params: { turn: { id: "turn-1" } } })
      ],
      {
        cleanup: {
          attempted: true,
          success: false,
          exitCode: null,
          signal: null,
          error: "cleanup_timeout"
        }
      }
    );
    const events: string[] = [];
    const client = createStdioCodexAppServerClient({
      transportFactory: async () => transport
    });

    await expect(
      client.run({
        plan: livePlan(),
        prompt: "Prompt text",
        onEvent: (event) => events.push(event.event)
      })
    ).rejects.toThrow(expect.objectContaining({ code: "cleanup_failed" }));
    expect(events).toContain("app_server_cleanup_failed");
  });

  it("distinguishes stalled turns from completed fake sessions", async () => {
    const transport = new FakeTransport([
      jsonLine({ id: 1, result: {} }),
      jsonLine({ id: 2, result: { thread: { id: "thread-1" } } }),
      jsonLine({ id: 3, result: { turn: { id: "turn-1" } } })
    ]);
    const client = createStdioCodexAppServerClient({
      transportFactory: async () => transport
    });

    await expect(
      client.run({
        plan: livePlan(),
        prompt: "Prompt text"
      })
    ).rejects.toThrow(expect.objectContaining({ code: "turn_stalled" }));
  });

  it("fails closed on malformed JSON-like protocol output", async () => {
    const transport = new FakeTransport([
      jsonLine({ id: 1, result: {} }),
      jsonLine({ id: 2, result: { thread: { id: "thread-1" } } }),
      jsonLine({ id: 3, result: { turn: { id: "turn-1" } } }),
      "{bad-json"
    ]);
    const client = createStdioCodexAppServerClient({
      transportFactory: async () => transport
    });

    await expect(
      client.run({
        plan: livePlan(),
        prompt: "Prompt text"
      })
    ).rejects.toThrow(CodexAppServerError);
  });
});

type FakeRead =
  | string
  | Error
  | {
      line: string;
      advanceMs?: number;
    };

class FakeTransport implements AppServerTransport {
  readonly pid = 1234;
  readonly sent: JsonObject[] = [];
  readonly readTimeouts: number[] = [];
  closed = false;
  private readonly lines: FakeRead[];
  private readonly cleanup: AppServerCleanupResult;
  private readonly capturedDiagnostics: AppServerDiagnostics | undefined;
  private readonly advanceClock: ((ms: number) => void) | undefined;

  constructor(
    lines: FakeRead[],
    options: {
      cleanup?: AppServerCleanupResult;
      diagnostics?: AppServerDiagnostics;
      advanceClock?: (ms: number) => void;
    } = {}
  ) {
    this.lines = [...lines];
    this.cleanup =
      options.cleanup ?? {
        attempted: true,
        success: true,
        exitCode: 0,
        signal: null,
          error: null
        };
    this.capturedDiagnostics = options.diagnostics;
    this.advanceClock = options.advanceClock;
  }

  async send(message: JsonObject): Promise<void> {
    this.sent.push(message);
  }

  async readLine(timeoutMs: number): Promise<string | null> {
    this.readTimeouts.push(timeoutMs);
    const next = this.lines.shift();
    if (next === undefined) {
      return null;
    }
    if (next instanceof Error) {
      throw next;
    }
    if (typeof next === "string") {
      return next;
    }

    if (next.advanceMs !== undefined) {
      this.advanceClock?.(next.advanceMs);
    }
    return next.line;
  }

  async close(): Promise<AppServerCleanupResult> {
    this.closed = true;
    return this.cleanup;
  }

  diagnostics(): AppServerDiagnostics | undefined {
    return this.capturedDiagnostics;
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;

  kill(): boolean {
    return true;
  }
}

function jsonLine(value: JsonObject): string {
  return JSON.stringify(value);
}

function readCleanupDiagnostics(events: JsonObject[]):
  | {
      stderr: {
        text: string;
        bytes: number;
        retainedBytes: number;
        maxBytes: number;
        truncated: boolean;
      };
    }
  | undefined {
  const cleanupEvent = events.find((event) => event.event === "app_server_cleanup_completed");
  return cleanupEvent?.diagnostics as
    | {
        stderr: {
          text: string;
          bytes: number;
          retainedBytes: number;
          maxBytes: number;
          truncated: boolean;
        };
      }
    | undefined;
}

function fakeExecutableResolution(executable: string): CodexExecutableResolution {
  return {
    requestedExecutable: executable,
    resolvedExecutable: String.raw`C:\Tools\Codex\codex.exe`,
    platform: "win32",
    source: "configured-path",
    pathCandidates: [String.raw`C:\Tools\Codex\codex.exe`],
    rejectedCandidates: []
  };
}
