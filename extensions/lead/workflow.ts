export type LeadWorkflow = "v2" | "v4";

/**
 * Select the Lead implementation before either workflow initializes runtime work.
 *
 * Explicit selectors win. Without one, durable V2 worker identity preserves
 * compatibility with workers launched by pre-V4-default Lead processes.
 */
export function selectLeadWorkflow(environment: NodeJS.ProcessEnv = process.env): LeadWorkflow {
  if (environment.PI_LEAD_V4 === "0") return "v2";
  if (environment.PI_LEAD_V4 === "1") return "v4";
  if (environment.PI_LEAD_TASK_ID && environment.PI_LEAD_PROJECT_ID) return "v2";
  return "v4";
}
