import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";

import { useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiStateStore } from "../uiStateStore";

// Module-level so each thread is considered once per page load. The visit
// command keeps max(stored, supplied); only seed an unset server watermark so
// refreshing another client cannot undo a deliberate mark-unread.
const migratedThreadKeys = new Set<string>();

export function localVisitToMigrate(
  serverLastVisitedAt: string | null | undefined,
  localLastVisitedAt: string | undefined,
): string | undefined {
  if (serverLastVisitedAt !== null || !localLastVisitedAt) return undefined;
  return Number.isFinite(Date.parse(localLastVisitedAt)) ? localLastVisitedAt : undefined;
}

/**
 * One-way migration of the browser-local visited watermarks into servers with
 * visited tracking. Before tracking existed, "Done" lived in this browser's
 * localStorage; pushing those watermarks up seeds the server value so other
 * devices see the same read state. An existing server watermark is authoritative,
 * including a deliberate rewind from marking a thread unread.
 */
export function useThreadVisitedMigration(): void {
  const threads = useThreadShells();
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  useEffect(() => {
    for (const thread of threads) {
      // Field absent → the environment's server has no visited tracking; keep
      // the local value in play and reconsider if the server upgrades.
      if (thread.lastVisitedAt === undefined) continue;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      if (migratedThreadKeys.has(threadKey)) continue;
      migratedThreadKeys.add(threadKey);
      const local = localVisitToMigrate(
        thread.lastVisitedAt,
        useUiStateStore.getState().threadLastVisitedAtById[threadKey],
      );
      if (!local) continue;
      void visitThreadMutation({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, visitedAt: local },
      });
    }
  }, [threads, visitThreadMutation]);
}
