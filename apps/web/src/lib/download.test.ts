import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { downloadBlob, downloadUrl } from "./download";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("browser downloads", () => {
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
