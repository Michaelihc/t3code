import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";

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

export function workflowGroupForProjectedItem(
  projectedItem: OrchestrationV2ProjectedTurnItem,
  groups: ReadonlyArray<AgentPanelWorkflowGroup>,
): AgentPanelWorkflowGroup | null {
  const toolUseId = workflowToolUseIdForProjectedItem(projectedItem);
  if (!toolUseId) return null;
  return groups.find((group) => group.workflow.toolUseId === toolUseId) ?? null;
}

function workflowGroupRevision(group: AgentPanelWorkflowGroup): string {
  return [
    group.workflow.id,
    group.workflow.status,
    group.workflow.workflowName,
    group.workflow.startedAt,
    group.workflow.completedAt,
    group.workflow.updatedAt,
    ...group.phases.flatMap((phase) => [
      phase.index,
      phase.title,
      phase.state,
      phase.activeCount,
      phase.settledCount,
    ]),
    ...workflowMembers(group).flatMap((member) => [
      member.id,
      member.status,
      member.updatedAt,
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

/** Keyed bridge that updates only work-log rows containing the changed workflow. */
export class MobileWorkflowGroupStore {
  readonly #groups = new Map<string, AgentPanelWorkflowGroup>();
  readonly #revisions = new Map<string, string>();
  readonly #versions = new Map<string, number>();
  readonly #listeners = new Map<string, Set<() => void>>();
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

    const changedKeys = [...new Set([...this.#groups.keys(), ...nextGroups.keys()])].filter(
      (key) => this.#revisions.get(key) !== nextRevisions.get(key),
    );

    this.#groups.clear();
    this.#revisions.clear();
    for (const [key, group] of nextGroups) this.#groups.set(key, group);
    for (const [key, revision] of nextRevisions) this.#revisions.set(key, revision);

    for (const key of changedKeys) {
      this.#versions.set(key, this.#nextVersion);
      this.#nextVersion += 1;
      if (notify) {
        for (const listener of this.#listeners.get(key) ?? []) listener();
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
}

export function workflowIsLive(workflow: RuntimeSubagent): boolean {
  return (
    workflow.status === "pending" || workflow.status === "running" || workflow.status === "waiting"
  );
}

export function workflowElapsedLabel(workflow: RuntimeSubagent, now = Date.now()): string | null {
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
