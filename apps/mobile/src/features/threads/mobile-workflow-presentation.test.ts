import { describe, expect, it, vi } from "vite-plus/test";

import type {
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import {
  formatMobileWorkflowFoldLabel,
  MobileWorkflowGroupStore,
  workflowElapsedLabel,
  workflowMemberActivity,
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
  runId: "run-workflow",
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
  it("keeps every phase and unphased workflow member visible", () => {
    const orphan = runtimeSubagent({ id: "workflow:survey:orphan", phaseIndex: null });
    expect(workflowMembers({ ...group, unphasedMembers: [orphan] })).toEqual([...members, orphan]);
  });

  it("prefers final workflow member output after completion", () => {
    expect(
      workflowMemberActivity(
        runtimeSubagent({
          status: "completed",
          progress: "Still reading files",
          lastToolName: "Read",
          result: "Survey complete",
        }),
      ),
    ).toBe("Survey complete");
    expect(
      workflowMemberActivity(
        runtimeSubagent({
          status: "running",
          progress: "Reading files",
          result: "Old result",
        }),
      ),
    ).toBe("Reading files");
  });

  it("uses the coordinator lifecycle rather than the early tool completion", () => {
    expect(workflowElapsedLabel(workflow)).toBe("1m 41s");
    expect(formatMobileWorkflowFoldLabel("Worked for 2s", [group])).toBe(
      "Workflow sandbox-project-survey · 2 agents · 1m 41s",
    );
    expect(
      formatMobileWorkflowFoldLabel(
        "Worked for 2s",
        [
          {
            ...group,
            workflow: runtimeSubagent({ ...workflow, status: "running", completedAt: null }),
          },
        ],
        Date.parse("2026-09-04T00:01:41.000Z"),
      ),
    ).toBe("Workflow sandbox-project-survey · 2 agents · 1m 41s");
  });

  it("notifies only rows subscribed to the workflow that changed", () => {
    const store = new MobileWorkflowGroupStore([group]);
    const surveyListener = vi.fn();
    const otherListener = vi.fn();
    const unsubscribeSurvey = store.subscribe(["toolu_workflow"], surveyListener);
    const unsubscribeOther = store.subscribe(["toolu_other"], otherListener);
    const runListener = vi.fn();
    const unsubscribeRun = store.subscribeRun("run-workflow", runListener);
    const surveySnapshot = store.snapshot(["toolu_workflow"]);

    const updatedGroup = {
      ...group,
      workflow: runtimeSubagent({
        ...workflow,
        status: "running",
        completedAt: null,
        updatedAt: "2026-09-04T00:01:42.000Z",
      }),
    } satisfies AgentPanelWorkflowGroup;
    store.replace([updatedGroup]);

    expect(store.snapshot(["toolu_workflow"])).toBeGreaterThan(surveySnapshot);
    expect(store.groupForProjectedItem(projectedWorkflow())).toBe(updatedGroup);
    expect(surveyListener).toHaveBeenCalledTimes(1);
    expect(otherListener).not.toHaveBeenCalled();
    expect(runListener).toHaveBeenCalledTimes(1);
    expect(store.groupsForRun("run-workflow")).toEqual([updatedGroup]);

    const metadataSnapshot = store.snapshot(["toolu_workflow"]);
    const metadataGroup = {
      ...updatedGroup,
      phases: [
        {
          ...updatedGroup.phases[0]!,
          members: [
            runtimeSubagent({
              ...updatedGroup.phases[0]!.members[0]!,
              title: "Renamed surveyor",
              model: "claude-opus-4-6",
            }),
            ...updatedGroup.phases[0]!.members.slice(1),
          ],
        },
      ],
    } satisfies AgentPanelWorkflowGroup;
    store.replace([metadataGroup]);

    expect(store.snapshot(["toolu_workflow"])).toBeGreaterThan(metadataSnapshot);
    expect(surveyListener).toHaveBeenCalledTimes(2);
    expect(runListener).toHaveBeenCalledTimes(1);

    const memberCountGroup = {
      ...metadataGroup,
      unphasedMembers: [runtimeSubagent({ id: "workflow:survey:orphan", phaseIndex: null })],
    } satisfies AgentPanelWorkflowGroup;
    store.replace([memberCountGroup]);

    expect(surveyListener).toHaveBeenCalledTimes(3);
    expect(runListener).toHaveBeenCalledTimes(2);

    unsubscribeSurvey();
    unsubscribeOther();
    unsubscribeRun();
  });
});
