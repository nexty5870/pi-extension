import { createHash, randomUUID } from "node:crypto";
import type {
  BugContract,
  FeatureContract,
  FeatureOrBugContract,
  InitiativeState,
  LinearDestination,
  ProjectContext,
  DeliveryMetadata,
} from "./types.ts";

export interface ContractDraftInput {
  kind: "feature" | "bug";
  title: string;
  version?: number;
  linear?: Partial<LinearDestination>;
  delivery?: Partial<DeliveryMetadata>;
  outcome?: string;
  context?: string;
  inScope?: string[];
  outOfScope?: string[];
  acceptanceCriteria?: string[];
  constraints?: string[];
  dependencies?: string[];
  validation?: string[];
  rollout?: string[];
  documentation?: string[];
  impact?: string;
  environment?: string;
  reproductionSteps?: string[];
  expectedBehavior?: string;
  actualBehavior?: string;
  evidence?: string[];
  frequency?: string;
  triggeringConditions?: string[];
  workaround?: string;
  suspectedArea?: string;
  regressionTests?: string[];
}

const clean = (value: string | undefined): string => value?.trim() ?? "";
const cleanList = (values: string[] | undefined): string[] =>
  (values ?? []).map((value) => value.trim()).filter(Boolean);

export function contractFromInput(input: ContractDraftInput): FeatureOrBugContract {
  const linear: LinearDestination = {
    team: clean(input.linear?.team) || undefined,
    project: clean(input.linear?.project) || undefined,
    issueId: clean(input.linear?.issueId) || undefined,
    issueIdentifier: clean(input.linear?.issueIdentifier) || undefined,
  };
  const delivery = input.delivery
    ? {
        baseBranch: clean(input.delivery.baseBranch),
        branchName: clean(input.delivery.branchName),
        commitMessage: clean(input.delivery.commitMessage),
        prTitle: clean(input.delivery.prTitle),
        prBody: clean(input.delivery.prBody),
        checks: (input.delivery.checks ?? []).map((check) => cleanList(check)),
      }
    : undefined;

  if (input.kind === "feature") {
    return {
      kind: "feature",
      title: clean(input.title),
      version: input.version ?? 1,
      linear,
      delivery,
      outcome: clean(input.outcome),
      context: clean(input.context),
      inScope: cleanList(input.inScope),
      outOfScope: cleanList(input.outOfScope),
      acceptanceCriteria: cleanList(input.acceptanceCriteria),
      constraints: cleanList(input.constraints),
      dependencies: cleanList(input.dependencies),
      validation: cleanList(input.validation),
      rollout: cleanList(input.rollout),
      documentation: cleanList(input.documentation),
    } satisfies FeatureContract;
  }

  return {
    kind: "bug",
    title: clean(input.title),
    version: input.version ?? 1,
    linear,
    delivery,
    impact: clean(input.impact),
    environment: clean(input.environment),
    reproductionSteps: cleanList(input.reproductionSteps),
    expectedBehavior: clean(input.expectedBehavior),
    actualBehavior: clean(input.actualBehavior),
    evidence: cleanList(input.evidence),
    frequency: clean(input.frequency),
    triggeringConditions: cleanList(input.triggeringConditions),
    workaround: clean(input.workaround),
    suspectedArea: clean(input.suspectedArea) || undefined,
    acceptanceCriteria: cleanList(input.acceptanceCriteria),
    regressionTests: cleanList(input.regressionTests),
  } satisfies BugContract;
}

export function validateContract(contract: FeatureOrBugContract): string[] {
  const errors: string[] = [];
  if (!contract.title) errors.push("title is required");
  if (!Number.isInteger(contract.version) || contract.version < 1) {
    errors.push("version must be a positive integer");
  }
  if (contract.delivery) {
    const delivery = contract.delivery;
    if (!delivery.baseBranch) errors.push("delivery base branch is required");
    if (!/^[-A-Za-z0-9._/]+$/.test(delivery.branchName) || delivery.branchName.startsWith("-") || delivery.branchName.includes("..")) {
      errors.push("delivery branch name is unsafe");
    }
    if (!delivery.commitMessage) errors.push("delivery commit message is required");
    if (!delivery.prTitle) errors.push("delivery PR title is required");
    if (!delivery.prBody) errors.push("delivery PR body is required");
    if (delivery.checks.length === 0 || delivery.checks.some((check) => check.length === 0 || check.some((arg) => !arg || arg.includes("\0")))) {
      errors.push("delivery checks must be non-empty argv arrays");
    }
  }

  if (contract.kind === "feature") {
    if (!contract.outcome) errors.push("feature outcome is required");
    if (!contract.context) errors.push("feature context is required");
    if (contract.inScope.length === 0) errors.push("feature in-scope items are required");
    if (contract.acceptanceCriteria.length === 0) errors.push("feature acceptance criteria are required");
    if (contract.validation.length === 0) errors.push("feature validation requirements are required");
  } else {
    if (!contract.impact) errors.push("bug impact is required");
    if (!contract.environment) errors.push("bug environment is required");
    if (contract.reproductionSteps.length === 0) errors.push("bug reproduction steps are required");
    if (!contract.expectedBehavior) errors.push("expected behavior is required");
    if (!contract.actualBehavior) errors.push("actual behavior is required");
    if (contract.acceptanceCriteria.length === 0) errors.push("fix acceptance criteria are required");
    if (contract.regressionTests.length === 0) errors.push("regression-test requirements are required");
  }
  return errors;
}

