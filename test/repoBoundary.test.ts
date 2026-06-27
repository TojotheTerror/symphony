import {
  READ_ONLY_UPSTREAM_REPOSITORY,
  WRITABLE_REPOSITORY,
  normalizeRepositorySlug,
  parseGitRemoteVerbose,
  validateRepoBoundary
} from "../src/safety/repoBoundary.js";

describe("repo boundary safety", () => {
  it("normalizes common GitHub remote URL formats", () => {
    expect(normalizeRepositorySlug("https://github.com/TojotheTerror/symphony.git")).toBe(
      WRITABLE_REPOSITORY
    );
    expect(normalizeRepositorySlug("git@github.com:openai/symphony.git")).toBe(
      READ_ONLY_UPSTREAM_REPOSITORY
    );
    expect(normalizeRepositorySlug("ssh://git@github.com/TojotheTerror/symphony.git")).toBe(
      WRITABLE_REPOSITORY
    );
    expect(normalizeRepositorySlug("DISABLED")).toBeNull();
  });

  it("parses git remote verbose output into fetch and push pairs", () => {
    const remotes = parseGitRemoteVerbose(`origin https://github.com/TojotheTerror/symphony.git (fetch)
origin https://github.com/TojotheTerror/symphony.git (push)
upstream https://github.com/openai/symphony.git (fetch)
upstream DISABLED (push)`);

    expect(remotes).toEqual([
      {
        name: "origin",
        fetchUrl: "https://github.com/TojotheTerror/symphony.git",
        pushUrl: "https://github.com/TojotheTerror/symphony.git"
      },
      {
        name: "upstream",
        fetchUrl: "https://github.com/openai/symphony.git",
        pushUrl: "DISABLED"
      }
    ]);
  });

  it("accepts the intended writable origin and disabled upstream push URL", () => {
    const report = validateRepoBoundary({
      requestedWriteTarget: "TojotheTerror/symphony",
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://github.com/TojotheTerror/symphony.git",
          pushUrl: "https://github.com/TojotheTerror/symphony.git"
        },
        {
          name: "upstream",
          fetchUrl: "https://github.com/openai/symphony.git",
          pushUrl: "DISABLED"
        }
      ]
    });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("fails closed when no write target is supplied", () => {
    const report = validateRepoBoundary({
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://github.com/TojotheTerror/symphony.git",
          pushUrl: "https://github.com/TojotheTerror/symphony.git"
        }
      ]
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain("No provable write target was supplied; automation must fail closed.");
  });

  it("rejects upstream or unrelated write targets", () => {
    const upstreamReport = validateRepoBoundary({
      requestedWriteTarget: "openai/symphony",
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://github.com/TojotheTerror/symphony.git",
          pushUrl: "https://github.com/TojotheTerror/symphony.git"
        }
      ]
    });
    const unrelatedReport = validateRepoBoundary({
      requestedWriteTarget: "microsoft/intelligent-terminal",
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://github.com/TojotheTerror/symphony.git",
          pushUrl: "https://github.com/TojotheTerror/symphony.git"
        }
      ]
    });

    expect(upstreamReport.ok).toBe(false);
    expect(unrelatedReport.ok).toBe(false);
  });

  it("rejects any enabled push URL to the read-only upstream", () => {
    const report = validateRepoBoundary({
      requestedWriteTarget: "TojotheTerror/symphony",
      remotes: [
        {
          name: "origin",
          fetchUrl: "https://github.com/TojotheTerror/symphony.git",
          pushUrl: "https://github.com/TojotheTerror/symphony.git"
        },
        {
          name: "upstream",
          fetchUrl: "https://github.com/openai/symphony.git",
          pushUrl: "https://github.com/openai/symphony.git"
        }
      ]
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "Remote 'upstream' points at read-only upstream 'openai/symphony' without a disabled push URL."
    );
    expect(report.errors).toContain("Remote 'upstream' has forbidden push target 'openai/symphony'.");
  });
});
