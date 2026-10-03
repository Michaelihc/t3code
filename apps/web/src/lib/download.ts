/** Hands transfers to the browser instead of buffering the file in the renderer. */
export async function downloadUrl(src: string, name: string): Promise<void> {
  const url = new URL(src, window.location.href);
  const isWeb = url.protocol === "http:" || url.protocol === "https:";
  if (!isWeb && url.protocol !== "blob:" && url.protocol !== "data:") {
    throw new Error("This file cannot be downloaded in the browser.");
  }
  // Signed assets authorize the bytes independently of the browser's login.
  // The flag changes only disposition, preserving the signature and remote origin.
  if (isWeb && url.pathname.startsWith("/api/assets/")) {
    url.searchParams.set("download", "1");
    url.searchParams.set("downloadName", name);
  }
  if (isWeb && window.desktopBridge) {
    if (!(await window.desktopBridge.openExternal(url.href))) {
      throw new Error("Could not open the download in your browser.");
    }
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = url.href;
  anchor.download = name;
  // Cross-origin servers decide whether to download or show their file. Keep
  // that navigation out of the running client if they return inline content.
  if (isWeb) anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

/** Local drafts and generated exports already have all their bytes. */
export async function downloadBlob(blob: Blob, name: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    await downloadUrl(url, name);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
