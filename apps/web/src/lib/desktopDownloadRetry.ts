const retries = new Map<string, () => Promise<void>>();

export function registerDesktopDownloadRetry(id: string, retry: () => Promise<void>) {
  retries.set(id, retry);
  if (retries.size > 50) retries.delete(retries.keys().next().value!);
}

export function getDesktopDownloadRetry(id: string) {
  return retries.get(id);
}
