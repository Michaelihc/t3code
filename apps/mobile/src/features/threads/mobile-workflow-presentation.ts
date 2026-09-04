import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";

export function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

export function workflowGroupForProjectedItem(
  projectedItem: OrchestrationV2ProjectedTurnItem,
  groups: ReadonlyArray<AgentPanelWorkflowGroup>,
): AgentPanelWorkflowGroup | null {
  const item = projectedItem.item;
  if (item.type !== "dynamic_tool" || item.toolName?.trim().toLowerCase() !== "workflow") {
    return null;
  }

  const toolUseId = item.nativeItemRef?.nativeId;
  if (!toolUseId) return null;
  return groups.find((group) => group.workflow.toolUseId === toolUseId) ?? null;
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
