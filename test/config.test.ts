import os from "node:os";
import path from "node:path";

import { validateWorkflowConfig } from "../src/workflow/config.js";
import { CODEX_APP_SERVER_STDIO_COMMAND } from "../src/codex/launchContract.js";

describe("workflow config validation", () => {
  it("applies safe defaults and accepts project ID scoped Linear config", () => {
    const config = validateWorkflowConfig({
      tracker: {
        kind: "linear",
        project_id: "58458325-6450-4df7-b795-6752f8e1a64b",
        required_labels: ["symphony-ready"]
      }
    });

    expect(config.tracker).toMatchObject({
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      projectId: "58458325-6450-4df7-b795-6752f8e1a64b",
      requiredLabels: ["symphony-ready"],
      activeStates: ["Todo", "In Progress"],
      reviewStates: ["In Review"],
      terminalStates: ["Done", "Canceled", "Duplicate"]
    });
    expect(config.agent.maxConcurrentAgents).toBe(2);
    expect(config.agent.maxTurns).toBe(20);
    expect(config.codex.command).toBe(CODEX_APP_SERVER_STDIO_COMMAND);
    expect(config.workspace.root).toBe(path.join(os.tmpdir(), "symphony_workspaces"));
  });

  it("accepts project slug scoping and normalizes required labels", () => {
    const config = validateWorkflowConfig({
      tracker: {
        kind: "linear",
        project_slug: "symphony-foundation",
        required_labels: [" Symphony-Ready ", "Docs"]
      }
    });

    expect(config.tracker.projectSlug).toBe("symphony-foundation");
    expect(config.tracker.requiredLabels).toEqual(["symphony-ready", "docs"]);
  });

  it("rejects unsupported tracker kinds", () => {
    expect(() =>
      validateWorkflowConfig({
        tracker: {
          kind: "github",
          project_id: "project-1",
          required_labels: ["symphony-ready"]
        }
      })
    ).toThrow(expect.objectContaining({ code: "workflow_config_invalid" }));
  });

  it("rejects Linear config without project scope", () => {
    expect(() =>
      validateWorkflowConfig({
        tracker: {
          kind: "linear",
          required_labels: ["symphony-ready"]
        }
      })
    ).toThrow(expect.objectContaining({ code: "workflow_config_invalid" }));
  });

  it("rejects configs that would allow the broad symphony label alone", () => {
    expect(() =>
      validateWorkflowConfig({
        tracker: {
          kind: "linear",
          project_id: "project-1",
          required_labels: ["symphony"]
        }
      })
    ).toThrow(expect.objectContaining({ code: "workflow_config_invalid" }));
  });

  it("resolves workspace.root relative to the workflow file directory", () => {
    const config = validateWorkflowConfig(
      {
        tracker: {
          kind: "linear",
          project_id: "project-1",
          required_labels: ["symphony-ready"]
        },
        workspace: {
          root: "workspaces"
        }
      },
      {
        workflowFilePath: path.join(os.tmpdir(), "repo", "WORKFLOW.md")
      }
    );

    expect(config.workspace.root).toBe(path.join(os.tmpdir(), "repo", "workspaces"));
  });

  it("resolves env-backed workspace roots only when explicitly referenced", () => {
    const config = validateWorkflowConfig(
      {
        tracker: {
          kind: "linear",
          project_id: "project-1",
          required_labels: ["symphony-ready"]
        },
        workspace: {
          root: "$SYMPHONY_WORKSPACE_ROOT"
        }
      },
      {
        env: {
          SYMPHONY_WORKSPACE_ROOT: path.join(os.tmpdir(), "configured-workspaces")
        }
      }
    );

    expect(config.workspace.root).toBe(path.join(os.tmpdir(), "configured-workspaces"));
  });

  it("resolves env-backed tracker API keys without global override behavior", () => {
    const config = validateWorkflowConfig(
      {
        tracker: {
          kind: "linear",
          project_id: "project-1",
          api_key: "$LINEAR_API_KEY",
          required_labels: ["symphony-ready"]
        }
      },
      {
        env: {
          LINEAR_API_KEY: "linear-key"
        }
      }
    );

    expect(config.tracker.apiKey).toBe("linear-key");
  });

  it("rejects blank codex commands and workspace roots", () => {
    expect(() =>
      validateWorkflowConfig({
        tracker: {
          kind: "linear",
          project_id: "project-1",
          required_labels: ["symphony-ready"]
        },
        codex: {
          command: "  "
        }
      })
    ).toThrow(expect.objectContaining({ code: "workflow_config_invalid" }));

    expect(() =>
      validateWorkflowConfig({
        tracker: {
          kind: "linear",
          project_id: "project-1",
          required_labels: ["symphony-ready"]
        },
        workspace: {
          root: ""
        }
      })
    ).toThrow(expect.objectContaining({ code: "workflow_config_invalid" }));
  });
});
