import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";

import type { JsonObject, JsonValue } from "../logging/jsonl.js";
import type { CodexRunPlan } from "./runner.js";

export type CodexAppServerErrorCode =
  | "cleanup_failed"
  | "malformed"
  | "port_exit"
  | "response_error"
  | "response_timeout"
  | "turn_cancelled"
  | "turn_failed"
  | "turn_input_required"
  | "turn_timeout"
  | "turn_stalled";

export class CodexAppServerError extends Error {
  readonly code: CodexAppServerErrorCode;
  readonly details?: JsonValue;

  constructor(code: CodexAppServerErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export interface AppServerCleanupResult extends JsonObject {
  attempted: boolean;
  success: boolean;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}

export interface AppServerStderrDiagnostics extends JsonObject {
  text: string;
  bytes: number;
  retainedBytes: number;
  maxBytes: number;
  truncated: boolean;
}

export interface AppServerDiagnostics extends JsonObject {
  stderr: AppServerStderrDiagnostics;
}

export interface AppServerTransport {
  readonly pid?: number;
  send(message: JsonObject): Promise<void>;
  readLine(timeoutMs: number): Promise<string | null>;
  close(): Promise<AppServerCleanupResult>;
  diagnostics?(): AppServerDiagnostics | undefined;
}

export interface AppServerTransportFactory {
  (plan: CodexRunPlan): Promise<AppServerTransport>;
}

export interface CodexAppServerEvent extends JsonObject {
  event: string;
}

export interface CodexAppServerRunInput {
  plan: CodexRunPlan;
  prompt: string;
  onEvent?: (event: CodexAppServerEvent) => void;
}

export interface CodexAppServerRunResult {
  threadId: string;
  turnId: string;
  sessionId: string;
  cleanup: AppServerCleanupResult;
}

export interface CodexAppServerClient {
  run(input: CodexAppServerRunInput): Promise<CodexAppServerRunResult>;
}

export interface CodexAppServerClientOptions {
  transportFactory?: AppServerTransportFactory;
  cleanupTimeoutMs?: number;
  now?: () => number;
}

const INITIALIZE_ID = 1;
const THREAD_START_ID = 2;
const TURN_START_ID = 3;
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;
export const MAX_STDERR_DIAGNOSTIC_BYTES = 8_192;

export class BoundedStderrCapture {
  private readonly maxBytes: number;
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private retainedBytes = 0;
  private truncated = false;

  constructor(maxBytes = MAX_STDERR_DIAGNOSTIC_BYTES) {
    this.maxBytes = maxBytes;
  }

  append(chunk: unknown): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.bytes += buffer.length;

    const remainingBytes = this.maxBytes - this.retainedBytes;
    if (remainingBytes <= 0) {
      this.truncated = true;
      return;
    }

    const retained = buffer.length <= remainingBytes ? buffer : buffer.subarray(0, remainingBytes);
    this.chunks.push(retained);
    this.retainedBytes += retained.length;

    if (retained.length < buffer.length) {
      this.truncated = true;
    }
  }

  diagnostics(): AppServerDiagnostics | undefined {
    if (this.bytes === 0) {
      return undefined;
    }

    return {
      stderr: {
        text: Buffer.concat(this.chunks, this.retainedBytes).toString("utf8"),
        bytes: this.bytes,
        retainedBytes: this.retainedBytes,
        maxBytes: this.maxBytes,
        truncated: this.truncated
      }
    };
  }
}

export function createStdioCodexAppServerClient(
  options: CodexAppServerClientOptions = {}
): CodexAppServerClient {
  const transportFactory = options.transportFactory ?? createSubprocessTransport;
  const now = options.now ?? (() => Date.now());

  return {
    async run(input) {
      let transport: AppServerTransport | undefined;
      let cleanup: AppServerCleanupResult = cleanupNotAttempted();
      let runError: unknown;
      let runResult: Omit<CodexAppServerRunResult, "cleanup"> | undefined;

      try {
        transport = await transportFactory(input.plan);
        emit(input.onEvent, "app_server_started", {
          codex_app_server_pid: transport.pid ?? null,
          command: input.plan.invocation.command,
          workspacePath: input.plan.workspace.path
        });

        await initialize(transport, input, now);
        const threadId = await startThread(transport, input, now);
        emit(input.onEvent, "session_started", {
          codex_app_server_pid: transport.pid ?? null,
          thread_id: threadId,
          workspacePath: input.plan.workspace.path
        });

        const turnId = await startTurn(transport, input, threadId, now);
        const sessionId = `${threadId}-${turnId}`;
        emit(input.onEvent, "turn_started", {
          codex_app_server_pid: transport.pid ?? null,
          thread_id: threadId,
          turn_id: turnId,
          session_id: sessionId
        });

        await waitForTurnCompletion(transport, input, threadId, turnId, now);
        runResult = {
          threadId,
          turnId,
          sessionId
        };
      } catch (error) {
        runError = error;
        throw error;
      } finally {
        if (transport !== undefined) {
          try {
            cleanup = await withCleanupTimeout(transport.close(), options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
          } catch (error) {
            cleanup = {
              attempted: true,
              success: false,
              exitCode: null,
              signal: null,
              error: error instanceof Error ? error.message : String(error)
            };
            if (runError === undefined) {
              runError = new CodexAppServerError("cleanup_failed", "Codex app-server cleanup failed.", cleanup);
            }
          }

          const diagnostics = transport.diagnostics?.();
          emit(
            input.onEvent,
            cleanup.success ? "app_server_cleanup_completed" : "app_server_cleanup_failed",
            diagnostics === undefined ? { cleanup } : { cleanup, diagnostics }
          );

          if (!cleanup.success && runError === undefined) {
            runError = new CodexAppServerError("cleanup_failed", "Codex app-server cleanup failed.", cleanup);
          }

          if (runError instanceof CodexAppServerError && runError.code === "cleanup_failed") {
            throw runError;
          }
        }
      }

      if (runResult === undefined) {
        throw new CodexAppServerError("response_error", "Codex app-server run ended without a result.");
      }

      return {
        ...runResult,
        cleanup
      };
    }
  };
}

async function initialize(
  transport: AppServerTransport,
  input: CodexAppServerRunInput,
  now: () => number
): Promise<void> {
  await transport.send({
    method: "initialize",
    id: INITIALIZE_ID,
    params: {
      capabilities: {
        experimentalApi: true
      },
      clientInfo: {
        name: "symphony-typescript-orchestrator",
        title: "Symphony TypeScript Orchestrator",
        version: "0.0.0"
      }
    }
  });

  await awaitResponse(transport, INITIALIZE_ID, input.plan.timeouts.readTimeoutMs, now);
  await transport.send({
    method: "initialized",
    params: {}
  });

  emit(input.onEvent, "app_server_initialized", {
    codex_app_server_pid: transport.pid ?? null
  });
}

async function startThread(
  transport: AppServerTransport,
  input: CodexAppServerRunInput,
  now: () => number
): Promise<string> {
  await transport.send({
    method: "thread/start",
    id: THREAD_START_ID,
    params: dropUndefined({
      approvalPolicy: input.plan.policies.approvalPolicy as JsonValue | undefined,
      sandbox: input.plan.policies.threadSandbox as JsonValue | undefined,
      cwd: input.plan.workspace.path,
      dynamicTools: []
    })
  });

  const result = await awaitResponse(transport, THREAD_START_ID, input.plan.timeouts.readTimeoutMs, now);
  const threadId = readNestedString(result, ["thread", "id"]);
  if (threadId === undefined) {
    throw new CodexAppServerError("response_error", "thread/start response did not include thread.id.", result);
  }

  emit(input.onEvent, "thread_started", {
    codex_app_server_pid: transport.pid ?? null,
    thread_id: threadId
  });

  return threadId;
}

async function startTurn(
  transport: AppServerTransport,
  input: CodexAppServerRunInput,
  threadId: string,
  now: () => number
): Promise<string> {
  await transport.send({
    method: "turn/start",
    id: TURN_START_ID,
    params: dropUndefined({
      threadId,
      input: [
        {
          type: "text",
          text: input.prompt
        }
      ],
      cwd: input.plan.workspace.path,
      title: `${input.plan.issue.identifier}: ${input.plan.issue.title}`,
      approvalPolicy: input.plan.policies.approvalPolicy as JsonValue | undefined,
      sandboxPolicy: input.plan.policies.turnSandboxPolicy as JsonValue | undefined
    })
  });

  const result = await awaitResponse(transport, TURN_START_ID, input.plan.timeouts.readTimeoutMs, now);
  const turnId = readNestedString(result, ["turn", "id"]);
  if (turnId === undefined) {
    throw new CodexAppServerError("response_error", "turn/start response did not include turn.id.", result);
  }

  return turnId;
}

async function awaitResponse(
  transport: AppServerTransport,
  requestId: number,
  timeoutMs: number,
  now: () => number
): Promise<JsonObject> {
  const startedAt = now();

  while (true) {
    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) {
      throw new CodexAppServerError("response_timeout", `Timed out waiting for app-server response ${requestId}.`);
    }

    const line = await transport.readLine(remainingMs);
    if (line === null) {
      throw new CodexAppServerError("response_timeout", `Timed out waiting for app-server response ${requestId}.`);
    }

    const payload = parseProtocolLine(line);
    if (payload === undefined) {
      continue;
    }

    if (payload.id !== requestId) {
      continue;
    }

    if ("error" in payload) {
      throw new CodexAppServerError("response_error", `App-server response ${requestId} returned an error.`, payload);
    }

    if (isJsonObject(payload.result)) {
      return payload.result;
    }

    throw new CodexAppServerError("response_error", `App-server response ${requestId} did not include an object result.`, payload);
  }
}

async function waitForTurnCompletion(
  transport: AppServerTransport,
  input: CodexAppServerRunInput,
  threadId: string,
  turnId: string,
  now: () => number
): Promise<void> {
  const startedAt = now();
  let lastEventAt = startedAt;

  while (true) {
    const currentTime = now();
    const turnRemaining = input.plan.timeouts.turnTimeoutMs - (currentTime - startedAt);
    const stallRemaining = input.plan.timeouts.stallTimeoutMs - (currentTime - lastEventAt);

    if (turnRemaining <= 0) {
      throw new CodexAppServerError("turn_timeout", "Codex app-server turn timed out.");
    }
    if (stallRemaining <= 0) {
      throw new CodexAppServerError("turn_stalled", "Codex app-server turn stalled with no protocol events.");
    }

    const waitMs = Math.min(turnRemaining, stallRemaining);
    const line = await transport.readLine(waitMs);
    if (line === null) {
      const elapsedAtTimeout = now();
      const turnExpired = elapsedAtTimeout - startedAt >= input.plan.timeouts.turnTimeoutMs;
      throw new CodexAppServerError(
        turnExpired ? "turn_timeout" : "turn_stalled",
        turnExpired ? "Codex app-server turn timed out." : "Codex app-server turn stalled with no protocol events."
      );
    }

    lastEventAt = now();
    const payload = parseProtocolLine(line);
    if (payload === undefined) {
      continue;
    }

    const method = typeof payload.method === "string" ? payload.method : undefined;
    const terminalOutcome = classifyTurnTerminalOutcome(method, payload);
    emit(input.onEvent, mapProtocolEvent(method, terminalOutcome), {
      codex_app_server_pid: transport.pid ?? null,
      thread_id: threadId,
      turn_id: turnId,
      session_id: `${threadId}-${turnId}`,
      method: method ?? null,
      payload
    });

    if (terminalOutcome === "completed") {
      return;
    }
    if (terminalOutcome === "failed") {
      throw new CodexAppServerError("turn_failed", "Codex app-server turn failed.", payload);
    }
    if (terminalOutcome === "cancelled") {
      throw new CodexAppServerError("turn_cancelled", "Codex app-server turn was cancelled or interrupted.", payload);
    }
    if (isInputRequired(method, payload)) {
      throw new CodexAppServerError("turn_input_required", "Codex app-server turn requires input or approval.", payload);
    }
  }
}

function parseProtocolLine(line: string): JsonObject | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isJsonObject(parsed)) {
      return parsed;
    }
    return undefined;
  } catch (error) {
    if (trimmed.startsWith("{")) {
      throw new CodexAppServerError("malformed", "Malformed JSON-like app-server protocol line.", trimmed);
    }
    return undefined;
  }
}

