import type { DesktopBridge, DesktopFileDownloadState } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

type Payload = {
  title: string;
  description: unknown;
  actionProps: { children: string; onClick: () => void };
  data: { additionalActions: { props: { onClick: () => void } }[] };
};
const manager = vi.hoisted(() => ({
  add: vi.fn((_payload: Payload) => "toast-1"),
  update: vi.fn((_id: string, _payload: Payload) => {}),
  close: vi.fn(),
}));
vi.mock("./ui/toast", () => ({
  toastManager: manager,
  stackedThreadToast: (value: unknown) => value,
}));
import { downloadProgressLabel, observeDesktopDownloads } from "./DesktopDownloadNotifications";
import { registerDesktopDownloadRetry } from "../lib/desktopDownloadRetry";

const state: DesktopFileDownloadState = {
  id: "transfer",
  name: "report.pdf",
  status: "progressing",
  receivedBytes: 1024,
  totalBytes: 4096,
  message: null,
};
afterEach(() => vi.clearAllMocks());

describe("desktop download notifications", () => {
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
    const retry = vi.fn().mockResolvedValue(undefined);
    registerDesktopDownloadRetry(state.id, retry);
    const bridge = {
      onFileDownload: (callback: typeof receive) => {
        receive = callback;
        return () => {};
      },
      getFileDownloads: async () => [],
      cancelFileDownload: cancel,
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
});
