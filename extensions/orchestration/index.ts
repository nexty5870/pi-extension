import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { classifyApprovalIntent, type ApprovalIntent } from "./approval.ts";
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
import { authorizeLinearTool, isLinearMcpRoute } from "./linear-policy.ts";
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
import { approveContractLocally, planLinearPersistence } from "./persistence.ts";
import type { InitiativeState, ProjectContext } from "./types.ts";

const APPROVAL_EXAMPLE = "Approve contract and start implementation";
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
  let linearCreateArmed = false;

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
    const name = initiativeSessionName(state);
    if (name && pi.getSessionName() !== name) pi.setSessionName(name);
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
    linearCreateArmed = false;
    if (initiative) {
      const name = initiativeSessionName(initiative);
      if (name && !pi.getSessionName()) pi.setSessionName(name);
      ctx.ui.setStatus("team-orchestration", `${initiative.status}: ${initiative.contract?.title ?? "initiative"}`);
    } else {
      ctx.ui.setStatus("team-orchestration", `CTO · ${project.projectName}`);
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    initiative = restoreInitiative(ctx);
    approvalArmed = false;
    approvalIntent = "none";
    linearCreateArmed = false;
  });

  pi.on("session_shutdown", async () => {
    approvalArmed = false;
    approvalIntent = "none";
    linearCreateArmed = false;
    await manager?.close();
    manager = undefined;
  });

  pi.on("input", (event) => {
    approvalIntent = classifyApprovalIntent(event.text);
    approvalArmed = approvalIntent === "explicit" && initiative?.status === "review";
    return { action: "continue" };
  });

  pi.on("tool_call", (event) => {
    if (event.toolName.startsWith("linear_")) {
      const authorization = authorizeLinearTool(event.toolName, event.input as Record<string, unknown>, {
        initiative,
        allowCreateIssue: linearCreateArmed,
      });
      if (!authorization.allowed) return { block: true, reason: authorization.reason };
      if (event.toolName === "linear_create_issue") linearCreateArmed = false;
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
  });

  pi.on("before_agent_start", (event, ctx) => {
    const usage = ctx.getContextUsage();
    if (usage && usage.tokens !== null) {
      ctx.ui.setStatus(
        "team-context",
        `context ${Math.round((usage.tokens / usage.contextWindow) * 100)}%`,
      );
    }
    const guidance = `Pi team orchestration is available in this repository.
For a new feature or bug, work conversationally and ask one decision question at a time. Keep drafts local.
When the contract is complete, call team_contract_draft with the full standard contract. Its complete Markdown must be shown to the operator.
Call team_contract_approve only after unambiguous implementation approval such as “${APPROVAL_EXAMPLE}”. Case and punctuation do not matter. If the latest acknowledgement is ambiguous${approvalIntent === "ambiguous" ? " (as it is now)" : ""}, ask the operator to confirm implementation approval.
During design, use only linear_list_*, linear_get_*, and linear_search_* tools. Do not implement, modify project files, create branches, or mutate Linear during design.`;
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
      if (!approvalArmed) throw new Error(`Approval is not confirmed. Ask the operator to clearly approve implementation (for example: ${APPROVAL_EXAMPLE}).`);
      approvalArmed = false;
      if (!initiative?.contract) throw new Error("No review-ready contract is active");
      await reloadContract();
      if (!initiative?.contract) throw new Error("Contract disappeared while reloading");

      const approvedAt = new Date().toISOString();
      const approved = approveContractLocally(initiative.contract, approvedAt);
      const persistence = planLinearPersistence(initiative.contract, approvedAt);
      initiative.approved = approved;
      initiative.status = "approved";
      linearCreateArmed = persistence?.toolName === "linear_create_issue";
      const markdown = `${renderContract(initiative.contract)}\n---\n\n**Approved at:** ${approvedAt}\n\n**Content hash:** \`${approved.contentHash}\`\n`;
      initiative.contractPath = await store.writeContract(initiative, markdown);
      await saveInitiative(initiative);
      await store.writeEvent(initiative, "contract.approved", approved as unknown as Record<string, unknown>);
      ctx.ui.setStatus("team-orchestration", `approved: ${initiative.contract.title}`);
      const destinationMessage = persistence
        ? `Linear persistence is pending through @alasano/pi-linear. Call ${persistence.toolName} with exactly the provided arguments.`
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
