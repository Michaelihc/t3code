import type { DesktopBridge } from "@t3tools/contracts";
import { downloadUrl } from "./download";

/** Native metadata survives reload; signed assets are renewed through the current environment. */
export async function retryDesktopDownload(bridge: DesktopBridge, id: string) {
  const input = await bridge.getFileDownloadRetryInput!(id);
  const url = input.source
    ? await (await import("./renewDesktopDownloadSource")).renewDesktopDownloadSource(input.source)
    : input.url;
  await downloadUrl(url, input.name, input.source);
}
