import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { classifyApprovalIntent, isCompletionDirective, isLinearIssueCreateDirective, type ApprovalIntent } from "./approval.ts";
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
import { approveContractLocally, isApprovedContractCreatePending, normalizeApprovedIssueCreateArguments, normalizeDirectIssueCreateArguments, planLinearPersistence } from "./persistence.ts";
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
  let operatorIssueCreateArmed = false;
  let linearCreateInFlight = false;
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

  pi.on("session_start", async (_event, ctx) => {
    project = await resolveProjectContext(ctx.cwd);
    await store.registerProject(project);
    initiative = restoreInitiative(ctx);
    approvalArmed = false;
    approvalIntent = "none";
    operatorIssueCreateArmed = false;
    linearCreateInFlight = false;
    operatorWorkflowUpdateArmed = false;
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
    delivery = initiative ? await new DeliveryStore(store.initiativeDir(initiative)).latest() : undefined;
    uiSnapshot.initiativeState = initiative?.status;
    uiSnapshot.delivery = delivery;
    requestFooterRender?.();
    approvalArmed = false;
    approvalIntent = "none";
    operatorIssueCreateArmed = false;
    linearCreateInFlight = false;
    operatorWorkflowUpdateArmed = false;
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

  pi.on("input", (event) => {
    approvalIntent = classifyApprovalIntent(event.text);
    approvalArmed = approvalIntent === "explicit" && initiative?.status === "review";
    operatorIssueCreateArmed = isLinearIssueCreateDirective(event.text);
    operatorWorkflowUpdateArmed = isCompletionDirective(event.text);
    completedWorkflowStatusIds = new Set<string>();
    return { action: "continue" };
  });

  pi.on("tool_call", (event) => {
    if (event.toolName.startsWith("linear_")) {
      const input = event.input as Record<string, unknown>;
      const contractCreatePending = isApprovedContractCreatePending(initiative);
      if (event.toolName === "linear_create_issue") {
        if (linearCreateInFlight) return { block: true, reason: "A Linear issue creation call is already in flight" };
        const normalized = contractCreatePending && initiative?.contract && initiative.approved
          ? normalizeApprovedIssueCreateArguments(initiative.contract, initiative.approved.approvedAt, input)
          : operatorIssueCreateArmed
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
        allowWorkflowUpdate: operatorWorkflowUpdateArmed,
        completedStatusIds: completedWorkflowStatusIds,
        resourceAliases: linearResourceAliases,
      });
      if (!authorization.allowed) return { block: true, reason: authorization.reason };
      if (event.toolName === "linear_create_issue") linearCreateInFlight = true;
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
    if (event.toolName === "linear_create_issue") {
      linearCreateInFlight = false;
      if (!event.isError) {
        const created = findLinearIssue(event.details) ?? findLinearIssue(event.content);
        if (created?.id || created?.identifier) operatorIssueCreateArmed = false;
      }
    }
    if (!event.isError && /^(?:linear_(?:list|get)_(?:teams|projects))$/.test(event.toolName)) {
      collectLinearResourceAliases(event.details, linearResourceAliases);
      collectLinearResourceAliases(event.content, linearResourceAliases);
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
    approvalArmed = false;
    approvalIntent = "none";
    operatorIssueCreateArmed = false;
    linearCreateInFlight = false;
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
For a new feature or bug, work conversationally and ask one decision question at a time. Keep drafts local.
When the contract is complete, call team_contract_draft with the full standard contract. Its complete Markdown must be shown to the operator.
Call team_contract_approve after any clear acceptance or action directive, including “approve, get it done”, “do it”, “ship it”, or “mark it done”. Do not demand a specific phrase or make the operator repeat clear intent. Only ask when the latest acknowledgement is genuinely ambiguous${approvalIntent === "ambiguous" ? " (as it is now)" : ""}.
When invoking pi-linear tools, treat human names and canonical IDs as different representations of the same approved destination, not as scope changes. Before a write that needs teamId, teamKey, projectId, stateId, or another canonical reference, call the relevant linear_list_* or linear_get_* tool and use the exact schema field and canonical value returned. Never place a project name in projectId. A read-proven name-to-ID substitution does not change contract scope, must not increment the contract version, and must not trigger reapproval. For approved issue creation, provide only the canonical destination identifiers; orchestration injects the exact approved title and managed description, so never reconstruct hidden markers or ask for reapproval because of formatting. After every Linear write, read the issue back and report success only after verifying the requested result.
${operatorIssueCreateArmed
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
      if (!approvalArmed) throw new Error("Approval is not confirmed. Accept any clear operator directive; ask only when intent is genuinely ambiguous.");
      approvalArmed = false;
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
      return textResult(
        `${markdown}\n${destinationMessage}\n\nV1 stops before code mutation.`,
        { approved, linearPersistence: persistence },
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
        await verifyApprovedContractFile();
        if (delivery?.contractHash === initiative?.approved?.contentHash) throw new Error("This approval already has a delivery run; use /team-delivery resume");
        if (delivery && !["completed", "failed", "aborted"].includes(delivery.phase)) throw new Error("A delivery run already exists");
        const abort = new AbortController(); activeDeliveryAbort = abort;
        void controller.run(initiative!, project!, undefined, abort.signal).then((state) => {
          delivery = state; if (activeDeliveryAbort === abort) activeDeliveryAbort = undefined;
          ctx.ui.notify(`Delivery ${state.phase}${state.prUrl ? `: ${state.prUrl}` : ""}`, state.phase === "completed" ? "info" : "warning");
        }).catch((error) => { if (activeDeliveryAbort === abort) activeDeliveryAbort = undefined; ctx.ui.notify(`Delivery could not start: ${(error as Error).message}`, "error"); });
        ctx.ui.notify("Delivery started; use /team-delivery show or abort", "info");
        return;
      }
      if (!delivery) throw new Error("No delivery run");
      if (action === "resume") {
        const abort = new AbortController(); activeDeliveryAbort = abort;
        void controller.run(initiative!, project!, delivery, abort.signal).then((state) => {
          delivery = state; if (activeDeliveryAbort === abort) activeDeliveryAbort = undefined;
          ctx.ui.notify(`Delivery ${state.phase}`, state.phase === "completed" ? "info" : "warning");
        }).catch((error) => { if (activeDeliveryAbort === abort) activeDeliveryAbort = undefined; ctx.ui.notify(`Delivery could not resume: ${(error as Error).message}`, "error"); });
        ctx.ui.notify("Delivery resume started", "info");
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