type TurnTerminalOutcome = "completed" | "failed" | "cancelled";

function classifyTurnTerminalOutcome(
  method: string | undefined,
  payload: JsonObject
): TurnTerminalOutcome | undefined {
  if (method === "turn/failed" || method === "turn/ended_with_error" || method === "turn/ended-with-error") {
    return "failed";
  }
  if (method === "turn/cancelled" || method === "turn/canceled") {
    return "cancelled";
  }
  if (method !== "turn/completed") {
    return undefined;
  }

  const status = readNestedString(payload, ["params", "turn", "status"]) ?? readNestedString(payload, ["params", "status"]);
  if (status === undefined) {
    return "completed";
  }

  const normalized = status.toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "completed" || normalized === "complete" || normalized === "success" || normalized === "succeeded") {
    return "completed";
  }
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "interrupted") {
    return "cancelled";
  }

  return "failed";
}

function mapProtocolEvent(method: string | undefined, terminalOutcome?: TurnTerminalOutcome): string {
  if (terminalOutcome === "completed") {
    return "turn_completed";
  }
  if (terminalOutcome === "failed") {
    return "turn_failed";
  }
  if (terminalOutcome === "cancelled") {
    return "turn_cancelled";
  }

  if (method === undefined) {
    return "app_server_other_message";
  }

  switch (method) {
    case "turn/started":
      return "turn_notification";
    default:
      return "turn_notification";
  }
}

