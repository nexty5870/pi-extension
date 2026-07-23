import type { FeatureTrack, V4ProjectState, WorkerTaskV4 } from "./types.ts";

const CAPACITY_STATES = new Set(["launching", "running", "unknown", "quarantined"]);

export function workerProcessCapacityUsed(tasks: Iterable<WorkerTaskV4>): number {
  let used = 0;
  for (const task of tasks) if (CAPACITY_STATES.has(task.processState)) used++;
  return used;
}

export function fairWorkerLaunches(state: V4ProjectState): WorkerTaskV4[] {
  const tasks = Object.values(state.tasks);
  const available = Math.max(0, state.config.maxConcurrentWorkerProcesses - workerProcessCapacityUsed(tasks));
  if (available === 0) return [];
  const queuedByFeature = new Map<string, WorkerTaskV4[]>();
  for (const task of tasks.filter((candidate) => {
    if (candidate.processState !== "queued") return false;
    if (candidate.role !== "review") return true;
    const parent = candidate.parentTaskId ? state.tasks[candidate.parentTaskId] : undefined;
    return Boolean(parent && ["pr-ready-ci-pending", "pr-ready-ci-green", "completed"].includes(parent.status));
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const queue = queuedByFeature.get(task.featureId) ?? [];
    queue.push(task);
    queuedByFeature.set(task.featureId, queue);
  }
  const features = Object.values(state.features)
    .filter((feature) => (queuedByFeature.get(feature.id)?.length ?? 0) > 0)
    .sort((a, b) => a.schedulerSequence - b.schedulerSequence || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (features.length === 0) return [];
  const cursor = state.schedulerCursor;
  const cursorIndex = cursor ? features.findIndex((feature) => feature.id === cursor) : -1;
  const ordered = cursorIndex < 0 ? features : [...features.slice(cursorIndex + 1), ...features.slice(0, cursorIndex + 1)];
  const selected: WorkerTaskV4[] = [];
  let progress = true;
  while (selected.length < available && progress) {
    progress = false;
    for (const feature of ordered) {
      const task = queuedByFeature.get(feature.id)?.shift();
      if (!task) continue;
      selected.push(task);
      progress = true;
      if (selected.length >= available) break;
    }
  }
  return selected;
}

export function activeLeadProcessCount(state: V4ProjectState): number {
  const attached = Object.values(state.attachments).filter((attachment) => attachment.state === "attached").length;
  const unattachedLaunches = Object.values(state.features).filter((feature) =>
    (feature.leadLaunchState === "launching" || feature.leadLaunchState === "launched")
    && !feature.ownerAttachmentId).length;
  return attached + unattachedLaunches;
}

export function fairLeadLaunches(state: V4ProjectState): FeatureTrack[] {
  const available = Math.max(0, state.config.maxConcurrentLeads - activeLeadProcessCount(state));
  return Object.values(state.features)
    .filter((feature) => feature.leadLaunchState === "queued")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(0, available);
}
