import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkflowError } from "../src/workflow/errors.js";
import { loadWorkflow, loadWorkflowDefinition } from "../src/workflow/loadWorkflow.js";
import { parseWorkflowMarkdown } from "../src/workflow/parseFrontMatter.js";

describe("workflow front matter parsing", () => {
  it("returns YAML front matter config and trimmed prompt body", () => {
    const parsed = parseWorkflowMarkdown(`---
tracker:
  kind: linear
  project_id: project-1
---

Work on {{ issue.identifier }}.
`);

    expect(parsed).toEqual({
      config: {
        tracker: {
          kind: "linear",
          project_id: "project-1"
        }
      },
      promptTemplate: "Work on {{ issue.identifier }}."
    });
  });

  it("treats markdown without front matter as prompt-only content", () => {
    const parsed = parseWorkflowMarkdown("  Plain prompt body.  \n");

    expect(parsed).toEqual({
      config: {},
      promptTemplate: "Plain prompt body."
    });
  });

  it("rejects invalid YAML clearly", () => {
    expect(() => parseWorkflowMarkdown("---\ntracker: [\n---\nPrompt")).toThrow(
      expect.objectContaining({
        code: "workflow_parse_error"
      })
    );
  });

  it("rejects non-map front matter", () => {
    expect(() => parseWorkflowMarkdown("---\n- nope\n---\nPrompt")).toThrow(
      expect.objectContaining({
        code: "workflow_front_matter_not_a_map"
      })
    );
  });

  it("loads WORKFLOW.md from disk using the provided cwd", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "symphony-workflow-test-"));
    try {
      await writeFile(
        path.join(tempDir, "WORKFLOW.md"),
        "---\ntracker:\n  kind: linear\n  project_id: project-1\n---\nPrompt\n",
        "utf8"
      );

      const workflow = await loadWorkflowDefinition({ cwd: tempDir });
      expect(workflow.path).toBe(path.join(tempDir, "WORKFLOW.md"));
      expect(workflow.promptTemplate).toBe("Prompt");
      expect(workflow.config.tracker).toEqual({
        kind: "linear",
        project_id: "project-1"
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses a typed error when the workflow file is missing", async () => {
    await expect(loadWorkflowDefinition({ cwd: path.join(os.tmpdir(), "missing-symphony-dir") }))
      .rejects.toThrow(WorkflowError);
  });

  it("loads the repository WORKFLOW.md with typed config", async () => {
    const workflow = await loadWorkflow({ cwd: process.cwd() });

    expect(workflow.typedConfig.tracker.requiredLabels).toContain("symphony-ready");
    expect(workflow.typedConfig.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    expect(workflow.typedConfig.tracker.reviewStates).toEqual(["In Review"]);
    expect(workflow.typedConfig.tracker.terminalStates).toEqual(["Done", "Canceled", "Duplicate"]);
    expect(workflow.typedConfig.agent.maxConcurrentAgents).toBe(2);
  });
});
