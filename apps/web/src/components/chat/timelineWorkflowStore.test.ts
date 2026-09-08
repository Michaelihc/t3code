import { describe, expect, it, vi } from "vite-plus/test";
import {
  TimelineWorkflowStore,
  workflowRowSnapshotsEqual,
  type TimelineWorkflowRowSnapshot,
} from "./timelineWorkflowStore";

function row(name: string): TimelineWorkflowRowSnapshot {
  return {
    workflow: {
      workflowName: name,
      status: "running",
      startedAt: "2026-09-08T00:00:00.000Z",
      completedAt: null,
    },
    agentCount: 2,
  };
}

describe("timeline workflow subscriptions", () => {
  it("only notifies the affected tool-use ID when projections are rebuilt", () => {
    const a = row("audit");
    const b = row("verify");
    const store = new TimelineWorkflowStore(
      new Map([
        ["tool-a", a],
        ["tool-b", b],
      ]),
      workflowRowSnapshotsEqual,
    );
    const onA = vi.fn();
    const onB = vi.fn();
    store.subscribe("tool-a", onA);
    store.subscribe("tool-b", onB);

    const updatedA = { ...a, agentCount: 3 };
    store.replace(
      new Map([
        ["tool-a", updatedA],
        ["tool-b", { ...b, workflow: { ...b.workflow } }],
      ]),
    );

    expect(onA).toHaveBeenCalledOnce();
    expect(onB).not.toHaveBeenCalled();
    expect(store.getSnapshot("tool-a")).toBe(updatedA);
    expect(store.getSnapshot("tool-b")).toBe(b);
  });

  it("ignores telemetry that the row does not display but publishes lifecycle changes", () => {
    const initial = row("audit");
    const store = new TimelineWorkflowStore(
      new Map([["tool", initial]]),
      workflowRowSnapshotsEqual,
    );
    const onChange = vi.fn();
    store.subscribe("tool", onChange);
    const telemetry = {
      ...initial,
      workflow: { ...initial.workflow, progress: "Reading files", usage: { totalTokens: 100 } },
    };
    store.replace(new Map([["tool", telemetry]]));
    expect(onChange).not.toHaveBeenCalled();
    expect(store.getSnapshot("tool")).toBe(initial);

    for (const change of [
      { workflowName: "renamed audit" },
      { startedAt: "2026-09-08T00:01:00.000Z" },
      { status: "failed" as const, completedAt: "2026-09-08T00:02:00.000Z" },
    ]) {
      const previous = store.getSnapshot("tool")!;
      const next = { ...previous, workflow: { ...previous.workflow, ...change } };
      store.replace(new Map([["tool", next]]));
      expect(store.getSnapshot("tool")).toBe(next);
    }
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("notifies on late arrival and removal and stops notifying after unsubscribe", () => {
    const store = new TimelineWorkflowStore<string, TimelineWorkflowRowSnapshot>(
      new Map(),
      workflowRowSnapshotsEqual,
    );
    const onChange = vi.fn(() => store.getSnapshot("tool"));
    const unsubscribe = store.subscribe("tool", onChange);
    expect(store.getSnapshot("tool")).toBeUndefined();
    const snapshot = row("audit");
    store.replace(new Map([["tool", snapshot]]));
    expect(onChange).toHaveLastReturnedWith(snapshot);
    store.replace(new Map());
    expect(onChange).toHaveLastReturnedWith(undefined);
    expect(onChange).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.replace(new Map([["tool", snapshot]]));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
