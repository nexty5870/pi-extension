import { contractHash, renderLinearContract } from "./contracts.ts";
import { hasLinearDestination } from "./linear-policy.ts";
import type { ApprovedContractRecord, FeatureOrBugContract } from "./types.ts";

export function approveContractLocally(
  contract: FeatureOrBugContract,
  approvedAt: string,
): ApprovedContractRecord {
  const configured = hasLinearDestination(contract);
  return {
    version: contract.version,
    contentHash: contractHash(contract),
    approvedAt,
    approvedBy: "operator",
    source: "local",
    linearPersistence: configured ? "pending" : "not-configured",
    issueId: contract.linear.issueId,
    issueIdentifier: contract.linear.issueIdentifier,
  };
}

export interface LinearPersistencePlan {
  toolName: "linear_create_issue" | "linear_update_issue";
  arguments: Record<string, unknown>;
}

/** Build a pi-linear call plan; returning undefined guarantees local approval performs no Linear call. */
export function planLinearPersistence(
  contract: FeatureOrBugContract,
  approvedAt: string,
): LinearPersistencePlan | undefined {
  if (!hasLinearDestination(contract)) return undefined;
  const description = renderLinearContract(contract, approvedAt);
  const issue = contract.linear.issueId ?? contract.linear.issueIdentifier;
  if (issue) {
    return {
      toolName: "linear_update_issue",
      arguments: { issue, title: contract.title, description },
    };
  }
  return {
    toolName: "linear_create_issue",
    arguments: {
      teamKey: contract.linear.team,
      title: contract.title,
      description,
      ...(contract.linear.project ? { projectId: contract.linear.project } : {}),
    },
  };
}
