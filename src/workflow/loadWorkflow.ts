import { readFile } from "node:fs/promises";
import path from "node:path";

import { WorkflowError } from "./errors.js";
import { type WorkflowConfig, type WorkflowConfigOptions, validateWorkflowConfig } from "./config.js";
import { type ParsedWorkflow, parseWorkflowMarkdown } from "./parseFrontMatter.js";

export interface WorkflowDefinition extends ParsedWorkflow {
  path: string;
}

export interface LoadedWorkflow extends WorkflowDefinition {
  typedConfig: WorkflowConfig;
}

export interface LoadWorkflowOptions extends WorkflowConfigOptions {
  workflowPath?: string;
}

export async function loadWorkflowDefinition(
  options: LoadWorkflowOptions = {}
): Promise<WorkflowDefinition> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workflowPath = path.resolve(cwd, options.workflowPath ?? "WORKFLOW.md");

  let contents: string;
  try {
    contents = await readFile(workflowPath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    if (code === "ENOENT") {
      throw new WorkflowError("missing_workflow_file", `Workflow file not found: ${workflowPath}`);
    }
    throw error;
  }

  return {
    path: workflowPath,
    ...parseWorkflowMarkdown(contents)
  };
}

export async function loadWorkflow(options: LoadWorkflowOptions = {}): Promise<LoadedWorkflow> {
  const definition = await loadWorkflowDefinition(options);
  const typedConfig = validateWorkflowConfig(definition.config, {
    ...options,
    workflowFilePath: definition.path
  });

  return {
    ...definition,
    typedConfig
  };
}
