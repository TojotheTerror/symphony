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
}

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

  return {
    totalEvents: events.length,
    latestTimestamp: events.at(-1)?.timestamp ?? null,
    eventCounts,
    resultCounts,
    recentEvents: events.slice(Math.max(events.length - Math.max(limit, 0), 0))
  };
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
