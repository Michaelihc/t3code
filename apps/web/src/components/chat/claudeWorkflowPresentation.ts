import { formatDuration } from "@t3tools/shared/orchestrationTiming";
export {
  claudeWorkflowScriptFromToolInput,
  parseClaudeWorkflowScriptMeta,
  type ClaudeWorkflowPhaseMeta,
  type ClaudeWorkflowScriptMeta,
} from "@t3tools/client-runtime/claude-workflow-meta";

export interface ClaudeWorkflowFoldSummary {
  readonly name: string;
  readonly agentCount: number;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

function workflowFoldDuration(
  workflows: ReadonlyArray<ClaudeWorkflowFoldSummary>,
  now: number,
): string | null {
  const starts = workflows.flatMap((workflow) => {
    if (workflow.startedAt === null) return [];
    const startedAt = Date.parse(workflow.startedAt);
    return Number.isFinite(startedAt) ? [startedAt] : [];
  });
  if (starts.length === 0) return null;
  const ends = workflows.flatMap((workflow) => {
    if (workflow.completedAt === null) return [now];
    const completedAt = Date.parse(workflow.completedAt);
    return Number.isFinite(completedAt) ? [completedAt] : [];
  });
  if (ends.length === 0) return null;
  return formatDuration(Math.max(0, Math.max(...ends) - Math.min(...starts)));
}

export function formatClaudeWorkflowFoldLabel(
  defaultLabel: string,
  workflows: ReadonlyArray<ClaudeWorkflowFoldSummary>,
  now = Date.now(),
): string {
  if (workflows.length === 0) return defaultLabel;
  const duration = workflowFoldDuration(workflows, now);
  const workflowLabel =
    workflows.length === 1 ? `Workflow ${workflows[0]!.name}` : `${workflows.length} workflows`;
  const agentCount = workflows.reduce((total, workflow) => total + workflow.agentCount, 0);
  return [
    workflowLabel,
    agentCount > 0 ? `${agentCount} ${agentCount === 1 ? "agent" : "agents"}` : null,
    duration,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}
