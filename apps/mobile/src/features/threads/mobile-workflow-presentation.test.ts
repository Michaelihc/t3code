import { describe, expect, it } from "vite-plus/test";

import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import {
  workflowElapsedLabel,
  workflowGroupForProjectedItem,
  workflowMembers,
} from "./mobile-workflow-presentation";

function runtimeSubagent(overrides: Partial<RuntimeSubagent>): RuntimeSubagent {
  return {
    id: "agent",
    kind: "workflow_agent",
    title: "Agent",
    role: null,
    model: "claude-sonnet-4-5",
    effort: null,
    status: "completed",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    toolUseId: null,
    parentAgentId: "workflow:survey",
    agentIndex: 0,
    phaseIndex: 0,
    phaseTitle: "Survey",
    attempt: 1,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-09-04T00:00:00.000Z",
    startedAt: "2026-09-04T00:00:00.000Z",
    completedAt: "2026-09-04T00:00:44.000Z",
    updatedAt: "2026-09-04T00:00:44.000Z",
    ...overrides,
  };
}

const workflow = runtimeSubagent({
  id: "workflow:survey",
  kind: "workflow",
  title: "sandbox-project-survey",
  workflowName: "sandbox-project-survey",
  toolUseId: "toolu_workflow",
  parentAgentId: null,
  agentIndex: null,
  phaseIndex: null,
  phaseTitle: null,
  startedAt: "2026-09-04T00:00:00.000Z",
  completedAt: "2026-09-04T00:01:41.000Z",
});

const members = [
  runtimeSubagent({ id: "workflow:survey:0", agentIndex: 0 }),
  runtimeSubagent({ id: "workflow:survey:1", agentIndex: 1 }),
];

const group = {
  workflow,
  phases: [
    {
      index: 0,
      title: "Survey",
      members,
      state: "done",
      activeCount: 0,
      settledCount: 2,
    },
  ],
  unphasedMembers: [],
} satisfies AgentPanelWorkflowGroup;

function projectedWorkflow(toolUseId = "toolu_workflow") {
  return {
    item: {
      type: "dynamic_tool",
      toolName: "Workflow",
      nativeItemRef: { nativeId: toolUseId },
    },
  } as OrchestrationV2ProjectedTurnItem;
}

describe("mobile workflow presentation", () => {
  it("joins the workflow tool to its projected coordinator", () => {
    expect(workflowGroupForProjectedItem(projectedWorkflow(), [group])).toBe(group);
    expect(workflowGroupForProjectedItem(projectedWorkflow("other"), [group])).toBeNull();
  });

  it("keeps every phase and unphased workflow member visible", () => {
    const orphan = runtimeSubagent({ id: "workflow:survey:orphan", phaseIndex: null });
    expect(workflowMembers({ ...group, unphasedMembers: [orphan] })).toEqual([...members, orphan]);
  });

  it("uses the coordinator lifecycle rather than the early tool completion", () => {
    expect(workflowElapsedLabel(workflow)).toBe("1m 41s");
  });
});
