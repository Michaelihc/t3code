import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

export function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

export function workflowToolUseIdForProjectedItem(
  projectedItem: OrchestrationV2ProjectedTurnItem,
): string | null {
  const item = projectedItem.item;
  if (item.type !== "dynamic_tool" || item.toolName?.trim().toLowerCase() !== "workflow") {
    return null;
  }
  return item.nativeItemRef?.nativeId ?? null;
}

function workflowGroupRevision(group: AgentPanelWorkflowGroup): string {
  return [
    group.workflow.id,
    group.workflow.status,
    group.workflow.workflowName,
    group.workflow.title,
    group.workflow.startedAt,
    group.workflow.completedAt,
    group.workflow.updatedAt,
    ...group.phases.flatMap((phase) => [
      phase.index,
      phase.title,
      phase.state,
      phase.activeCount,
      phase.settledCount,
      ...phase.members.map((member) => member.id),
    ]),
    ...workflowMembers(group).flatMap((member) => [
      member.id,
      member.status,
      member.updatedAt,
      member.title,
      member.model,
      member.effort,
      member.phaseIndex,
      member.phaseTitle,
      member.attempt,
      member.progress,
      member.lastToolName,
      member.result,
      member.error,
      member.usage?.totalTokens,
      member.usage?.toolUses,
      member.usage?.durationMs,
    ]),
  ].join("\u0000");
}

function workflowRunSummaryRevision(group: AgentPanelWorkflowGroup): string {
  return [
    group.workflow.id,
    group.workflow.status,
    group.workflow.workflowName,
    group.workflow.title,
    group.workflow.startedAt,
    group.workflow.completedAt,
    workflowMembers(group).length,
  ].join("\u0000");
}

/** Keyed bridge that updates only work-log rows containing the changed workflow. */
export class MobileWorkflowGroupStore {
  readonly #groups = new Map<string, AgentPanelWorkflowGroup>();
  readonly #revisions = new Map<string, string>();
  readonly #versions = new Map<string, number>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #groupsByRunId = new Map<string, ReadonlyArray<AgentPanelWorkflowGroup>>();
  readonly #runRevisions = new Map<string, string>();
  readonly #runVersions = new Map<string, number>();
  readonly #runListeners = new Map<string, Set<() => void>>();
  #nextVersion = 1;

  constructor(groups: ReadonlyArray<AgentPanelWorkflowGroup>) {
    this.replace(groups, false);
  }

