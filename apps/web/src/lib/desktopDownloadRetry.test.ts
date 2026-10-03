import { ChatAttachmentId, EnvironmentId, type DesktopBridge } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const renew = vi.hoisted(() => vi.fn());
vi.mock("./renewDesktopDownloadSource", () => ({ renewDesktopDownloadSource: renew }));
import { retryDesktopDownload } from "./desktopDownloadRetry";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("retained desktop download retries", () => {
  it("renews an expired capability from native metadata without any renderer callbacks", async () => {
    const source = {
      environmentId: EnvironmentId.make("remote"),
      resource: { _tag: "attachment" as const, attachmentId: ChatAttachmentId.make("report") },
    };
    const bridge = {
      getFileDownloadRetryInput: vi.fn().mockResolvedValue({
        id: "failed",
        name: "report.pdf",
        source,
        url: "https://old.example/api/assets/report?signature=expired",
      }),
      startFileDownload: vi.fn().mockResolvedValue(undefined),
    } as unknown as DesktopBridge;
    vi.stubGlobal("window", { location: { href: "t3://app/" }, desktopBridge: bridge });
    renew.mockResolvedValue("https://reconnected.example/api/assets/report?signature=fresh");
    await retryDesktopDownload(bridge, "failed");
    expect(renew).toHaveBeenCalledWith(source);
    expect(bridge.startFileDownload).toHaveBeenCalledWith({
      id: expect.any(String),
      name: "report.pdf",
      source,
      url: "https://reconnected.example/api/assets/report?signature=fresh&download=1&downloadName=report.pdf",
    });
  });
  it("does not start the stale transfer when URL renewal fails", async () => {
    const bridge = {
      getFileDownloadRetryInput: vi.fn().mockResolvedValue({
        id: "failed",
        name: "report.pdf",
        url: "https://old.example/report",
        source: {
          environmentId: "offline",
          resource: { _tag: "attachment", attachmentId: "report" },
        },
      }),
      startFileDownload: vi.fn(),
    } as unknown as DesktopBridge;
    vi.stubGlobal("window", { location: { href: "t3://app/" }, desktopBridge: bridge });
    renew.mockRejectedValue(new Error("Reconnect"));
    await expect(retryDesktopDownload(bridge, "failed")).rejects.toThrow("Reconnect");
    expect(bridge.startFileDownload).not.toHaveBeenCalled();
  });
  it("retries external files using their original URL", async () => {
    const bridge = {
      getFileDownloadRetryInput: vi
        .fn()
        .mockResolvedValue({ id: "old", name: "report.bin", url: "https://files.example/report" }),
      startFileDownload: vi.fn().mockResolvedValue(undefined),
    } as unknown as DesktopBridge;
    vi.stubGlobal("window", { location: { href: "t3://app/" }, desktopBridge: bridge });
    await retryDesktopDownload(bridge, "old");
    expect(renew).not.toHaveBeenCalled();
    expect(bridge.startFileDownload).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://files.example/report" }),
    );
  });
});
