import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface RunLogEvent extends JsonObject {
  timestamp: string;
  level: "info" | "warn" | "error";
  event: string;
}

export interface RunLogStatus {
  totalEvents: number;
  latestTimestamp: string | null;
  eventCounts: Record<string, number>;
  resultCounts: Record<string, number>;
  recentEvents: RunLogEvent[];
  liveAttempts?: LiveRunLogSummary;
}

export type LiveRunLogClassification =
  | "no-live-attempts"
  | "fresh-single-attempt"
  | "append-enabled-retry-run"
  | "accidental-duplicate-log-reuse";

export interface LiveRunAttemptSummary {
  sequence: number;
  issueId: string | null;
  issueIdentifier: string | null;
  startTimestamp: string;
  terminalEvent: string | null;
  terminalResult: string | null;
  turnStatus: string | null;
  error: JsonValue;
  cleanup: JsonObject | null;
  attempt: number | null;
  retryOf: string | null;
  retryReason: string | null;
  priorCleanupProof: JsonValue;
  logFresh: boolean | null;
  appendEnabled: boolean | null;
  metadataComplete: boolean;
}

export interface LiveRunDiagnosticsSummary {
  stderr: {
    eventCount: number;
    totalBytes: number;
    retainedBytes: number;
    truncatedEvents: number;
    truncationObserved: boolean;
  };
  mcp: {
    failedServers: string[];
  };
  environmentalWarnings: string[];
  runnerDefects: string[];
}

export interface LiveRunLogSummary {
  totalAttempts: number;
  classification: LiveRunLogClassification;
  issueAttemptCounts: Record<string, number>;
  attempts: LiveRunAttemptSummary[];
  hasPriorFailures: boolean;
  priorFailures: LiveRunAttemptSummary[];
  notes: string[];
  diagnostics: LiveRunDiagnosticsSummary;
}

export type FreshLiveRunLogPolicyResult =
  | {
      ok: true;
      attempt: number;
      logFresh: boolean;
      appendEnabled: false;
      summary: LiveRunLogSummary;
    }
  | {
      ok: false;
      reason: "live_log_reuse_blocked";
      message: string;
      summary: LiveRunLogSummary;
    };

export function createRunLogEvent(
  event: string,
  fields: JsonObject = {},
  options: { level?: RunLogEvent["level"]; timestamp?: string } = {}
): RunLogEvent {
  return {
    timestamp: options.timestamp ?? new Date().toISOString(),
    level: options.level ?? "info",
    event,
    ...dropUndefined(fields)
  };
}

export function formatRunLogEvent(event: RunLogEvent): string {
  return JSON.stringify(event);
}

export async function appendRunLogEvents(filePath: string, events: readonly RunLogEvent[]): Promise<void> {
  if (events.length === 0) {
    return;
  }

  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await appendFile(filePath, `${events.map(formatRunLogEvent).join("\n")}\n`, "utf8");
}

export async function readRunLog(filePath: string): Promise<RunLogEvent[]> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  return contents
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseRunLogLine);
}

export function summarizeRunLog(events: readonly RunLogEvent[], limit = 5): RunLogStatus {
  const eventCounts: Record<string, number> = {};
  const resultCounts: Record<string, number> = {};

  for (const event of events) {
    eventCounts[event.event] = (eventCounts[event.event] ?? 0) + 1;
    const result = typeof event.result === "string" ? event.result : undefined;
    if (result !== undefined) {
      resultCounts[result] = (resultCounts[result] ?? 0) + 1;
    }
  }

  const status: RunLogStatus = {
    totalEvents: events.length,
    latestTimestamp: events.at(-1)?.timestamp ?? null,
    eventCounts,
    resultCounts,
    recentEvents: events.slice(Math.max(events.length - Math.max(limit, 0), 0))
  };

  const liveAttempts = summarizeLiveRunAttempts(events);
  if (liveAttempts.totalAttempts > 0) {
    status.liveAttempts = liveAttempts;
  }

  return status;
}

export function validateFreshLiveRunLog(
  events: readonly RunLogEvent[],
  expectedIssueIdentifier: string
): FreshLiveRunLogPolicyResult {
  const summary = summarizeLiveRunAttempts(events);
  if (summary.totalAttempts === 0) {
    return {
      ok: true,
      attempt: 1,
      logFresh: events.length === 0,
      appendEnabled: false,
      summary
    };
  }

  const normalizedExpected = expectedIssueIdentifier.trim();
  const priorForIssue = summary.attempts.filter(
    (attempt) => attempt.issueIdentifier === normalizedExpected || attempt.issueId === normalizedExpected
  ).length;
  const issueClause =
    priorForIssue > 0
      ? `for ${normalizedExpected}`
      : `for ${summary.attempts.map((attempt) => attempt.issueIdentifier ?? attempt.issueId ?? "<unknown>").join(", ")}`;

  return {
    ok: false,
    reason: "live_log_reuse_blocked",
    message:
      `Live log already contains ${summary.totalAttempts} prior live attempt(s) ${issueClause}. ` +
      "Use a fresh log path; same-issue retry/append is disabled by default.",
    summary
  };
}