  replace(groups: ReadonlyArray<AgentPanelWorkflowGroup>, notify = true): void {
    const nextGroups = new Map<string, AgentPanelWorkflowGroup>();
    const nextRevisions = new Map<string, string>();
    for (const group of groups) {
      const toolUseId = group.workflow.toolUseId;
      if (!toolUseId) continue;
      nextGroups.set(toolUseId, group);
      nextRevisions.set(toolUseId, workflowGroupRevision(group));
    }
    const nextGroupsByRunId = new Map<string, AgentPanelWorkflowGroup[]>();
    for (const group of nextGroups.values()) {
      const runId = group.workflow.runId;
      if (!runId) continue;
      nextGroupsByRunId.set(runId, [...(nextGroupsByRunId.get(runId) ?? []), group]);
    }
    const nextRunRevisions = new Map(
      [...nextGroupsByRunId].map(([runId, runGroups]) => [
        runId,
        runGroups.map(workflowRunSummaryRevision).join("\u0001"),
      ]),
    );

    const changedKeys = [...new Set([...this.#groups.keys(), ...nextGroups.keys()])].filter(
      (key) => this.#revisions.get(key) !== nextRevisions.get(key),
    );
    const changedRunIds = [
      ...new Set([...this.#groupsByRunId.keys(), ...nextGroupsByRunId.keys()]),
    ].filter((runId) => this.#runRevisions.get(runId) !== nextRunRevisions.get(runId));

    this.#groups.clear();
    this.#revisions.clear();
    this.#groupsByRunId.clear();
    this.#runRevisions.clear();
    for (const [key, group] of nextGroups) this.#groups.set(key, group);
    for (const [key, revision] of nextRevisions) this.#revisions.set(key, revision);
    for (const [runId, runGroups] of nextGroupsByRunId) {
      this.#groupsByRunId.set(runId, runGroups);
    }
    for (const [runId, revision] of nextRunRevisions) this.#runRevisions.set(runId, revision);

    for (const key of changedKeys) {
      this.#versions.set(key, this.#nextVersion);
      this.#nextVersion += 1;
      if (notify) {
        for (const listener of this.#listeners.get(key) ?? []) listener();
      }
    }
    for (const runId of changedRunIds) {
      this.#runVersions.set(runId, this.#nextVersion);
      this.#nextVersion += 1;
      if (notify) {
        for (const listener of this.#runListeners.get(runId) ?? []) listener();
      }
    }
  }

  groupForProjectedItem(
    projectedItem: OrchestrationV2ProjectedTurnItem,
  ): AgentPanelWorkflowGroup | null {
    const toolUseId = workflowToolUseIdForProjectedItem(projectedItem);
    return toolUseId === null ? null : (this.#groups.get(toolUseId) ?? null);
  }

  snapshot(toolUseIds: ReadonlyArray<string>): number {
    let version = 0;
    for (const toolUseId of toolUseIds) {
      version = Math.max(version, this.#versions.get(toolUseId) ?? 0);
    }
    return version;
  }

  subscribe(toolUseIds: ReadonlyArray<string>, listener: () => void): () => void {
    for (const toolUseId of toolUseIds) {
      const listeners = this.#listeners.get(toolUseId) ?? new Set();
      listeners.add(listener);
      this.#listeners.set(toolUseId, listeners);
    }
    return () => {
      for (const toolUseId of toolUseIds) {
        const listeners = this.#listeners.get(toolUseId);
        listeners?.delete(listener);
        if (listeners?.size === 0) this.#listeners.delete(toolUseId);
      }
    };
  }

  groupsForRun(runId: string): ReadonlyArray<AgentPanelWorkflowGroup> {
    return this.#groupsByRunId.get(runId) ?? [];
  }

  runSnapshot(runId: string): number {
    return this.#runVersions.get(runId) ?? 0;
  }

  subscribeRun(runId: string, listener: () => void): () => void {
    const listeners = this.#runListeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.#runListeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#runListeners.delete(runId);
    };
  }
}

export function formatMobileWorkflowFoldLabel(
  defaultLabel: string,
  groups: ReadonlyArray<AgentPanelWorkflowGroup>,
  now = Date.now(),
): string {
  if (groups.length === 0) return defaultLabel;
  const starts = groups.flatMap((group) => {
    if (group.workflow.startedAt === null) return [];
    const startedAt = Date.parse(group.workflow.startedAt);
    return Number.isFinite(startedAt) ? [startedAt] : [];
  });
  const ends = groups.flatMap((group) => {
    if (group.workflow.completedAt === null) return [now];
    const completedAt = Date.parse(group.workflow.completedAt);
    return Number.isFinite(completedAt) ? [completedAt] : [];
  });
  const duration =
    starts.length === 0 || ends.length === 0
      ? null
      : formatDuration(Math.max(0, Math.max(...ends) - Math.min(...starts)));
  const agentCount = groups.reduce((total, group) => total + workflowMembers(group).length, 0);
  return [
    groups.length === 1
      ? `Workflow ${groups[0]!.workflow.workflowName ?? groups[0]!.workflow.title}`
      : `${groups.length} workflows`,
    agentCount > 0 ? `${agentCount} ${agentCount === 1 ? "agent" : "agents"}` : null,
    duration,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function workflowIsLive(workflow: Pick<RuntimeSubagent, "status">): boolean {
  return (
    workflow.status === "pending" || workflow.status === "running" || workflow.status === "waiting"
  );
}

export function workflowMemberActivity(member: RuntimeSubagent): string | null {
  if (workflowIsLive(member)) {
    return (
      member.progress ??
      (member.lastToolName ? `Using ${member.lastToolName}` : null) ??
      member.result ??
      member.error
    );
  }
  return (
    member.error ??
    member.result ??
    member.progress ??
    (member.lastToolName ? `Using ${member.lastToolName}` : null)
  );
}

export function workflowElapsedLabel(
  workflow: Pick<RuntimeSubagent, "startedAt" | "completedAt">,
  now = Date.now(),
): string | null {
  if (!workflow.startedAt) return null;
  const start = Date.parse(workflow.startedAt);
  const end = workflow.completedAt ? Date.parse(workflow.completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
