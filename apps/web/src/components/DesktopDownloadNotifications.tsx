import type { DesktopBridge, DesktopFileDownloadState } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { useEffect } from "react";
import { retryDesktopDownload } from "../lib/desktopDownloadRetry";

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
  const dismissedProgress = new Set<string>();
  const retrying = new Set<string>();
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
    if (active && dismissedProgress.has(state.id)) return;
    if (!active) dismissedProgress.delete(state.id);
    const retry = bridge.getFileDownloadRetryInput
      ? () => retryDesktopDownload(bridge, state.id)
      : undefined;
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
                disabled: retrying.has(state.id),
                onClick: () => {
                  if (retrying.has(state.id)) return;
                  retrying.add(state.id);
                  render(state);
                  action(async () => {
                    try {
                      await retry();
                    } catch (cause) {
                      retrying.delete(state.id);
                      render(state);
                      throw cause;
                    }
                    retrying.delete(state.id);
                    if (disposed) return;
                    const id = toastIds.get(state.id);
                    if (id) toastManager.close(id);
                    await bridge.acknowledgeFileDownload?.(state.id);
                  });
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
    payload.onClose = () => {
      toastIds.delete(state.id);
      if (disposed) return;
      if (active) dismissedProgress.add(state.id);
      else if (state.status === "failed")
        void bridge.acknowledgeFileDownload?.(state.id).catch(() => {});
    };
    const existing = toastIds.get(state.id);
    if (existing) toastManager.update(existing, payload);
    else toastIds.set(state.id, toastManager.add(payload));
    if (!active && state.status !== "failed")
      void bridge.acknowledgeFileDownload?.(state.id).catch(() => {});
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
        if (!observed.has(state.id)) render(state);
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
