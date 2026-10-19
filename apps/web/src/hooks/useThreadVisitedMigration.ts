import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useContext, useEffect, useEffectEvent } from "react";

import { environmentThreadShells, threadEnvironment } from "../state/threads";
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

// Subscribes outside render: the migration only acts on threads it has not
// seen, so a shell update must not re-render the layout that mounts it.
export function useThreadVisitedMigration(): void {
  const registry = useContext(RegistryContext);
  const visitThreadMutation = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const migrate = useEffectEvent((threads: ReadonlyArray<EnvironmentThreadShell>) => {
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
  });
  useEffect(
    () =>
      registry.subscribe(environmentThreadShells.threadShellsAtom, migrate, { immediate: true }),
    [registry],
  );
}