export function summarizeLiveRunAttempts(events: readonly RunLogEvent[]): LiveRunLogSummary {
  const startIndexes = events
    .map((event, index) => (event.event === "live_issue_started" ? index : -1))
    .filter((index) => index !== -1);
  const attempts = startIndexes.map((startIndex, index) =>
    summarizeLiveRunAttempt(events.slice(startIndex, startIndexes[index + 1] ?? events.length), index + 1)
  );
  const issueAttemptCounts = countAttemptsByIssue(attempts);
  const priorFailures = attempts.slice(0, -1).filter(isFailedAttempt);
  const classification = classifyLiveRunLog(attempts);
  const diagnostics = summarizeLiveDiagnostics(events, classification);
  const notes = buildLiveRunNotes(attempts, classification, diagnostics);

  return {
    totalAttempts: attempts.length,
    classification,
    issueAttemptCounts,
    attempts,
    hasPriorFailures: priorFailures.length > 0,
    priorFailures,
    notes,
    diagnostics
  };
}

function summarizeLiveRunAttempt(events: readonly RunLogEvent[], sequence: number): LiveRunAttemptSummary {
  const start = events[0];
  const terminal =
    events.find((event) => event.event === "live_issue_completed" || event.event === "live_issue_failed") ??
    events.find((event) => event.event === "turn_completed" || event.event === "turn_failed" || event.event === "turn_cancelled");
  const cleanup = events.find((event) => event.event === "app_server_cleanup_completed" || event.event === "app_server_cleanup_failed");
  const attempt = readNumber(start, "attempt");
  const retryOf = readString(start, "retry_of");
  const retryReason = readString(start, "retry_reason");
  const priorCleanupProof = readField(start, "prior_cleanup_proof") ?? null;
  const logFresh = readBoolean(start, "log_fresh");
  const appendEnabled = readBoolean(start, "append_enabled");

  return {
    sequence,
    issueId: readString(start, "issueId"),
    issueIdentifier: readString(start, "issueIdentifier"),
    startTimestamp: start?.timestamp ?? "",
    terminalEvent: terminal?.event ?? null,
    terminalResult: readString(terminal, "result"),
    turnStatus: readNestedString(terminal, ["payload", "params", "turn", "status"]),
    error: readField(terminal, "error") ?? readNested(terminal, ["payload", "params", "turn", "error"]) ?? null,
    cleanup: readJsonObject(cleanup, "cleanup"),
    attempt,
    retryOf,
    retryReason,
    priorCleanupProof,
    logFresh,
    appendEnabled,
    metadataComplete: hasRequiredAttemptMetadata({
      sequence,
      attempt,
      retryOf,
      retryReason,
      priorCleanupProof,
      logFresh,
      appendEnabled
    })
  };
}

function classifyLiveRunLog(attempts: readonly LiveRunAttemptSummary[]): LiveRunLogClassification {
  if (attempts.length === 0) {
    return "no-live-attempts";
  }
  if (attempts.length === 1) {
    return "fresh-single-attempt";
  }

  const retryMetadataComplete = attempts.every((attempt) => attempt.metadataComplete);
  const retryAttemptsAppendEnabled = attempts.slice(1).every((attempt) => attempt.appendEnabled === true);
  return retryMetadataComplete && retryAttemptsAppendEnabled ? "append-enabled-retry-run" : "accidental-duplicate-log-reuse";
}

function hasRequiredAttemptMetadata(input: {
  sequence: number;
  attempt: number | null;
  retryOf: string | null;
  retryReason: string | null;
  priorCleanupProof: JsonValue;
  logFresh: boolean | null;
  appendEnabled: boolean | null;
}): boolean {
  if (input.attempt !== input.sequence || input.logFresh === null || input.appendEnabled === null) {
    return false;
  }
  if (input.sequence === 1) {
    return input.appendEnabled === false;
  }

  return (
    input.appendEnabled === true &&
    input.retryOf !== null &&
    input.retryReason !== null &&
    input.priorCleanupProof !== null
  );
}

