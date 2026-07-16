import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { classifyApprovalIntent, extractLinearIssueIdentifiers, isCompletionDirective, isImplementationStartDirective, isLinearIssueAdminDirective, isLinearIssueCreateDirective, isLinearPlanPublishCancelDirective, isLinearPlanPublishDirective, restoreLinearPlanPublishIntent, type ApprovalIntent } from "./approval.ts";
import {
  contractFromInput,
  contractHash,
  createInitiativeState,
  parseContractMarkdown,
  renderContract,
  validateContract,
  type ContractDraftInput,
} from "./contracts.ts";
import { loadMcpConfig } from "./mcp/config.ts";
import { McpManager } from "./mcp/client.ts";
import { authorizeLinearTool, collectCompletedStatusIds, collectLinearResourceAliases, isLinearMcpRoute } from "./linear-policy.ts";
import { notifyActionRequired } from "./notifications.ts";
import { TeamOverviewComponent } from "./overview/component.ts";
import { resolveProjectContext } from "./project-context.ts";
import { runReadOnlyScout } from "./scout.ts";
import {
  initiativeSessionName,
  persistInitiativeEntry,
  restoreInitiative,
} from "./session-state.ts";
import { OrchestrationStore } from "./store.ts";
import { approveContractLocally, isApprovedContractCreatePending, normalizeApprovedIssueCreateArguments, normalizeDirectIssueCreateArguments, normalizeDirectProjectCreateArguments, planLinearPersistence } from "./persistence.ts";
import { ArgvCommandRunner } from "./delivery/command.ts";
import { GitAdapter } from "./delivery/git.ts";
import { GitHubAdapter } from "./delivery/github.ts";
import { CmuxAdapter } from "./delivery/cmux.ts";
import { DeliveryController } from "./delivery/controller.ts";
import { DeliveryStore } from "./delivery/store.ts";
import { runDeliveryWorker } from "./delivery/worker.ts";
import { renderTeamFooter, type TeamUiSnapshot } from "./delivery/ui.ts";
import type { DeliveryState } from "./delivery/types.ts";
import type { InitiativeState, ProjectContext } from "./types.ts";

const MAX_TOOL_TEXT = 50 * 1024;

const optionalString = () => Type.Optional(Type.String());
const optionalStrings = () => Type.Optional(Type.Array(Type.String()));

const ContractDraftParams = Type.Object({
  kind: StringEnum(["feature", "bug"] as const),
  title: Type.String(),
  version: Type.Optional(Type.Integer({ minimum: 1 })),
  linear: Type.Optional(Type.Object({
    team: optionalString(),
    project: optionalString(),
    issueId: optionalString(),
    issueIdentifier: optionalString(),
  })),
  delivery: Type.Optional(Type.Object({
    baseBranch: Type.String(),
    branchName: Type.String(),
    commitMessage: Type.String(),
    prTitle: Type.String(),
    prBody: Type.String(),
    checks: Type.Array(Type.Array(Type.String(), { minItems: 1 }), { minItems: 1 }),
  })),
  outcome: optionalString(),
  context: optionalString(),
  inScope: optionalStrings(),
  outOfScope: optionalStrings(),
  acceptanceCriteria: optionalStrings(),
  constraints: optionalStrings(),
  dependencies: optionalStrings(),
  validation: optionalStrings(),
  rollout: optionalStrings(),
  documentation: optionalStrings(),
  impact: optionalString(),
  environment: optionalString(),
  reproductionSteps: optionalStrings(),
  expectedBehavior: optionalString(),
  actualBehavior: optionalString(),
  evidence: optionalStrings(),
  frequency: optionalString(),
  triggeringConditions: optionalStrings(),
  workaround: optionalString(),
  suspectedArea: optionalString(),
  regressionTests: optionalStrings(),
});

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text").map((part) => String((part as { text?: unknown }).text ?? "")).join("\n");
  return "";
}

function sessionUserMessages(ctx: ExtensionContext): string[] {
  const messages: string[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    messages.push(messageContentText(entry.message.content));
  }
  return messages;
}

function restoreContractApprovalIntent(ctx: ExtensionContext): boolean {
  let contractPresented = false;
  let armed = false;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "toolCall" && part.name === "team_contract_draft")) {
      contractPresented = true;
      armed = false;
    } else if (entry.message.role === "user" && contractPresented) {
      const intent = classifyApprovalIntent(messageContentText(entry.message.content));
      if (intent === "explicit") armed = true;
      else if (intent === "ambiguous") armed = false;
    }
  }
  return armed;
}

function restoredIssueAdminRefs(ctx: ExtensionContext): Set<string> {
  let latestAssistant = "";
  let authorized = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      latestAssistant = entry.message.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n");
    } else if (entry.message.role === "user") {
      const text = messageContentText(entry.message.content);
      if (isImplementationStartDirective(text)) authorized = new Set<string>();
      else if (isLinearIssueAdminDirective(text)) authorized = new Set([...extractLinearIssueIdentifiers(text), ...extractLinearIssueIdentifiers(latestAssistant)]);
    }
  }
  return authorized;
}

function latestAssistantText(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    return entry.message.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n");
  }
  return "";
}

