import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { InitiativeState, ProjectContext, UsageRecord } from "../types.ts";
import { aggregateUsage, formatTokenCount } from "../usage.ts";
import type { DeliveryState } from "../delivery/types.ts";
import { workerLines } from "../delivery/ui.ts";

const VIEWS = ["Projects", "Initiatives", "Workers", "Usage", "Action inbox"] as const;
type ViewIndex = 0 | 1 | 2 | 3 | 4;

export class TeamOverviewComponent {
  private view: ViewIndex = 0;
  private scroll = 0;
  private readonly refreshTimer: NodeJS.Timeout;

  constructor(
    private readonly project: ProjectContext,
    private readonly projects: Array<ProjectContext & { updatedAt: string }>,
    private readonly initiatives: InitiativeState[],
    private readonly usage: UsageRecord[],
    private readonly contextPercent: number | undefined,
    private readonly delivery: DeliveryState | undefined,
    private readonly theme: Theme,
    private readonly close: () => void,
    private readonly requestRender: () => void,
  ) {
    this.refreshTimer = setInterval(requestRender, 1_000);
    this.refreshTimer.unref();
  }

  dispose(): void { clearInterval(this.refreshTimer); }

  handleInput(data: string): void {
    if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.close();
      return;
    }
    const numeric = Number.parseInt(data, 10);
    if (numeric >= 1 && numeric <= 5) this.view = (numeric - 1) as ViewIndex;
    else if (matchesKey(data, Key.tab)) this.view = ((this.view + 1) % VIEWS.length) as ViewIndex;
    else if (matchesKey(data, Key.shift("tab"))) {
      this.view = ((this.view + VIEWS.length - 1) % VIEWS.length) as ViewIndex;
    } else if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, Key.down)) this.scroll += 1;
    else return;
    this.requestRender();
  }

  private navigation(): string {
    return VIEWS.map((view, index) => {
      const label = `${index + 1}:${view}`;
      return index === this.view ? this.theme.fg("accent", this.theme.bold(`[${label}]`)) : this.theme.fg("dim", label);
    }).join("  ");
  }

  private projectLines(): string[] {
    const t = this.theme;
    const active = this.initiatives.filter((item) => item.status !== "closed").length;
    const current = [
      `${t.fg("accent", "●")} ${this.project.projectName} ${t.fg("dim", `(${active} active initiatives, context ${this.contextPercent === undefined ? "?" : `${this.contextPercent}%`})`)}`,
      `  ${t.fg("dim", this.project.projectRoot)}`,
      `  ${t.fg("muted", "cmux")} ${this.project.cmuxWorkspaceId ?? "not detected"}`,
    ];
    const others = this.projects
      .filter((item) => item.projectId !== this.project.projectId)
      .map((item) => `${t.fg("muted", "○")} ${item.projectName} ${t.fg("dim", item.projectRoot)}`);
    return [t.fg("accent", t.bold("Projects")), ...current, ...others];
  }

  private initiativeLines(): string[] {
    const t = this.theme;
    if (this.initiatives.length === 0) return [t.fg("dim", "No local initiatives for this project.")];
    return [
      t.fg("accent", t.bold("Initiatives")),
      ...this.initiatives.map((item) => {
        const title = item.contract?.title ?? item.initiativeId;
        const linear = item.approved?.issueIdentifier ?? item.contract?.linear.issueIdentifier ?? "local";
        return `${t.fg(item.status === "review" ? "warning" : item.status === "approved" ? "success" : "muted", item.status.padEnd(8))} ${title} ${t.fg("dim", `(${linear})`)}`;
      }),
    ];
  }

  private usageLines(): string[] {
    const t = this.theme;
    const total = aggregateUsage(this.usage);
    const prefix = total.estimatedCost ? "~" : "";
    const byRole = new Map<string, UsageRecord[]>();
    for (const record of this.usage) byRole.set(record.role, [...(byRole.get(record.role) ?? []), record]);
    return [
      t.fg("accent", t.bold("Usage / cost")),
      `${t.fg("muted", "Input")}       ${formatTokenCount(total.input)}`,
      `${t.fg("muted", "Output")}      ${formatTokenCount(total.output)}`,
      `${t.fg("muted", "Cache read")}  ${formatTokenCount(total.cacheRead)}`,
      `${t.fg("muted", "Cache write")} ${formatTokenCount(total.cacheWrite)}`,
      `${t.fg("muted", "Cost")}        ${prefix}$${total.cost.toFixed(4)}`,
      `${t.fg("muted", "Turns/tools")} ${total.turns}/${total.toolCalls}`,
      "",
      ...[...byRole.entries()].map(([role, records]) => {
        const subtotal = aggregateUsage(records);
        return `${role.padEnd(9)} ${formatTokenCount(subtotal.input)} in / ${formatTokenCount(subtotal.output)} out / $${subtotal.cost.toFixed(4)}`;
      }),
    ];
  }

  private inboxLines(): string[] {
    const t = this.theme;
    const contractActions = this.initiatives.filter((item) => item.status === "review")
      .map((item) => `${t.fg("warning", "REVIEW")} ${item.contract?.title ?? item.initiativeId}\n  ${t.fg("dim", item.contractPath ?? "contract path unavailable")}`);
    const deliveryActions = (this.delivery?.actions ?? []).map((item) => `${t.fg(item.severity === "critical" ? "error" : "warning", item.severity.toUpperCase())} ${item.message}`);
    const actions = [...contractActions, ...deliveryActions];
    return actions.length === 0 ? [t.fg("success", "No operator action required.")] : [t.fg("accent", t.bold("Action inbox")), ...actions];
  }

  render(width: number): string[] {
    const body = this.view === 0
      ? this.projectLines()
      : this.view === 1
        ? this.initiativeLines()
        : this.view === 2
          ? workerLines(this.delivery)
          : this.view === 3
            ? this.usageLines()
            : this.inboxLines();
    const lines = [
      this.theme.fg("accent", this.theme.bold(" Pi Team Overview ")),
      this.navigation(),
      "",
      ...body.slice(this.scroll),
      "",
      this.theme.fg("dim", "1-5/Tab change · ↑/↓ scroll · q/Escape close · read-only"),
    ];
    return lines.flatMap((line) => line.split("\n")).map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  invalidate(): void {}
}