function countAttemptsByIssue(attempts: readonly LiveRunAttemptSummary[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const attempt of attempts) {
    const key = attempt.issueIdentifier ?? attempt.issueId ?? "<unknown>";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function isFailedAttempt(attempt: LiveRunAttemptSummary): boolean {
  return (
    attempt.terminalEvent === "live_issue_failed" ||
    attempt.terminalEvent === "turn_failed" ||
    attempt.terminalResult === "failed" ||
    attempt.turnStatus === "failed"
  );
}

function summarizeLiveDiagnostics(
  events: readonly RunLogEvent[],
  classification: LiveRunLogClassification
): LiveRunDiagnosticsSummary {
  let stderrEventCount = 0;
  let totalBytes = 0;
  let retainedBytes = 0;
  let truncatedEvents = 0;
  let pluginWarnings = false;
  let shellSnapshotWarnings = false;
  const failedMcpServers = new Set<string>();

  for (const event of events) {
    const stderr = readNested(event, ["diagnostics", "stderr"]);
    if (isJsonObject(stderr)) {
      stderrEventCount += 1;
      totalBytes += typeof stderr.bytes === "number" ? stderr.bytes : 0;
      retainedBytes += typeof stderr.retainedBytes === "number" ? stderr.retainedBytes : 0;
      if (stderr.truncated === true) {
        truncatedEvents += 1;
      }
      const text = typeof stderr.text === "string" ? stderr.text : "";
      pluginWarnings ||= text.includes("codex_core_plugins") || text.includes("codex_core_skills");
      shellSnapshotWarnings ||= text.includes("shell snapshot");
    }

    if (
      readString(event, "method") === "mcpServer/startupStatus/updated" &&
      readNestedString(event, ["payload", "params", "status"]) === "failed"
    ) {
      failedMcpServers.add(readNestedString(event, ["payload", "params", "name"]) ?? "<unknown>");
    }
  }

  const environmentalWarnings: string[] = [];
  if (pluginWarnings) {
    environmentalWarnings.push("plugin manifest/cache warnings were reported on stderr");
  }
  if (shellSnapshotWarnings) {
    environmentalWarnings.push("PowerShell shell snapshot warning was reported on stderr");
  }
  if (failedMcpServers.size > 0) {
    environmentalWarnings.push("one or more optional MCP servers failed startup or authentication");
  }
  if (truncatedEvents > 0) {
    environmentalWarnings.push("stderr diagnostics exceeded the retained byte limit");
  }

  const runnerDefects =
    classification === "accidental-duplicate-log-reuse"
      ? ["multiple top-level live attempts were recorded without append/retry metadata"]
      : [];

  return {
    stderr: {
      eventCount: stderrEventCount,
      totalBytes,
      retainedBytes,
      truncatedEvents,
      truncationObserved: truncatedEvents > 0
    },
    mcp: {
      failedServers: [...failedMcpServers].sort()
    },
    environmentalWarnings,
    runnerDefects
  };
}

function buildLiveRunNotes(
  attempts: readonly LiveRunAttemptSummary[],
  classification: LiveRunLogClassification,
  diagnostics: LiveRunDiagnosticsSummary
): string[] {
  const notes: string[] = [];
  if (classification === "fresh-single-attempt") {
    notes.push("Live log contains one top-level live attempt.");
  }
  if (classification === "append-enabled-retry-run") {
    notes.push("Live log contains an explicitly metadata-backed retry sequence.");
  }
  if (classification === "accidental-duplicate-log-reuse") {
    notes.push("Live log contains multiple top-level attempts without complete retry metadata.");
  }
  if (attempts.slice(0, -1).some(isFailedAttempt)) {
    notes.push("A prior live attempt failed before the final terminal event.");
  }
  if (diagnostics.stderr.truncationObserved) {
    notes.push("At least one stderr diagnostic block was truncated.");
  }
  if (diagnostics.mcp.failedServers.length > 0) {
    notes.push("MCP startup/auth failures were observed and should be reviewed separately from runner dispatch.");
  }

  return notes;
}

function readField(event: RunLogEvent | undefined, field: string): JsonValue | undefined {
  return event?.[field];
}

function readString(event: RunLogEvent | undefined, field: string): string | null {
  const value = readField(event, field);
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(event: RunLogEvent | undefined, field: string): number | null {
  const value = readField(event, field);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(event: RunLogEvent | undefined, field: string): boolean | null {
  const value = readField(event, field);
  return typeof value === "boolean" ? value : null;
}

function readJsonObject(event: RunLogEvent | undefined, field: string): JsonObject | null {
  const value = readField(event, field);
  return isJsonObject(value) ? value : null;
}

function readNestedString(event: RunLogEvent | undefined, pathSegments: readonly string[]): string | null {
  const value = readNested(event, pathSegments);
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNested(event: RunLogEvent | undefined, pathSegments: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = event;
  for (const segment of pathSegments) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRunLogLine(line: string): RunLogEvent {
  const parsed = JSON.parse(line) as unknown;
  if (!isRunLogEvent(parsed)) {
    throw new Error("Invalid Symphony run log event.");
  }

  return parsed;
}

function isRunLogEvent(value: unknown): value is RunLogEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { timestamp?: unknown }).timestamp === "string" &&
    typeof (value as { event?: unknown }).event === "string" &&
    ["info", "warn", "error"].includes(String((value as { level?: unknown }).level))
  );
}

function dropUndefined(fields: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }

  return output;
}
