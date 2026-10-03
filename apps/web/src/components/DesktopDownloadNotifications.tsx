import type { DesktopBridge, DesktopFileDownloadState } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { useEffect } from "react";
import { getDesktopDownloadRetry } from "../lib/desktopDownloadRetry";

import { toastManager, stackedThreadToast } from "./ui/toast";

export function downloadProgressLabel(state: DesktopFileDownloadState) {
  const bytes = (value: number) =>
    value >= 1024 * 1024
      ? `${(value / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.round(value / 1024)} KB`;
  if (state.status === "preparing") return "Preparing download…";
  if (state.totalBytes === null) return `${bytes(state.receivedBytes)} received`;
  const percentage = Math.min(100, Math.floor((state.receivedBytes / state.totalBytes) * 100));
  return `${bytes(state.receivedBytes)} / ${bytes(state.totalBytes)} · ${percentage}%`;
}

function DownloadProgress({ state }: { state: DesktopFileDownloadState }) {
  const known = state.totalBytes !== null && state.totalBytes > 0;
  const percent = known ? Math.min(100, (state.receivedBytes / state.totalBytes!) * 100) : 0;
  return (
    <span className="flex flex-col gap-2">
      <span className="tabular-nums">{state.message ?? downloadProgressLabel(state)}</span>
      {known ? (
        <span
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(percent)}
          className="h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
        >
          <span className="block h-full bg-foreground/70" style={{ width: `${percent}%` }} />
        </span>
      ) : null}
    </span>
  );
}

/** One notification follows a transfer through native disk completion. */
export function observeDesktopDownloads(bridge: DesktopBridge) {
  if (!bridge.onFileDownload || !bridge.getFileDownloads) return () => {};
  const toastIds = new Map<string, ReturnType<typeof toastManager.add>>();
  const observed = new Set<string>();
  let disposed = false;
  const action = (operation: () => Promise<void>) => {
    void operation().catch(() => {
      toastManager.add({ type: "error", title: "Could not complete download action" });
    });
  };
  const render = (state: DesktopFileDownloadState) => {
    if (disposed) return;
    const active = state.status === "preparing" || state.status === "progressing";
    const retry = getDesktopDownloadRetry(state.id);
    const payload = stackedThreadToast({
      type: state.status === "failed" ? "error" : state.status === "completed" ? "success" : "info",
      title: `${active ? "Downloading" : state.status === "completed" ? "Downloaded" : state.status === "cancelled" ? "Download cancelled:" : "Download failed:"} ${state.name}`,
      description: active ? <DownloadProgress state={state} /> : state.message,
      timeout: active || state.status === "failed" ? 0 : 10_000,
      priority: "low",
      actionProps: active
        ? { children: "Cancel", onClick: () => action(() => bridge.cancelFileDownload!(state.id)) }
        : state.status === "completed"
          ? {
              children: "Open file",
              onClick: () =>
                action(() => bridge.openDownloadedFile!({ id: state.id, reveal: false })),
            }
          : state.status === "failed" && retry
            ? {
                children: "Retry",
                onClick: () => {
                  toastManager.close(toastIds.get(state.id)!);
                  action(retry);
                },
              }
            : { children: null },
      data: {
        leadingIcon: active ? <DownloadIcon aria-hidden className="size-4" /> : undefined,
        hideCopyButton: true,
        additionalActions:
          state.status === "completed"
            ? [
                {
                  id: "reveal",
                  props: {
                    children: "Show in folder",
                    onClick: () =>
                      action(() => bridge.openDownloadedFile!({ id: state.id, reveal: true })),
                  },
                },
              ]
            : [],
      },
    });
    const existing = toastIds.get(state.id);
    if (existing) toastManager.update(existing, payload);
    else toastIds.set(state.id, toastManager.add(payload));
  };
  // Listen first so a stale initial snapshot cannot replace a newer progress event.
  const unsubscribe = bridge.onFileDownload((state) => {
    observed.add(state.id);
    render(state);
  });
  void bridge
    .getFileDownloads()
    .then((states) => {
      for (const state of states) {
        if (
          !observed.has(state.id) &&
          (state.status === "preparing" || state.status === "progressing")
        )
          render(state);
      }
    })
    .catch(() => {});
  return () => {
    disposed = true;
    unsubscribe();
    for (const id of toastIds.values()) toastManager.close(id);
  };
}

export function DesktopDownloadNotifications() {
  useEffect(
    () => (window.desktopBridge ? observeDesktopDownloads(window.desktopBridge) : undefined),
    [],
  );
  return null;
}
