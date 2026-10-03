import { DesktopFileDownloadInputSchema, DesktopFileDownloadStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopDownloads from "../../downloads/DesktopDownloads.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export const startFileDownload = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FILE_DOWNLOAD_START_CHANNEL,
  payload: DesktopFileDownloadInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.downloads.start")(function* (input, event) {
    const downloads = yield* DesktopDownloads.DesktopDownloads;
    return yield* downloads.start(input, event?.sender.id ?? -1);
  }),
});
export const cancelFileDownload = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FILE_DOWNLOAD_CANCEL_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.downloads.cancel")(function* (id, event) {
    const downloads = yield* DesktopDownloads.DesktopDownloads;
    return yield* downloads.cancel(id, event?.sender.id ?? -1);
  }),
});
export const openDownloadedFile = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FILE_DOWNLOAD_OPEN_CHANNEL,
  payload: Schema.Struct({ id: Schema.String, reveal: Schema.Boolean }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.downloads.open")(function* (input, event) {
    const downloads = yield* DesktopDownloads.DesktopDownloads;
    return yield* downloads.open(input.id, input.reveal, event?.sender.id ?? -1);
  }),
});
export const retryFileDownload = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FILE_DOWNLOAD_RETRY_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.downloads.retry")(function* (id, event) {
    const downloads = yield* DesktopDownloads.DesktopDownloads;
    return yield* downloads.retry(id, event?.sender.id ?? -1);
  }),
});
export const acknowledgeFileDownload = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FILE_DOWNLOAD_ACKNOWLEDGE_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.downloads.acknowledge")(function* (id, event) {
    const downloads = yield* DesktopDownloads.DesktopDownloads;
    return yield* downloads.acknowledge(id, event?.sender.id ?? -1);
  }),
});
export const getFileDownloads = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.FILE_DOWNLOAD_LIST_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopFileDownloadStateSchema),
  handler: Effect.fn("desktop.ipc.downloads.list")(function* (_input, event) {
    const downloads = yield* DesktopDownloads.DesktopDownloads;
    return yield* downloads.list(event?.sender.id ?? -1);
  }),
});