function isInputRequired(method: string | undefined, payload: JsonObject): boolean {
  if (method === undefined) {
    return false;
  }

  const normalized = method.toLowerCase();
  if (
    normalized.includes("input") ||
    normalized.includes("requestapproval") ||
    normalized.includes("approval")
  ) {
    return true;
  }

  const params = isJsonObject(payload.params) ? payload.params : {};
  const status = typeof params.status === "string" ? params.status.toLowerCase() : "";
  return status.includes("input") || status.includes("approval");
}

async function createSubprocessTransport(plan: CodexRunPlan): Promise<AppServerTransport> {
  const child = spawn(plan.invocation.executable, [...plan.invocation.args], {
    cwd: plan.invocation.cwd,
    stdio: "pipe",
    windowsHide: true
  });

  return new SubprocessAppServerTransport(child);
}

class SubprocessAppServerTransport implements AppServerTransport {
  readonly pid?: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdoutLines: string[] = [];
  private readonly waiters: Array<{
    resolve: (line: string | null) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private readonly stderr = new BoundedStderrCapture();
  private exitCode: number | null = null;
  private signal: string | null = null;
  private exitError: CodexAppServerError | undefined;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    if (child.pid !== undefined) {
      this.pid = child.pid;
    }

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.pushLine(line));
    child.stderr.on("data", (chunk) => this.stderr.append(chunk));
    child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.signal = signal;
      this.exitError = new CodexAppServerError("port_exit", "Codex app-server subprocess exited.", {
        exitCode: code,
        signal
      });
      this.rejectWaiters(this.exitError);
    });
    child.on("error", (error) => {
      this.exitError = new CodexAppServerError("port_exit", error.message);
      this.rejectWaiters(this.exitError);
    });
  }

  async send(message: JsonObject): Promise<void> {
    if (!this.child.stdin.writable) {
      throw new CodexAppServerError("port_exit", "Codex app-server stdin is closed.");
    }

    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8", (error) => {
        if (error !== null && error !== undefined) {
          reject(new CodexAppServerError("port_exit", error.message));
          return;
        }
        resolve();
      });
    });
  }

  async readLine(timeoutMs: number): Promise<string | null> {
    const line = this.stdoutLines.shift();
    if (line !== undefined) {
      return line;
    }
    if (this.exitError !== undefined) {
      throw this.exitError;
    }
    if (timeoutMs <= 0) {
      return null;
    }

    return new Promise<string | null>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) {
            this.waiters.splice(index, 1);
          }
          resolve(null);
        }, timeoutMs)
      };
      this.waiters.push(waiter);
    });
  }

  async close(): Promise<AppServerCleanupResult> {
    if (this.exitCode !== null || this.signal !== null) {
      return {
        attempted: true,
        success: true,
        exitCode: this.exitCode,
        signal: this.signal,
        error: null
      };
    }

    this.child.stdin.end();
    this.child.kill();
    await Promise.race([
      once(this.child, "exit"),
      new Promise((resolve) => setTimeout(resolve, DEFAULT_CLEANUP_TIMEOUT_MS))
    ]);

    return {
      attempted: true,
      success: this.exitCode !== null || this.signal !== null,
      exitCode: this.exitCode,
      signal: this.signal,
      error: this.exitCode === null && this.signal === null ? "cleanup_timeout" : null
    };
  }

  diagnostics(): AppServerDiagnostics | undefined {
    return this.stderr.diagnostics();
  }

  private pushLine(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.stdoutLines.push(line);
      return;
    }

    clearTimeout(waiter.timer);
    waiter.resolve(line);
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

}

function emit(
  onEvent: CodexAppServerRunInput["onEvent"],
  event: string,
  fields: JsonObject = {}
): void {
  onEvent?.({
    event,
    ...dropUndefined(fields)
  });
}

function readNestedString(value: JsonObject, path: readonly string[]): string | undefined {
  let current: JsonValue = value;
  for (const segment of path) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    current = current[segment] ?? null;
  }

  return typeof current === "string" && current.trim().length > 0 ? current : undefined;
}

function dropUndefined(fields: Record<string, JsonValue | undefined>): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanupNotAttempted(): AppServerCleanupResult {
  return {
    attempted: false,
    success: false,
    exitCode: null,
    signal: null,
    error: null
  };
}

async function withCleanupTimeout(
  cleanup: Promise<AppServerCleanupResult>,
  timeoutMs: number
): Promise<AppServerCleanupResult> {
  return Promise.race([
    cleanup,
    new Promise<AppServerCleanupResult>((resolve) =>
      setTimeout(
        () =>
          resolve({
            attempted: true,
            success: false,
            exitCode: null,
            signal: null,
            error: "cleanup_timeout"
          }),
        timeoutMs
      )
    )
  ]);
}
