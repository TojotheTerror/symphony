import path from "node:path";

import {
  CodexLauncherError,
  resolveCodexExecutableForSpawn
} from "../src/codex/launcher.js";

describe("Codex executable launcher resolution", () => {
  it("rejects WindowsApps execution aliases for direct app-server launch", async () => {
    const windowsAppsCodex = String.raw`C:\Users\dev\AppData\Local\Microsoft\WindowsApps\codex.exe`;

    await expect(
      resolveCodexExecutableForSpawn("codex", {
        platform: "win32",
        env: {
          PATH: path.win32.dirname(windowsAppsCodex),
          PATHEXT: ".EXE;.CMD"
        },
        accessFile: fakeAccess([windowsAppsCodex])
      })
    ).rejects.toThrow(
      expect.objectContaining({
        name: "CodexLauncherError",
        diagnostics: expect.objectContaining({
          reason: "windows_execution_alias",
          rejectedCandidates: [windowsAppsCodex]
        })
      })
    );
  });

  it("rejects Windows npm shell shims instead of treating them as direct executables", async () => {
    const shellShim = String.raw`C:\Users\dev\AppData\Roaming\npm\codex.cmd`;

    await expect(
      resolveCodexExecutableForSpawn("codex", {
        platform: "win32",
        env: {
          PATH: path.win32.dirname(shellShim),
          PATHEXT: ".CMD"
        },
        accessFile: fakeAccess([shellShim])
      })
    ).rejects.toThrow(
      expect.objectContaining({
        diagnostics: expect.objectContaining({
          reason: "shell_shim",
          rejectedCandidates: [shellShim]
        })
      })
    );
  });

  it("accepts a configured spawnable Codex executable path", async () => {
    const configuredExecutable = String.raw`C:\Tools\Codex\codex.exe`;

    await expect(
      resolveCodexExecutableForSpawn(configuredExecutable, {
        platform: "win32",
        accessFile: fakeAccess([configuredExecutable])
      })
    ).resolves.toEqual({
      requestedExecutable: configuredExecutable,
      resolvedExecutable: configuredExecutable,
      platform: "win32",
      source: "configured-path",
      pathCandidates: [configuredExecutable],
      rejectedCandidates: []
    });
  });

  it("prefers a spawnable Windows binary over non-spawnable PATH shims", async () => {
    const shellShim = String.raw`C:\Users\dev\AppData\Roaming\npm\codex.cmd`;
    const binary = String.raw`C:\Tools\Codex\codex.exe`;

    await expect(
      resolveCodexExecutableForSpawn("codex", {
        platform: "win32",
        env: {
          PATH: `${path.win32.dirname(shellShim)};${path.win32.dirname(binary)}`,
          PATHEXT: ".CMD;.EXE"
        },
        accessFile: fakeAccess([shellShim, binary])
      })
    ).resolves.toMatchObject({
      requestedExecutable: "codex",
      resolvedExecutable: binary,
      source: "path",
      rejectedCandidates: [shellShim]
    });
  });

  it("fails closed when no PATH candidate exists", async () => {
    await expect(
      resolveCodexExecutableForSpawn("codex", {
        platform: "win32",
        env: {
          PATH: String.raw`C:\Tools\Missing`,
          PATHEXT: ".EXE"
        },
        accessFile: fakeAccess([])
      })
    ).rejects.toBeInstanceOf(CodexLauncherError);
  });
});

function fakeAccess(existingPaths: readonly string[]): (filePath: string) => Promise<void> {
  const existing = new Set(existingPaths.map((filePath) => filePath.toLowerCase()));
  return async (filePath: string) => {
    if (!existing.has(filePath.toLowerCase())) {
      throw new Error("not found");
    }
  };
}
