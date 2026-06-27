export type WorkflowErrorCode =
  | "missing_workflow_file"
  | "workflow_missing_front_matter"
  | "workflow_empty_prompt"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "workflow_config_invalid";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly issues: string[];

  constructor(code: WorkflowErrorCode, message: string, issues: string[] = []) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.issues = issues;
  }
}

export function formatWorkflowError(error: WorkflowError): string {
  if (error.issues.length === 0) {
    return `${error.code}: ${error.message}`;
  }

  return `${error.code}: ${error.message}\n${error.issues.map((issue) => `- ${issue}`).join("\n")}`;
}