function displayJson(value: unknown): string {
  const output = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(output, "utf8") <= MAX_TOOL_TEXT) return output;
  return `${output.slice(0, MAX_TOOL_TEXT)}\n\n[Output truncated at ${MAX_TOOL_TEXT} bytes]`;
}

function findLinearIssue(value: unknown): { id?: string; identifier?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findLinearIssue(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  const identifier = typeof record.identifier === "string" ? record.identifier : undefined;
  if (id || identifier) return { id, identifier };
  for (const item of Object.values(record)) {
    const found = findLinearIssue(item);
    if (found) return found;
  }
  return undefined;
}

export default function orchestrationExtension(pi: ExtensionAPI) {
  const store = new OrchestrationStore();
  let project: ProjectContext | undefined;
  let initiative: InitiativeState | undefined;
  let manager: McpManager | undefined;
  let approvalArmed = false;
  let approvalIntent: ApprovalIntent = "none";
  let implementationIntentArmed = false;
  let operatorIssueCreateArmed = false;
  let operatorIssueAdminArmed = false;
  let operatorIssueAdminRefs = new Set<string>();
  let operatorPlanPublishArmed = false;
  let linearCreateInFlight = false;
  let linearProjectInFlight = false;
  let linearPlanIssueCount = 0;
  let linearPlanProjectIds = new Set<string>();
  let operatorWorkflowUpdateArmed = false;
  let completedWorkflowStatusIds = new Set<string>();
  let linearResourceAliases = new Map<string, string>();
  let delivery: DeliveryState | undefined;
  let activeDeliveryAbort: AbortController | undefined;
  const uiSnapshot: TeamUiSnapshot = {};
  let requestFooterRender: (() => void) | undefined;

  const requireProject = (): ProjectContext => {
    if (!project) throw new Error("Project context is not initialized");
    return project;
  };

  const loadManager = async (): Promise<McpManager> => {
    if (manager) return manager;
    const config = await loadMcpConfig(store.configPath());
    manager = new McpManager(config, async (denial) => {
      if (initiative) {
        await store.writeEvent(initiative, "mcp.denied", denial as unknown as Record<string, unknown>);
      }
    });
    return manager;
  };

  const saveInitiative = async (state: InitiativeState): Promise<void> => {
    state.updatedAt = new Date().toISOString();
    await store.writeInitiative(state);
    persistInitiativeEntry(pi, state);
    initiative = state;
    uiSnapshot.initiativeState = state.status;
    const name = initiativeSessionName(state);
    if (name && pi.getSessionName() !== name) pi.setSessionName(name);
  };

  const verifyApprovedContractFile = async (): Promise<void> => {
    if (!initiative?.contract || !initiative.approved) throw new Error("No approved contract is active");
    const markdown = await readFile(initiative.contractPath ?? store.contractPath(initiative), "utf8");
    const reviewMarkdown = markdown.split(/\n---\n\n\*\*Approved at:\*\*/)[0] ?? markdown;
    const current = parseContractMarkdown(reviewMarkdown, initiative.contract);
    const errors = validateContract(current);
    if (errors.length) throw new Error(`Current contract is invalid:\n- ${errors.join("\n- ")}`);
    if (contractHash(current) !== initiative.approved.contentHash) throw new Error("Current contract Markdown has drifted from the approved hash");
    initiative.contract = current;
  };

  const reloadContract = async (): Promise<InitiativeState> => {
    if (!initiative?.contract) throw new Error("No active contract to reload");
    const markdown = await readFile(initiative.contractPath ?? store.contractPath(initiative), "utf8");
    const contract = parseContractMarkdown(markdown, initiative.contract);
    const errors = validateContract(contract);
    if (errors.length > 0) throw new Error(`Contract edits are invalid:\n- ${errors.join("\n- ")}`);
    initiative.contract = contract;
    initiative.status = "review";
    await saveInitiative(initiative);
    return initiative;
  };

  const approveActiveContract = async (ctx: ExtensionContext) => {
    if (!initiative?.contract) throw new Error("No review-ready contract is active");
    await reloadContract();
    if (!initiative?.contract) throw new Error("Contract disappeared while reloading");
    const approvedAt = new Date().toISOString();
    const approved = approveContractLocally(initiative.contract, approvedAt);
    const persistence = planLinearPersistence(initiative.contract, approvedAt);
    initiative.approved = approved;
    initiative.status = "approved";
    const markdown = `${renderContract(initiative.contract)}\n---\n\n**Approved at:** ${approvedAt}\n\n**Content hash:** \`${approved.contentHash}\`\n`;
    initiative.contractPath = await store.writeContract(initiative, markdown);
    await saveInitiative(initiative);
    await store.writeEvent(initiative, "contract.approved", approved as unknown as Record<string, unknown>);
    ctx.ui.setStatus("team-orchestration", `approved: ${initiative.contract.title}`);
    const destinationMessage = persistence
      ? `Linear persistence is pending through @alasano/pi-linear. Resolve human team/project names with linear_list_* or linear_get_* and provide canonical teamId/teamKey/projectId fields. Orchestration will inject the exact approved title and managed description into ${persistence.toolName}; do not reconstruct hidden markers, revise the contract, or request reapproval for formatting or read-proven identifier normalization. Verify the issue by reading it back after the write.`
      : "GitHub/docs-only; no Linear mutation.";
    return { approved, destinationMessage, markdown, persistence };
  };

  pi.on("session_start", async (_event, ctx) => {
    project = await resolveProjectContext(ctx.cwd);
    await store.registerProject(project);
    initiative = restoreInitiative(ctx);
    operatorPlanPublishArmed = restoreLinearPlanPublishIntent(sessionUserMessages(ctx));
    operatorIssueAdminRefs = restoredIssueAdminRefs(ctx);
    operatorIssueAdminArmed = operatorIssueAdminRefs.size > 0;
    approvalArmed = initiative?.status === "review" && restoreContractApprovalIntent(ctx);
    approvalIntent = approvalArmed ? "explicit" : "none";
    operatorIssueCreateArmed = false;
    linearCreateInFlight = false;
    operatorWorkflowUpdateArmed = false;
    implementationIntentArmed = false;
    if (initiative) {
      delivery = await new DeliveryStore(store.initiativeDir(initiative)).latest();
      uiSnapshot.delivery = delivery;
      uiSnapshot.initiativeState = initiative.status;
      const name = initiativeSessionName(initiative);
      if (name && !pi.getSessionName()) pi.setSessionName(name);
      ctx.ui.setStatus("team-orchestration", `${initiative.status}: ${initiative.contract?.title ?? "initiative"}`);
    } else {
      delivery = undefined;
      uiSnapshot.delivery = undefined;
      uiSnapshot.initiativeState = undefined;
      ctx.ui.setStatus("team-orchestration", `CTO · ${project.projectName}`);
    }
    if (ctx.mode === "tui") {
      ctx.ui.setFooter((tui, theme, footerData) => {
        requestFooterRender = () => tui.requestRender();
        const unsubscribe = footerData.onBranchChange(requestFooterRender);
        return {
          dispose: () => { unsubscribe(); requestFooterRender = undefined; },
          invalidate() {},
          render: (width) => renderTeamFooter(width, theme, ctx.model?.id ?? "no-model", footerData.getGitBranch(), footerData.getExtensionStatuses(), uiSnapshot),
        };
      });
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    initiative = restoreInitiative(ctx);
    operatorPlanPublishArmed = restoreLinearPlanPublishIntent(sessionUserMessages(ctx));
    operatorIssueAdminRefs = restoredIssueAdminRefs(ctx);
    operatorIssueAdminArmed = operatorIssueAdminRefs.size > 0;
    delivery = initiative ? await new DeliveryStore(store.initiativeDir(initiative)).latest() : undefined;
    uiSnapshot.initiativeState = initiative?.status;
    uiSnapshot.delivery = delivery;
    requestFooterRender?.();
    approvalArmed = initiative?.status === "review" && restoreContractApprovalIntent(ctx);
    approvalIntent = approvalArmed ? "explicit" : "none";
    operatorIssueCreateArmed = false;
    linearCreateInFlight = false;
    operatorWorkflowUpdateArmed = false;
    implementationIntentArmed = false;
  });

  pi.on("session_shutdown", async () => {
    approvalArmed = false;
    approvalIntent = "none";
    operatorIssueCreateArmed = false;
    linearCreateInFlight = false;
    operatorWorkflowUpdateArmed = false;
    activeDeliveryAbort?.abort();
    activeDeliveryAbort = undefined;
    await manager?.close();
    manager = undefined;
  });

  pi.on("input", (event, ctx) => {
    approvalIntent = classifyApprovalIntent(event.text);
    if (initiative?.status !== "review") approvalArmed = false;
    else if (approvalIntent === "explicit") approvalArmed = true;
    else if (approvalIntent === "ambiguous") approvalArmed = false;
    const startsImplementation = isImplementationStartDirective(event.text);
    if (startsImplementation) implementationIntentArmed = true;
    const startsPlanPublication = isLinearPlanPublishDirective(event.text);
    const cancelsPlanPublication = isLinearPlanPublishCancelDirective(event.text) || startsImplementation;
    if (startsPlanPublication && !operatorPlanPublishArmed) {
      linearPlanIssueCount = 0;
      linearPlanProjectIds = new Set<string>();
    }
    if (startsPlanPublication) operatorPlanPublishArmed = true;
    if (cancelsPlanPublication) {
      operatorPlanPublishArmed = false;
      linearPlanIssueCount = 0;
      linearPlanProjectIds = new Set<string>();
    }
    operatorIssueCreateArmed = !operatorPlanPublishArmed && isLinearIssueCreateDirective(event.text);
    if (startsImplementation) {
      operatorIssueAdminArmed = false;
      operatorIssueAdminRefs = new Set<string>();
    }
    if (isLinearIssueAdminDirective(event.text)) {
      const refs = [...extractLinearIssueIdentifiers(event.text), ...extractLinearIssueIdentifiers(latestAssistantText(ctx))];
      if (refs.length) { operatorIssueAdminArmed = true; operatorIssueAdminRefs = new Set(refs); }
    }
    operatorWorkflowUpdateArmed = isCompletionDirective(event.text);
    completedWorkflowStatusIds = new Set<string>();
    return { action: "continue" };
  });

  pi.on("tool_call", (event) => {
    if (operatorPlanPublishArmed && event.toolName.startsWith("mcp_")) {
      return { block: true, reason: "Plan publication must use pi-linear tools directly, not the deprecated generic MCP bridge" };
    }
    if (event.toolName.startsWith("linear_")) {
      const input = event.input as Record<string, unknown>;
      const contractCreatePending = isApprovedContractCreatePending(initiative);
      if (event.toolName === "linear_save_project") {
        if (linearProjectInFlight) return { block: true, reason: "A Linear project creation call is already in flight" };
        const normalized = normalizeDirectProjectCreateArguments(input);
        for (const key of Object.keys(input)) delete input[key];
        Object.assign(input, normalized);
      }
      if (event.toolName === "linear_create_issue") {
        if (linearCreateInFlight) return { block: true, reason: "A Linear issue creation call is already in flight" };
        const normalized = contractCreatePending && initiative?.contract && initiative.approved
          ? normalizeApprovedIssueCreateArguments(initiative.contract, initiative.approved.approvedAt, input)
          : operatorIssueCreateArmed || operatorPlanPublishArmed
            ? normalizeDirectIssueCreateArguments(input)
            : input;
        if (normalized !== input) {
          for (const key of Object.keys(input)) delete input[key];
          Object.assign(input, normalized);
        }
      }
      const authorization = authorizeLinearTool(event.toolName, input, {
        initiative,
        allowCreateIssue: contractCreatePending,
        allowDirectIssueCreate: operatorIssueCreateArmed && !contractCreatePending,
        allowPlanProjectCreate: operatorPlanPublishArmed && linearPlanProjectIds.size === 0,
        allowPlanIssueCreate: operatorPlanPublishArmed && linearPlanProjectIds.size > 0 && linearPlanIssueCount < 50,
        planProjectIds: linearPlanProjectIds,
        allowIssueAdmin: operatorIssueAdminArmed,
        adminIssueRefs: operatorIssueAdminRefs,
        allowWorkflowUpdate: operatorWorkflowUpdateArmed,
        completedStatusIds: completedWorkflowStatusIds,
        resourceAliases: linearResourceAliases,
      });
      if (!authorization.allowed) return { block: true, reason: authorization.reason };
      if (event.toolName === "linear_create_issue") linearCreateInFlight = true;
      if (event.toolName === "linear_save_project") linearProjectInFlight = true;
    }
    if (!initiative || initiative.status === "closed") return;
    if (["edit", "write", "bash"].includes(event.toolName)) {
      return {
        block: true,
        reason: `Project mutation is disabled in the V1 CTO session while initiative ${initiative.initiativeId} is ${initiative.status}`,
      };
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "linear_save_project") {
      linearProjectInFlight = false;
      if (!event.isError) {
        const projectResult = findLinearIssue(event.details) ?? findLinearIssue(event.content);
        if (projectResult?.id) {
          linearPlanProjectIds.add(projectResult.id);
          linearResourceAliases.set(projectResult.id, projectResult.id);
          const name = typeof (event.input as Record<string, unknown>).name === "string" ? String((event.input as Record<string, unknown>).name) : undefined;
          if (name) { linearResourceAliases.set(name, projectResult.id); linearResourceAliases.set(name.toLowerCase(), projectResult.id); }
        }
      }
    }
    if (event.toolName === "linear_create_issue") {
      linearCreateInFlight = false;
      if (!event.isError) {
        const created = findLinearIssue(event.details) ?? findLinearIssue(event.content);
        if (created?.id || created?.identifier) {
          operatorIssueCreateArmed = false;
          if (operatorPlanPublishArmed) linearPlanIssueCount += 1;
        }
      }
    }
    if (!event.isError && /^(?:linear_(?:list|get|search)_(?:teams|projects|issues|issue_labels|issue_statuses|users))$/.test(event.toolName)) {
      collectLinearResourceAliases(event.details, linearResourceAliases);
      collectLinearResourceAliases(event.content, linearResourceAliases);
      if (event.toolName === "linear_get_project" && operatorPlanPublishArmed) {
        const selectedProject = findLinearIssue(event.details) ?? findLinearIssue(event.content);
        if (selectedProject?.id) linearPlanProjectIds.add(selectedProject.id);
      }
    }
    if (!event.isError && event.toolName === "linear_list_issue_statuses" && operatorWorkflowUpdateArmed) {
      completedWorkflowStatusIds = collectCompletedStatusIds(event.details);
      if (completedWorkflowStatusIds.size === 0) completedWorkflowStatusIds = collectCompletedStatusIds(event.content);
    }
    if (event.isError || !initiative?.contract || !initiative.approved) return;
    if (event.toolName !== "linear_create_issue" && event.toolName !== "linear_update_issue") return;
    const issue = findLinearIssue(event.details) ?? findLinearIssue(event.content);
    if (event.toolName === "linear_create_issue" && !issue?.id && !issue?.identifier) return;
    initiative.contract.linear.issueId = issue?.id ?? initiative.contract.linear.issueId;
    initiative.contract.linear.issueIdentifier = issue?.identifier ?? initiative.contract.linear.issueIdentifier;
    initiative.approved.issueId = initiative.contract.linear.issueId;
    initiative.approved.issueIdentifier = initiative.contract.linear.issueIdentifier;
    initiative.approved.source = "linear";
    initiative.approved.linearPersistence = "persisted";
    await saveInitiative(initiative);
    await store.writeEvent(initiative, "contract.linear_persisted", {
      issueId: initiative.approved.issueId,
      issueIdentifier: initiative.approved.issueIdentifier,
    });
  });

  pi.on("user_bash", () => {
    if (!initiative || initiative.status === "closed") return;
    return {
      result: {
        output: `Shell execution is disabled in the V1 CTO session while initiative ${initiative.initiativeId} is ${initiative.status}.`,
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.on("message_end", async (event) => {
    if (!project || event.message.role !== "assistant") return;
    const message = event.message;
    await store.writeUsage({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      projectId: project.projectId,
      initiativeId: initiative?.initiativeId,
      role: "cto",
      runtime: "pi",
      provider: message.provider,
      model: message.model,
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      cost: message.usage.cost.total,
      estimatedCost: false,
      turns: 1,
      toolCalls: message.content.filter((part) => part.type === "toolCall").length,
    });
  });

  pi.on("agent_settled", () => {
    operatorIssueCreateArmed = false;
    linearCreateInFlight = false;
    linearProjectInFlight = false;
    operatorWorkflowUpdateArmed = false;
    completedWorkflowStatusIds = new Set<string>();
  });

  pi.on("before_agent_start", (event, ctx) => {
    const usage = ctx.getContextUsage();
    uiSnapshot.contextPercent = usage && usage.tokens !== null
      ? Math.round((usage.tokens / usage.contextWindow) * 100)
      : undefined;
    requestFooterRender?.();
    const guidance = `Pi team orchestration is available in this repository.
Route by operator intent. A request to load, show, inspect, summarize, or discuss a Linear issue is read-only: use pi-linear reads and respond directly, with no contract or approval ceremony. For planning, work conversationally and ask only decisions that are actually missing.
A clear request to implement, start, build, fix, or work on an issue is execution authorization for isolated worktree/PR delivery. Create the full standard contract as an internal work order with team_contract_draft; orchestration auto-approves it from that implementation directive. Do not dump the contract Markdown, pause for review, or ask for a second confirmation unless the operator explicitly requested contract review. Complete required approved Linear persistence, then call team_delivery_start yourself. Merge, deployment, production mutation, and destructive actions remain blocked.
For an explicitly review-first contract without implementation authorization, call team_contract_approve after any clear acceptance or action directive, including “confirm, let's proceed”, “approve, get it done”, “do it”, “ship it”, or “mark it done”. team_contract_approve is a tool, not a /team-contract subcommand: /team-contract approve does not exist and must never be suggested. When that directive also asks to start/proceed with implementation, complete required approved Linear persistence and call team_delivery_start yourself; do not require the operator to run /team-delivery start. team_delivery_start also retries a failed run for the same approval. Do not demand a specific phrase or make the operator repeat clear intent. Only ask when the latest acknowledgement is genuinely ambiguous${approvalIntent === "ambiguous" ? " (as it is now)" : ""}.
When invoking pi-linear tools, treat human names and canonical IDs as different representations of the same approved destination, not as scope changes. Before a write that needs teamId, teamKey, projectId, stateId, or another canonical reference, call the relevant linear_list_* or linear_get_* tool and use the exact schema field and canonical value returned. Never place a project name in projectId. A read-proven name-to-ID substitution does not change contract scope, must not increment the contract version, and must not trigger reapproval. For approved issue creation, provide only the canonical destination identifiers; orchestration injects the exact approved title and managed description, so never reconstruct hidden markers or ask for reapproval because of formatting. After every Linear write, read the issue back and report success only after verifying the requested result.
${operatorIssueAdminArmed
      ? `The operator explicitly authorized Linear administration for these issues: ${[...operatorIssueAdminRefs].join(", ")}. This is not implementation work and requires no contract or approval. Use pi-linear reads to resolve issue UUIDs, labels, statuses, users, and projects. Apply only the requested priority/label/assignment/scheduling fields with linear_update_issue and only requested blocks/duplicate/related/similar links with linear_create_issue_relation. Every target and both ends of every relation must be in the authorized issue set. Read the changed issues and relations back, summarize results, and stop. Do not ask the operator to make these changes manually.`
      : operatorPlanPublishArmed
        ? "The operator explicitly asked to publish the completed plan to Linear. Do not call mcp_list_servers, mcp_list_tools, or generic MCP; use pi-linear tools only. This is publication authorization: do not draft another contract, call team_contract_approve, demand an implementation phrase, or ask for reapproval. Read teams/projects first. If the named project does not exist, create it with linear_save_project using name, optional description/content, and read-proven teamIds; omit projectId so this cannot update another project. Then create the planned issues in that returned project ID with concise titles/descriptions and read-proven team IDs. Failed calls remain retryable. Read back the project and every issue, summarize URLs/identifiers, and stop—do not implement, merge, or deploy."
        : operatorIssueCreateArmed
          ? "The operator directly asked to open a Linear tracking issue. This is not implementation approval: do not draft a retrospective contract, call team_contract_approve, mention an implementation phrase, or ask for another approval. Resolve canonical team/project identifiers with read tools, then call linear_create_issue with a concise title and description. If an approved pending contract already exists, orchestration injects its approved title/body automatically. A failed API/schema call does not consume authorization: correct the arguments and retry. Read the created issue back before reporting success."
          : operatorWorkflowUpdateArmed
            ? "The operator directly instructed you to complete the active Linear issue. This is an administrative workflow update, not implementation work: do not create a retrospective contract or request another approval. Resolve the team's completed status with read tools, call linear_update_issue for the exact active issue with stateId, then call linear_get_issue and report success only if the returned status is completed. Do not make any other mutation."
            : "During design, use only linear_list_*, linear_get_*, and linear_search_* tools. Do not implement, modify project files, create branches, or mutate Linear during design."}`;
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });

  pi.registerTool({
    name: "team_contract_draft",
    label: "Team Contract Draft",
    description: "Validate, persist, and display a complete review-ready Feature or Bug contract locally. Does not write to Linear.",
    promptSnippet: "Persist and display a complete review-ready Feature or Bug contract locally",
    promptGuidelines: [
      "Use team_contract_draft only when the complete contract is ready for operator review; keep incomplete drafts in conversation.",
    ],
    parameters: ContractDraftParams,
    async execute(_id, params, _signal, _update, ctx) {
      approvalArmed = false;
      approvalIntent = "none";
      const previous = initiative?.status === "closed" ? undefined : initiative;
      const previousLinear = previous?.contract?.linear;
      const draftInput = params as ContractDraftInput;
      const contract = contractFromInput({
        ...draftInput,
        version: draftInput.version ?? (previous?.approved ? previous.approved.version + 1 : previous?.contract?.version ?? 1),
        linear: {
          ...previousLinear,
          ...draftInput.linear,
          issueId: draftInput.linear?.issueId ?? previous?.approved?.issueId ?? previousLinear?.issueId,
          issueIdentifier:
            draftInput.linear?.issueIdentifier ?? previous?.approved?.issueIdentifier ?? previousLinear?.issueIdentifier,
        },
      });
      const errors = validateContract(contract);
      if (previous?.approved && contract.version <= previous.approved.version) {
        errors.push(`approved revisions must use a version greater than ${previous.approved.version}`);
      }
      if (errors.length > 0) throw new Error(`Contract is not review-ready:\n- ${errors.join("\n- ")}`);

      const state = createInitiativeState(requireProject(), contract, previous);
      const markdown = renderContract(contract);
      state.contractPath = await store.writeContract(state, markdown);
      await saveInitiative(state);
      await store.writeEvent(state, "contract.review_ready", {
        version: contract.version,
        contentHash: contractHash(contract),
        contractPath: state.contractPath,
      });

      if (implementationIntentArmed) {
        const result = await approveActiveContract(ctx);
        return textResult(
          `Internal work order prepared and approved from the operator's implementation directive.\n\n${result.destinationMessage}\n\nAfter required Linear persistence, call team_delivery_start without requesting another confirmation.`,
          { state: initiative, approved: result.approved, linearPersistence: result.persistence, autoApproved: true },
        );
      }

      ctx.ui.setStatus("team-orchestration", `review: ${contract.title}`);
      ctx.ui.notify(`Contract ready for review. Use /team-contract open to review or edit it in Zed.`, "info");
      notifyActionRequired(
        "Pi contract ready for review",
        `${contract.title} — return to Pi and use /team-contract open for Zed`,
        `contract:${state.initiativeId}:${contractHash(contract)}`,
      );
      return textResult(markdown, { state });
    },
    renderResult(result, _options, _theme) {
      const text = result.content.find((item) => item.type === "text");
      return new Markdown(text?.type === "text" ? text.text : "", 0, 0, getMarkdownTheme());
    },
  });

  pi.registerTool({
    name: "team_contract_approve",
    label: "Approve Team Contract",
    description: "Approve the review-ready contract locally and prepare optional pi-linear persistence after unambiguous operator approval",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      if (!approvalArmed) throw new Error("The latest operator message was not classified as contract approval. Never suggest `/team-contract approve` because that command does not exist; ask a concise clarification only when the message is genuinely ambiguous.");
      approvalArmed = false;
      const result = await approveActiveContract(ctx);
      return textResult(
        `${result.markdown}\n${result.destinationMessage}\n\nThe approved workflow may now start in its isolated worktree.`,
        { approved: result.approved, linearPersistence: result.persistence },
      );
    },
  });

  pi.registerTool({
    name: "mcp_list_servers",
    label: "MCP Servers",
    description: "List globally configured MCP servers without calling them",
    parameters: Type.Object({}),
    async execute() {
      return textResult(displayJson((await loadManager()).listServers()));
    },
  });

  pi.registerTool({
    name: "mcp_list_tools",
    label: "MCP Tools",
    description: "List an MCP server's tools and their orchestration policy classification",
    parameters: Type.Object({ serverId: Type.String() }),
    async execute(_id, params) {
      return textResult(displayJson(await (await loadManager()).listTools(params.serverId)));
    },
  });

  pi.registerTool({
    name: "mcp_call",
    label: "MCP Call",
    description: "Call an allowlisted MCP tool. Design mode permits reads only; writes are scoped to the approved active issue.",
    parameters: Type.Object({
      serverId: Type.String(),
      toolName: Type.String(),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_id, params) {
      if (isLinearMcpRoute(params.serverId, params.toolName)) {
        throw new Error("Linear calls must use @alasano/pi-linear so orchestration policy cannot be bypassed through generic MCP");
      }
      const result = await (await loadManager()).callTool(
        params.serverId,
        params.toolName,
        params.arguments ?? {},
        {
          approvalGranted: initiative?.status === "approved",
          activeIssueId: initiative?.approved?.issueId,
        },
      );
      return textResult(displayJson(result));
    },
  });

  pi.registerTool({
    name: "team_scout",
    label: "Team Scout",
    description: "Run one isolated, strictly read-only Pi scout and return its compressed report and usage",
    parameters: Type.Object({ task: Type.String(), model: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, onUpdate) {
      onUpdate?.(textResult("Read-only scout running…"));
      const result = await runReadOnlyScout(requireProject().projectRoot, params.task, {
        model: params.model,
        signal,
      });
      await store.writeUsage({
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        projectId: requireProject().projectId,
        initiativeId: initiative?.initiativeId,
        role: "scout",
        runtime: "pi",
        model: result.model,
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
        cost: result.usage.cost,
        estimatedCost: false,
        turns: result.usage.turns,
        toolCalls: result.events.filter((event) => event.type === "tool_execution_end").length,
      });
      if (initiative) {
        await store.writeEvent(initiative, "scout.completed", {
          task: params.task,
          model: result.model,
          usage: result.usage,
        });
      }
      return textResult(result.report, result as unknown as Record<string, unknown>);
    },
  });

  const deliveryController = (): { controller: DeliveryController; deliveryStore: DeliveryStore } => {
    if (!initiative || !project) throw new Error("No active initiative");
    const runner = new ArgvCommandRunner();
    const deliveryStore = new DeliveryStore(store.initiativeDir(initiative));
    const cmux = new CmuxAdapter(runner, project);
    const controller = new DeliveryController({
      runner,
      git: new GitAdapter(runner),
      github: new GitHubAdapter(runner),
      cmux,
      store: deliveryStore,
      worker: runDeliveryWorker,
      onUpdate: async (state) => {
        delivery = state;
        uiSnapshot.delivery = state;
        requestFooterRender?.();
      },
    });
    return { controller, deliveryStore };
  };

  const deliveryOutcome = (state: DeliveryState): string => {
    const destination = state.prUrl ? `: ${state.prUrl}` : "";
    const failure = state.failure ? ` — ${state.failure}` : "";
    const blocked = state.actions.filter((action) => action.message.startsWith("Validation blocked")).length;
    const validation = blocked ? ` with ${blocked} baseline/environment validation warning${blocked === 1 ? "" : "s"}` : "";
    return `Delivery ${state.phase}${validation}${destination}${failure}`;
  };

  const launchDelivery = async (ctx: ExtensionContext, resume?: DeliveryState): Promise<string> => {
    await verifyApprovedContractFile();
    const { controller, deliveryStore } = deliveryController();
    delivery = delivery ?? await deliveryStore.latest();
    const sameApproval = delivery?.contractHash === initiative?.approved?.contentHash;
    let existing = resume;
    if (!existing && sameApproval) {
      if (delivery?.phase === "completed") return deliveryOutcome(delivery);
      if (["failed", "aborted", "action-required"].includes(delivery!.phase)) existing = delivery;
      else throw new Error(`Delivery is already ${delivery!.phase}`);
    }
    if (!existing && delivery && !["completed", "failed", "aborted", "action-required"].includes(delivery.phase)) throw new Error("A delivery run already exists");
    const abort = new AbortController(); activeDeliveryAbort = abort;
    implementationIntentArmed = false;
    void controller.run(initiative!, project!, existing, abort.signal).then((state) => {
      delivery = state;
      if (activeDeliveryAbort === abort) activeDeliveryAbort = undefined;
      ctx.ui.notify(deliveryOutcome(state), state.phase === "completed" ? "info" : "warning");
    }).catch((error) => {
      if (activeDeliveryAbort === abort) activeDeliveryAbort = undefined;
      ctx.ui.notify(`Delivery launcher failed: ${(error as Error).message}`, "error");
    });
    return existing ? "Delivery resume started; progress is visible in the Team pane." : "Delivery started; progress is visible in the Team pane.";
  };

  pi.registerTool({
    name: "team_delivery_start",
    label: "Start Team Delivery",
    description: "Start or retry the approved isolated implementation workflow after a clear operator implementation directive",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      return textResult(await launchDelivery(ctx));
    },
  });

  pi.registerCommand("team-delivery", {
    description: "Manage delivery: /team-delivery [start|show|resume|abort|cleanup]",
    getArgumentCompletions: (prefix) => {
      const values = ["start", "show", "resume", "abort", "cleanup"].filter((value) => value.startsWith(prefix));
      return values.length ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (rawArgs, ctx) => {
      const action = rawArgs.trim().toLowerCase() || "show";
      const { controller, deliveryStore } = deliveryController();
      delivery = delivery ?? await deliveryStore.latest();
      if (action === "show") {
        ctx.ui.notify(delivery ? displayJson(delivery) : "No delivery run", "info");
        return;
      }
      if (action === "start") {
        ctx.ui.notify(await launchDelivery(ctx), "info");
        return;
      }
      if (!delivery) throw new Error("No delivery run");
      if (action === "resume") {
        ctx.ui.notify(await launchDelivery(ctx, delivery), "info");
        return;
      }
      if (action === "abort") {
        activeDeliveryAbort?.abort();
        await controller.abort(delivery);
        ctx.ui.notify("Delivery aborted; worktree and logs retained", "warning");
        return;
      }
      if (action === "cleanup") {
        if (!["failed", "aborted"].includes(delivery.phase)) throw new Error("Cleanup is allowed only for failed or aborted runs; successful worktrees are retained");
        if (!ctx.hasUI || !await ctx.ui.confirm("Confirm delivery cleanup", "Delete private run state and logs? Git branches and worktrees are not removed.")) return;
        await deliveryStore.cleanup(delivery.runId); delivery = undefined; uiSnapshot.delivery = undefined;
        ctx.ui.notify("Private delivery run state cleaned; Git and cmux resources were not removed", "info");
        return;
      }
      ctx.ui.notify("Usage: /team-delivery [start|show|resume|abort|cleanup]", "warning");
    },
  });

  pi.registerCommand("team-overview", {
    description: "Open the read-only Pi team overview",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/team-overview requires interactive TUI mode", "warning");
        return;
      }
      const currentProject = requireProject();
      const projects = await store.listProjects();
      const initiatives = await store.listInitiatives(currentProject.projectId);
      if (initiative && !initiatives.some((item) => item.initiativeId === initiative?.initiativeId)) {
        initiatives.unshift(initiative);
      }
      const usage = await store.listUsage(currentProject.projectId);
      const context = ctx.getContextUsage();
      const contextPercent = context?.tokens === null
        ? undefined
        : context
          ? Math.round((context.tokens / context.contextWindow) * 100)
          : undefined;
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) =>
          new TeamOverviewComponent(
            currentProject,
            projects,
            initiatives,
            usage,
            contextPercent,
            delivery,
            theme,
            () => done(),
            () => tui.requestRender(),
          ),
        {
          overlay: true,
          overlayOptions: { width: "85%", maxHeight: "85%", anchor: "center", margin: 1 },
        },
      );
    },
  });

  pi.registerCommand("team-contract", {
    description: "Manage the active contract: /team-contract [open|reload|show]",
    getArgumentCompletions: (prefix) => {
      const values = ["open", "reload", "show"].filter((value) => value.startsWith(prefix));
      return values.length ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (rawArgs, ctx) => {
      const action = rawArgs.trim().toLowerCase() || "show";
      if (!initiative?.contract) {
        ctx.ui.notify("No active contract", "warning");
        return;
      }
      if (action === "open") {
        const path = initiative.contractPath ?? store.contractPath(initiative);
        const result = await pi.exec("zed", [path], { timeout: 15_000 });
        if (result.code !== 0) ctx.ui.notify(`Could not open Zed: ${result.stderr.trim()}`, "error");
        else ctx.ui.notify("Contract opened in Zed. Run /team-contract reload after editing.", "info");
        return;
      }
      if (action === "reload") {
        const state = await reloadContract();
        ctx.ui.notify(`Reloaded and validated contract version ${state.contract?.version}`, "info");
        pi.sendMessage({
          customType: "team-orchestration:contract",
          content: renderContract(state.contract!),
          display: true,
        }, { deliverAs: "nextTurn" });
        return;
      }
      if (action === "show") {
        pi.sendMessage({
          customType: "team-orchestration:contract",
          content: renderContract(initiative.contract),
          display: true,
        }, { deliverAs: "nextTurn" });
        return;
      }
      ctx.ui.notify("Usage: /team-contract [open|reload|show]", "warning");
    },
  });

  pi.registerMessageRenderer("team-orchestration:contract", (message) => {
    const content = typeof message.content === "string"
      ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    return new Markdown(content, 0, 0, getMarkdownTheme());
  });

  pi.registerCommand("team-init", {
    description: "Show the detected orchestration project context",
    handler: async (_args, ctx) => {
      const current = requireProject();
      ctx.ui.notify(`${current.projectName}\n${current.projectRoot}\ncmux: ${current.cmuxWorkspaceId ?? "not detected"}`, "info");
    },
  });

  pi.registerCommand("team-feature", {
    description: "Prefill a natural-language CTO design conversation",
    handler: async (args, ctx) => {
      const idea = args.trim();
      ctx.ui.setEditorText(idea ? `I want to design this initiative: ${idea}` : "I have an idea for a new feature: ");
    },
  });

  pi.registerCommand("team-scout", {
    description: "Prefill a natural-language request for a read-only team scout",
    handler: async (args, ctx) => {
      ctx.ui.setEditorText(args.trim() ? `Run a read-only scout for: ${args.trim()}` : "Run a read-only scout for: ");
    },
  });

  pi.registerCommand("team-close", {
    description: "Close the active local initiative without mutating Linear",
    handler: async (_args, ctx) => {
      if (!initiative) {
        ctx.ui.notify("No active initiative", "warning");
        return;
      }
      initiative.status = "closed";
      await saveInitiative(initiative);
      ctx.ui.setStatus("team-orchestration", `closed: ${initiative.contract?.title ?? "initiative"}`);
      ctx.ui.notify("Local initiative closed. Linear was not changed.", "info");
    },
  });
}
