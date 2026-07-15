import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertContainedPath, assertWorkerTool } from "./safety.ts";

export default function workerGuard(pi: ExtensionAPI) {
  const root = process.env.PI_DELIVERY_WORKTREE;
  const role = process.env.PI_DELIVERY_ROLE === "reviewer" ? "reviewer" : "implementer";
  if (!root) throw new Error("PI_DELIVERY_WORKTREE is required");
  pi.on("tool_call", async (event) => {
    try {
      assertWorkerTool(role, event.toolName, event.input as Record<string, unknown>);
      if (["read", "write", "edit"].includes(event.toolName)) {
        const path = (event.input as { path?: unknown }).path;
        if (typeof path !== "string") throw new Error("File tool path is required");
        await assertContainedPath(root, path);
      }
      if (event.toolName === "bash") {
        const command = String((event.input as { command?: unknown }).command ?? "");
        if (/(?:^|\s)(?:cd|pushd|popd)\s|(?:\/Users\/|\/home\/|\.\.\/)/.test(command)) throw new Error("Worker shell cannot change or escape its worktree");
      }
    } catch (error) { return { block: true, reason: (error as Error).message }; }
  });
}
