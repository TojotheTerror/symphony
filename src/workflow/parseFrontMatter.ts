import { parseDocument } from "yaml";

import { WorkflowError } from "./errors.js";

export interface ParsedWorkflow {
  config: Record<string, unknown>;
  promptTemplate: string;
}

export function parseWorkflowMarkdown(markdown: string): ParsedWorkflow {
  return parseWorkflowMarkdownInternal(markdown, { requireFrontMatter: true, requirePrompt: true });
}

/**
 * Non-executable utility parser for tooling that only needs to split optional
 * front matter from markdown. The executable workflow loader must use
 * parseWorkflowMarkdown so malformed workflow files fail closed.
 */
export function parseNonExecutableWorkflowMarkdown(markdown: string): ParsedWorkflow {
  return parseWorkflowMarkdownInternal(markdown, { requireFrontMatter: false, requirePrompt: false });
}

function parseWorkflowMarkdownInternal(
  markdown: string,
  options: { requireFrontMatter: boolean; requirePrompt: boolean }
): ParsedWorkflow {
  const withoutBom = markdown.replace(/^\uFEFF/, "");
  const lines = withoutBom.split(/\r?\n/);

  if (lines[0]?.trim() !== "---") {
    if (options.requireFrontMatter) {
      throw new WorkflowError(
        "workflow_missing_front_matter",
        "Executable WORKFLOW.md files must start with YAML front matter."
      );
    }

    return {
      config: {},
      promptTemplate: withoutBom.trim()
    };
  }

  const closingDelimiterIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closingDelimiterIndex === -1) {
    throw new WorkflowError(
      "workflow_parse_error",
      "WORKFLOW.md front matter is missing a closing delimiter."
    );
  }

  const yamlText = lines.slice(1, closingDelimiterIndex).join("\n");
  const promptTemplate = lines.slice(closingDelimiterIndex + 1).join("\n").trim();
  if (options.requirePrompt && promptTemplate.length === 0) {
    throw new WorkflowError(
      "workflow_empty_prompt",
      "Executable WORKFLOW.md files must include a non-empty prompt body."
    );
  }

  const config = parseFrontMatterYaml(yamlText);

  return {
    config,
    promptTemplate
  };
}

function parseFrontMatterYaml(yamlText: string): Record<string, unknown> {
  const document = parseDocument(yamlText, { prettyErrors: false });

  if (document.errors.length > 0) {
    throw new WorkflowError(
      "workflow_parse_error",
      "WORKFLOW.md front matter contains invalid YAML.",
      document.errors.map((error) => error.message)
    );
  }

  const parsed = document.toJS() as unknown;
  if (parsed === null || parsed === undefined) {
    return {};
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowError(
      "workflow_front_matter_not_a_map",
      "WORKFLOW.md front matter must decode to a YAML map/object."
    );
  }

  return parsed as Record<string, unknown>;
}
