import type { DesktopBridge, DesktopFileDownloadState } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

type Payload = {
  title: string;
  description: unknown;
  onClose: () => void;
  actionProps: { children: string; onClick: () => void };
  data: { additionalActions: { props: { onClick: () => void } }[] };
};
const manager = vi.hoisted(() => ({
  add: vi.fn((_payload: Payload) => "toast-1"),
  update: vi.fn((_id: string, _payload: Payload) => {}),
  close: vi.fn(),
}));
vi.mock("./ui/toast", async () => ({
  toastManager: manager,
  stackedThreadToast: (await import("./ui/toastHelpers")).stackedThreadToast,
}));
import { downloadProgressLabel, observeDesktopDownloads } from "./DesktopDownloadNotifications";
const retry = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../lib/desktopDownloadRetry", () => ({ retryDesktopDownload: retry }));

const state: DesktopFileDownloadState = {
  id: "transfer",
  name: "report.pdf",
  status: "progressing",
  receivedBytes: 1024,
  totalBytes: 4096,
  message: null,
};
afterEach(() => {
  vi.clearAllMocks();
  retry.mockReset().mockResolvedValue(undefined);
});

describe("desktop download notifications", () => {
  it("respects dismissed progress and restores completion with saved-file actions", async () => {
    let receive!: (value: DesktopFileDownloadState) => void;
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const open = vi.fn().mockResolvedValue(undefined);
    const bridge = {
      onFileDownload: (callback: typeof receive) => {
        receive = callback;
        return () => {};
      },
      getFileDownloads: async () => [],
      acknowledgeFileDownload: acknowledge,
      openDownloadedFile: open,
    } as unknown as DesktopBridge;
    const dispose = observeDesktopDownloads(bridge);
    receive(state);
    manager.add.mock.calls[0]![0].onClose();
    receive({ ...state, receivedBytes: 2048 });
    expect(manager.add).toHaveBeenCalledTimes(1);
    expect(manager.update).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    receive({ ...state, status: "completed" });
    expect(manager.add).toHaveBeenCalledTimes(2);
    const completion = manager.add.mock.calls[1]![0];
    expect(completion.title).toBe("Downloaded report.pdf");
    completion.actionProps.onClick();
    expect(open).toHaveBeenCalledWith({ id: state.id, reveal: false });
    expect(acknowledge).toHaveBeenCalledWith(state.id);
    dispose();
  });
  it("restores a missed terminal snapshot and retains Retry after a renderer reload", async () => {
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const bridge = {
      onFileDownload: () => () => {},
      getFileDownloads: async () => [{ ...state, id: "reloaded", status: "failed" as const }],
      getFileDownloadRetryInput: vi.fn(),
      acknowledgeFileDownload: acknowledge,
    } as unknown as DesktopBridge;
    const dispose = observeDesktopDownloads(bridge);
    await Promise.resolve();
    const payload = manager.add.mock.calls[0]![0];
    expect(payload.title).toBe("Download failed: report.pdf");
    expect(acknowledge).not.toHaveBeenCalled();
    payload.actionProps.onClick();
    expect(retry).toHaveBeenCalledWith(bridge, "reloaded");
    await Promise.resolve();
    expect(acknowledge).toHaveBeenCalledWith("reloaded");
    dispose();
  });
  it("shows bytes for unknown lengths without inventing a percentage", () => {
    expect(downloadProgressLabel({ ...state, totalBytes: null })).toBe("1 KB received");
    expect(downloadProgressLabel(state)).toBe("1 KB / 4 KB · 25%");
  });
  it("keeps a completion event newer than the initial active snapshot and exposes saved-file actions", async () => {
    let receive!: (value: DesktopFileDownloadState) => void;
    let resolve!: (value: readonly DesktopFileDownloadState[]) => void;
    const unsubscribe = vi.fn();
    const open = vi.fn().mockResolvedValue(undefined);
    const bridge = {
      onFileDownload: (callback: typeof receive) => {
        receive = callback;
        return unsubscribe;
      },
      getFileDownloads: () =>
        new Promise<readonly DesktopFileDownloadState[]>((done) => {
          resolve = done;
        }),
      openDownloadedFile: open,
    } as unknown as DesktopBridge;
    const dispose = observeDesktopDownloads(bridge);
    receive({ ...state, status: "completed" });
    resolve([state]);
    await Promise.resolve();
    expect(manager.add).toHaveBeenCalledTimes(1);
    expect(manager.update).not.toHaveBeenCalled();
    const payload = manager.add.mock.calls[0]![0];
    expect(payload.title).toBe("Downloaded report.pdf");
    expect(payload.description).toBeNull();
    payload.actionProps.onClick();
    payload.data.additionalActions[0]!.props.onClick();
    expect(open.mock.calls).toEqual([
      [{ id: "transfer", reveal: false }],
      [{ id: "transfer", reveal: true }],
    ]);
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    receive(state);
    expect(manager.add).toHaveBeenCalledTimes(1);
  });
  it("offers cancellation while active and retry only after failure", async () => {
    let receive!: (value: DesktopFileDownloadState) => void;
    const cancel = vi.fn().mockResolvedValue(undefined);
    const bridge = {
      onFileDownload: (callback: typeof receive) => {
        receive = callback;
        return () => {};
      },
      getFileDownloads: async () => [],
      cancelFileDownload: cancel,
      getFileDownloadRetryInput: vi.fn(),
    } as unknown as DesktopBridge;
    const dispose = observeDesktopDownloads(bridge);
    receive(state);
    manager.add.mock.calls[0]![0].actionProps.onClick();
    expect(cancel).toHaveBeenCalledWith("transfer");
    receive({ ...state, status: "failed", message: "Transfer interrupted" });
    const payload = manager.update.mock.calls[0]![1];
    expect(payload.actionProps.children).toBe("Retry");
    expect(payload.description).toBe("Transfer interrupted");
    expect(payload.data.additionalActions).toEqual([]);
    payload.actionProps.onClick();
    expect(retry).toHaveBeenCalledOnce();
    dispose();
  });
  it("keeps the persistent Retry action when restarting fails, then closes it on success", async () => {
    const bridge = {
      onFileDownload: () => () => {},
      getFileDownloads: async () => [{ ...state, status: "failed" as const }],
      getFileDownloadRetryInput: vi.fn(),
      acknowledgeFileDownload: vi.fn().mockResolvedValue(undefined),
    } as unknown as DesktopBridge;
    retry.mockRejectedValueOnce(new Error("Disconnected"));
    const dispose = observeDesktopDownloads(bridge);
    await Promise.resolve();
    const payload = manager.add.mock.calls[0]![0];
    payload.actionProps.onClick();
    await vi.waitFor(() => expect(manager.add).toHaveBeenCalledTimes(2));
    expect(manager.close).not.toHaveBeenCalled();
    expect(bridge.acknowledgeFileDownload).not.toHaveBeenCalled();
    payload.actionProps.onClick();
    await vi.waitFor(() => expect(manager.close).toHaveBeenCalledWith("toast-1"));
    expect(bridge.acknowledgeFileDownload).toHaveBeenCalledWith(state.id);
    dispose();
  });
});
