import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { downloadBlob, downloadUrl } from "./download";
import { getDesktopDownloadRetry } from "./desktopDownloadRetry";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("browser downloads", () => {
  it("renews signed attachment URLs when retrying a native download", async () => {
    const startFileDownload = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {
      location: { href: "t3://app/" },
      desktopBridge: { startFileDownload },
    });
    const resolveSource = vi
      .fn()
      .mockResolvedValue("https://remote.example/api/assets/report?signature=new");
    await downloadUrl(
      "https://remote.example/api/assets/report?signature=old",
      "Report.pdf",
      resolveSource,
    );
    const id = startFileDownload.mock.calls[0]![0].id;
    await getDesktopDownloadRetry(id)!();
    expect(resolveSource).toHaveBeenCalledOnce();
    expect(startFileDownload).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: "https://remote.example/api/assets/report?signature=new&download=1&downloadName=Report.pdf",
      }),
    );
    expect(startFileDownload.mock.calls[1]![0].id).not.toBe(id);
  });
  it("uses the native desktop downloader for signed remote assets", async () => {
    const startFileDownload = vi.fn().mockResolvedValue(undefined);
    const openExternal = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "t3://app/" },
      desktopBridge: { startFileDownload, openExternal },
    });
    vi.stubGlobal("fetch", fetch);
    await downloadUrl(
      "https://remote.example/api/assets/signed/report.pdf?signature=abc",
      "Report.pdf",
    );
    expect(startFileDownload).toHaveBeenCalledWith({
      id: expect.any(String),
      name: "Report.pdf",
      url: "https://remote.example/api/assets/signed/report.pdf?signature=abc&download=1&downloadName=Report.pdf",
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("hands a remote signed asset directly to the desktop browser without fetching bytes", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    const fetch = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "t3://app/" },
      desktopBridge: { openExternal },
    });
    vi.stubGlobal("fetch", fetch);
    await downloadUrl(
      "https://remote.example/api/assets/signed/report.pdf?existing=1",
      "report.pdf",
    );
    expect(openExternal).toHaveBeenCalledWith(
      "https://remote.example/api/assets/signed/report.pdf?existing=1&download=1&downloadName=report.pdf",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps third-party signatures unchanged", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("window", {
      location: { href: "t3://app/" },
      desktopBridge: { openExternal },
    });
    const url = "https://cdn.example/movie.mp4?signature=abc%2Fdef";
    await downloadUrl(url, "movie.mp4");
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it("reports a failed desktop handoff", async () => {
    vi.stubGlobal("window", {
      location: { href: "t3://app/" },
      desktopBridge: { openExternal: vi.fn().mockResolvedValue(false) },
    });
    await expect(downloadUrl("https://remote.example/file.zip", "file.zip")).rejects.toThrow(
      "Could not open the download",
    );
  });

  it("starts web downloads without fetching or navigating the running client", async () => {
    const anchor = { click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("window", { location: { href: "https://local.example/" } });
    vi.stubGlobal("document", {
      createElement: () => anchor,
      body: { append: vi.fn() },
    });
    await downloadUrl("/api/assets/signed/photo.png", "photo.png");
    expect(anchor).toMatchObject({
      href: "https://local.example/api/assets/signed/photo.png?download=1&downloadName=photo.png",
      download: "photo.png",
      target: "_blank",
    });
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
  });

  it("saves in-memory files locally and releases the object URL after handoff", async () => {
    vi.useFakeTimers();
    const openExternal = vi.fn();
    const anchor = { click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("window", {
      location: { href: "t3://app/" },
      desktopBridge: { openExternal },
    });
    vi.stubGlobal("document", { createElement: () => anchor, body: { append: vi.fn() } });
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    await downloadBlob(new Blob(["draft"]), "draft.txt");
    expect(openExternal).not.toHaveBeenCalled();
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledOnce();
  });
});