function bullets(items: string[], empty = "- None identified"): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty;
}

function numbered(items: string[]): string {
  return items.length > 0
    ? items.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "1. Not yet provided";
}

function destination(contract: FeatureOrBugContract): string {
  if (!contract.linear.issueId && !contract.linear.team) {
    return "- GitHub/docs-only; no Linear mutation.";
  }
  const values = [
    "- Integration: `@alasano/pi-linear`",
    contract.linear.team ? `- Team: ${contract.linear.team}` : undefined,
    contract.linear.project ? `- Project: ${contract.linear.project}` : undefined,
    contract.linear.issueIdentifier
      ? `- Existing issue: ${contract.linear.issueIdentifier}`
      : contract.linear.issueId
        ? `- Existing issue ID: ${contract.linear.issueId}`
        : "- Issue: create on approval",
  ];
  return values.filter(Boolean).join("\n");
}

export function parseContractMarkdown(
  markdown: string,
  original: FeatureOrBugContract,
): FeatureOrBugContract {
  const sections = new Map<string, string>();
  const headingPattern = /^## (.+)$/gm;
  const headings = [...markdown.matchAll(headingPattern)];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? markdown.length;
    sections.set(heading[1].trim().toLowerCase(), markdown.slice(start, end).trim());
  }
  const title = markdown.match(/^# (?:Feature|Bug) Contract:\s*(.+)$/m)?.[1]?.trim() ?? original.title;
  const versionText = markdown.match(/^\*\*Contract version:\*\*\s*(\d+)$/m)?.[1];
  const version = versionText ? Number.parseInt(versionText, 10) : original.version;
  const text = (heading: string, fallback: string): string => sections.get(heading)?.trim() ?? fallback;
  const list = (heading: string, fallback: string[]): string[] => {
    const value = sections.get(heading);
    if (value === undefined) return fallback;
    return value
      .split("\n")
      .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
      .filter((line) => line && line !== "None identified" && line !== "Not yet provided");
  };

  const deliverySection = sections.get("delivery");
  const delivery = deliverySection === undefined
    ? original.delivery
    : parseDeliverySection(deliverySection, original.delivery);

  if (original.kind === "feature") {
    return {
      ...original,
      delivery,
      title,
      version,
      outcome: text("outcome and user value", original.outcome),
      context: text("context", original.context),
      inScope: list("in scope", original.inScope),
      outOfScope: list("out of scope", original.outOfScope),
      acceptanceCriteria: list("acceptance criteria", original.acceptanceCriteria),
      constraints: list("constraints", original.constraints),
      dependencies: list("dependencies", original.dependencies),
      validation: list("validation requirements", original.validation),
      rollout: list("rollout requirements", original.rollout),
      documentation: list("documentation requirements", original.documentation),
    };
  }

  const suspectedArea = text("suspected area", original.suspectedArea ?? "");
  return {
    ...original,
    delivery,
    title,
    version,
    impact: text("impact", original.impact),
    environment: text("affected environment", original.environment),
    reproductionSteps: list("reproduction steps", original.reproductionSteps),
    expectedBehavior: text("expected behavior", original.expectedBehavior),
    actualBehavior: text("actual behavior", original.actualBehavior),
    evidence: list("evidence", original.evidence),
    frequency: text("frequency", original.frequency),
    triggeringConditions: list("triggering conditions", original.triggeringConditions),
    workaround: text("workaround", original.workaround),
    suspectedArea: suspectedArea === "Not yet identified" ? undefined : suspectedArea,
    acceptanceCriteria: list("fix acceptance criteria", original.acceptanceCriteria),
    regressionTests: list("regression-test requirements", original.regressionTests),
  };
}

