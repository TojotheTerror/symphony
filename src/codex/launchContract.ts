export const CODEX_APP_SERVER_STDIO_COMMAND = "codex app-server --stdio";

export function isCodexAppServerStdioCommand(command: string): boolean {
  return normalizeCodexLaunchCommand(command) === CODEX_APP_SERVER_STDIO_COMMAND;
}

export function normalizeCodexLaunchCommand(command: string): string {
  return command.trim().split(/\s+/).filter(Boolean).join(" ");
}
