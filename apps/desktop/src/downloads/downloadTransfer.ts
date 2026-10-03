import type { DesktopFileDownloadState } from "@t3tools/contracts";

export interface DownloadTransfer {
  on(event: "updated", listener: (event: unknown, state: string) => void): unknown;
  once(event: "done", listener: (event: unknown, state: string) => void): unknown;
  removeListener(event: string, listener: (event: unknown, state: string) => void): unknown;
  getReceivedBytes(): number;
  getTotalBytes(): number;
  getSavePath(): string;
  canResume(): boolean;
  resume(): void;
  cancel(): void;
}

/** Native completion, rather than bytes received, proves the file was saved. */
export function trackDownloadTransfer(input: {
  item: DownloadTransfer;
  initial: DesktopFileDownloadState;
  publish: (state: DesktopFileDownloadState, savePath: string | null) => void;
  now: () => number;
}) {
  let lastPublishedAt = -Infinity;
  let attemptedResume = false;
  const snapshot = (status: DesktopFileDownloadState["status"], message: string | null) => ({
    ...input.initial,
    status,
    receivedBytes: input.item.getReceivedBytes(),
    totalBytes: input.item.getTotalBytes() > 0 ? input.item.getTotalBytes() : null,
    message,
  });
  const updated = (_event: unknown, nativeState: string) => {
    if (nativeState === "interrupted") {
      if (!attemptedResume && input.item.canResume()) {
        attemptedResume = true;
        input.publish(snapshot("progressing", "Reconnecting download…"), null);
        try {
          input.item.resume();
          return;
        } catch {
          // Failed native recovery falls back to a fresh, signed Retry.
        }
      }
      dispose();
      input.publish(
        snapshot("failed", "The transfer was interrupted. Try downloading again."),
        null,
      );
      input.item.cancel();
      return;
    }
    const now = input.now();
    if (now - lastPublishedAt < 250) return;
    lastPublishedAt = now;
    input.publish(snapshot("progressing", null), null);
  };
  const done = (_event: unknown, nativeState: string) => {
    dispose();
    const status =
      nativeState === "completed"
        ? "completed"
        : nativeState === "cancelled"
          ? "cancelled"
          : "failed";
    input.publish(
      snapshot(
        status,
        status === "failed" ? "The transfer was interrupted. Try downloading again." : null,
      ),
      status === "completed" ? input.item.getSavePath() : null,
    );
  };
  const dispose = () => {
    input.item.removeListener("updated", updated);
    input.item.removeListener("done", done);
  };
  input.item.on("updated", updated);
  input.item.once("done", done);
  updated(undefined, "progressing");
  return dispose;
}