function renderDelivery(delivery: DeliveryMetadata | undefined): string {
  if (!delivery) return "";
  return `\n## Delivery\n\n` +
    `- Base branch: \`${delivery.baseBranch}\`\n` +
    `- Branch: \`${delivery.branchName}\`\n` +
    `- Commit: ${delivery.commitMessage}\n` +
    `- PR title: ${delivery.prTitle}\n` +
    `- PR body (JSON): ${JSON.stringify(delivery.prBody)}\n` +
    `- Checks (JSON): ${JSON.stringify(delivery.checks)}\n`;
}

function parseDeliverySection(section: string, fallback?: DeliveryMetadata): DeliveryMetadata | undefined {
  const field = (name: string) => section.match(new RegExp(`^- ${name}: (.+)$`, "mi"))?.[1]?.trim();
  const unquote = (value: string | undefined) => value?.replace(/^`|`$/g, "") ?? "";
  try {
    const body = field("PR body \\(JSON\\)");
    const checks = field("Checks \\(JSON\\)");
    return {
      baseBranch: unquote(field("Base branch")) || fallback?.baseBranch || "",
      branchName: unquote(field("Branch")) || fallback?.branchName || "",
      commitMessage: field("Commit") || fallback?.commitMessage || "",
      prTitle: field("PR title") || fallback?.prTitle || "",
      prBody: body ? JSON.parse(body) : fallback?.prBody || "",
      checks: checks ? JSON.parse(checks) : fallback?.checks || [],
    };
  } catch {
    return { baseBranch: "", branchName: "", commitMessage: "", prTitle: "", prBody: "", checks: [] };
  }
}

export function renderContract(contract: FeatureOrBugContract): string {
  const header = `# ${contract.kind === "feature" ? "Feature" : "Bug"} Contract: ${contract.title}\n\n` +
    `**Contract version:** ${contract.version}\n\n` +
    `## Linear destination\n\n${destination(contract)}\n` + renderDelivery(contract.delivery);

  if (contract.kind === "feature") {
    return `${header}
## Outcome and user value

${contract.outcome}

## Context

${contract.context}

## In scope

${bullets(contract.inScope)}

## Out of scope

${bullets(contract.outOfScope)}

## Acceptance criteria

${bullets(contract.acceptanceCriteria)}

## Constraints

${bullets(contract.constraints)}

## Dependencies

${bullets(contract.dependencies)}

## Validation requirements

${bullets(contract.validation)}

## Rollout requirements

${bullets(contract.rollout)}

## Documentation requirements

${bullets(contract.documentation)}
`;
  }

  return `${header}
## Impact

${contract.impact}

## Affected environment

${contract.environment}

## Reproduction steps

${numbered(contract.reproductionSteps)}

## Expected behavior

${contract.expectedBehavior}

## Actual behavior

${contract.actualBehavior}

## Evidence

${bullets(contract.evidence)}

## Frequency

${contract.frequency || "Not yet established"}

## Triggering conditions

${bullets(contract.triggeringConditions)}

## Workaround

${contract.workaround || "None known"}

## Suspected area

${contract.suspectedArea || "Not yet identified"}

## Fix acceptance criteria

${bullets(contract.acceptanceCriteria)}

## Regression-test requirements

${bullets(contract.regressionTests)}
`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contractHash(contract: FeatureOrBugContract): string {
  return `sha256:${createHash("sha256").update(canonical(contract)).digest("hex")}`;
}

export function renderLinearContract(
  contract: FeatureOrBugContract,
  approvedAt: string,
  contentHash = contractHash(contract),
): string {
  const body = renderContract(contract).replace(/^# /, "## Approved ");
  return [
    "<!-- pi-contract:start -->",
    body.trim(),
    "",
    `**Approved at:** ${approvedAt}`,
    `**Content hash:** \`${contentHash}\``,
    "<!-- pi-contract:end -->",
  ].join("\n");
}

export function replaceLinearContractSection(description: string, section: string): string {
  const pattern = /<!-- pi-contract:start -->[\s\S]*?<!-- pi-contract:end -->/;
  if (pattern.test(description)) return description.replace(pattern, section);
  const trimmed = description.trimEnd();
  return `${trimmed}${trimmed ? "\n\n" : ""}${section}\n`;
}

export function createInitiativeState(
  project: ProjectContext,
  contract: FeatureOrBugContract,
  previous?: InitiativeState,
): InitiativeState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    initiativeId: previous?.initiativeId ?? randomUUID(),
    projectId: project.projectId,
    projectRoot: project.projectRoot,
    cmuxWorkspaceId: project.cmuxWorkspaceId,
    cmuxSurfaceId: project.cmuxSurfaceId,
    status: "review",
    contract,
    approved: previous?.approved,
    contractPath: previous?.contractPath,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}
