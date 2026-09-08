import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";

export type TimelineWorkflow = Pick<
  RuntimeSubagent,
  "workflowName" | "status" | "startedAt" | "completedAt"
>;

export interface TimelineWorkflowRowSnapshot {
  readonly workflow: TimelineWorkflow;
  readonly agentCount: number;
}

export function workflowRowSnapshotsEqual(
  left: TimelineWorkflowRowSnapshot,
  right: TimelineWorkflowRowSnapshot,
): boolean {
  return (
    left.agentCount === right.agentCount &&
    left.workflow.workflowName === right.workflow.workflowName &&
    left.workflow.status === right.workflow.status &&
    left.workflow.startedAt === right.workflow.startedAt &&
    left.workflow.completedAt === right.workflow.completedAt
  );
}

/** Keeps unchanged snapshots stable and notifies only subscribers to changed keys. */
export class TimelineWorkflowStore<Key, Snapshot> {
  private snapshots: ReadonlyMap<Key, Snapshot>;
  private readonly listeners = new Map<Key, Set<() => void>>();

  constructor(
    snapshots: ReadonlyMap<Key, Snapshot>,
    private readonly equal: (left: Snapshot, right: Snapshot) => boolean,
  ) {
    this.snapshots = snapshots;
  }

  readonly getSnapshot = (key: Key): Snapshot | undefined => this.snapshots.get(key);

  readonly subscribe = (key: Key, listener: () => void): (() => void) => {
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  };

  replace(next: ReadonlyMap<Key, Snapshot>): void {
    const stable = new Map<Key, Snapshot>();
    const changed = new Set<Key>();
    for (const [key, snapshot] of next) {
      const previous = this.snapshots.get(key);
      if (previous !== undefined && this.equal(previous, snapshot)) {
        stable.set(key, previous);
      } else {
        stable.set(key, snapshot);
        changed.add(key);
      }
    }
    for (const key of this.snapshots.keys()) {
      if (!next.has(key)) changed.add(key);
    }
    this.snapshots = stable;
    for (const key of changed) {
      for (const listener of this.listeners.get(key) ?? []) listener();
    }
  }
}
