import { type DesktopFileDownloadInput, type DesktopFileDownloadState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import { trackDownloadTransfer } from "./downloadTransfer.ts";

export class DesktopDownloadError extends Schema.TaggedError<DesktopDownloadError>()(
  "DesktopDownloadError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export class DesktopDownloads extends Context.Service<
  DesktopDownloads,
  {
    readonly start: (
      input: DesktopFileDownloadInput,
      senderId: number,
    ) => Effect.Effect<void, DesktopDownloadError>;
    readonly cancel: (id: string, senderId: number) => Effect.Effect<void, DesktopDownloadError>;
    readonly retryInput: (
      id: string,
      senderId: number,
    ) => Effect.Effect<DesktopFileDownloadInput, DesktopDownloadError>;
    readonly acknowledge: (
      id: string,
      senderId: number,
    ) => Effect.Effect<void, DesktopDownloadError>;
    readonly open: (
      id: string,
      reveal: boolean,
      senderId: number,
    ) => Effect.Effect<void, DesktopDownloadError>;
    readonly list: (senderId: number) => Effect.Effect<readonly DesktopFileDownloadState[]>;
  }
>()("@t3tools/desktop/downloads/DesktopDownloads") {}

export const layer = Layer.effect(
  DesktopDownloads,
  Effect.gen(function* () {
    const windows = yield* ElectronWindow.ElectronWindow;
    const entries = new Map<
      string,
      {
        owner: Electron.WebContents;
        state: DesktopFileDownloadState;
        item: Electron.DownloadItem | null;
        savePath: string | null;
        input: DesktopFileDownloadInput;
        terminalPresented: boolean;
        cleanup: () => void;
      }
    >();
    const claimed = new WeakSet<Electron.DownloadItem>();
    const watchedOwners = new WeakSet<Electron.WebContents>();
    const owned = (id: string, senderId: number) => {
      const entry = entries.get(id);
      if (!entry || entry.owner.id !== senderId) throw new Error("Download not found.");
      return entry;
    };
    const attempt = <A>(operation: () => A) =>
      Effect.try({
        try: operation,
        catch: (cause) =>
          new DesktopDownloadError({
            message: cause instanceof Error ? cause.message : "Download failed.",
            cause,
          }),
      });
    const publish = (entry: ReturnType<typeof owned>, state: DesktopFileDownloadState) => {
      entry.state = state;
      if (!entry.owner.isDestroyed())
        entry.owner.send(IpcChannels.FILE_DOWNLOAD_EVENT_CHANNEL, state);
      // Keep recent completions for reloads and Open file, without retaining every past download.
      const terminal = [...entries.values()].filter((value) =>
        ["completed", "cancelled", "failed"].includes(value.state.status),
      );
      for (const previous of terminal
        .filter((value) => value.item !== null || value.state.status === "failed")
        .slice(0, -50)) {
        previous.cleanup();
        entries.delete(previous.state.id);
      }
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const entry of entries.values()) {
          entry.cleanup();
          if (entry.state.status === "progressing") entry.item?.cancel();
        }
        entries.clear();
      }),
    );
    const start = Effect.fn("desktop.downloads.start")(function* (
      input: DesktopFileDownloadInput,
      senderId: number,
    ) {
      const window = yield* windows.main;
      if (
        Option.isNone(window) ||
        window.value.isDestroyed() ||
        window.value.webContents.id !== senderId
      ) {
        return yield* new DesktopDownloadError({
          message: "The application window is unavailable.",
        });
      }
      const owner = window.value.webContents;
      if (!watchedOwners.has(owner)) {
        watchedOwners.add(owner);
        owner.once("destroyed", () => {
          for (const [id, entry] of entries) {
            if (entry.owner !== owner) continue;
            entry.cleanup();
            if (entry.state.status === "progressing") entry.item?.cancel();
            entries.delete(id);
          }
        });
      }
      yield* attempt(() => {
        const url = new URL(input.url);
        url.hash = "";
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
          throw new Error("Only HTTP and HTTPS files can be downloaded.");
        }
        if (entries.has(input.id)) throw new Error("This download already exists.");
        if (
          [...entries.values()].filter(
            (entry) => entry.state.status === "preparing" || entry.state.status === "progressing",
          ).length >= 20
        ) {
          throw new Error("Wait for a download to finish before starting another.");
        }
        // oxlint-disable-next-line no-control-regex -- A save-dialog filename cannot contain control characters.
        const name = input.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
        const state: DesktopFileDownloadState = {
          id: input.id,
          name: name === "." || name === ".." ? "download" : name,
          status: "preparing",
          receivedBytes: 0,
          totalBytes: null,
          message: null,
        };
        const entry: ReturnType<typeof owned> = {
          owner,
          state,
          item: null,
          savePath: null,
          input: { ...input, url: url.href, name: state.name },
          terminalPresented: false,
          cleanup: () => {},
        };
        const receive = (
          _event: Electron.Event,
          item: Electron.DownloadItem,
          source: Electron.WebContents,
        ) => {
          if (source?.id !== owner.id || item.getURLChain()[0] !== url.href || claimed.has(item))
            return;
          claimed.add(item);
          entry.cleanup();
          entry.item = item;
          if (entry.state.status === "cancelled" || entry.state.status === "failed") {
            item.cancel();
            return;
          }
          item.setSaveDialogOptions({ defaultPath: state.name });
          entry.cleanup = trackDownloadTransfer({
            item,
            initial: state,
            now: () => performance.now(),
            publish: (next, savePath) => {
              entry.savePath = savePath;
              publish(entry, next);
            },
          });
        };
        entry.cleanup = () => {
          owner.session.removeListener("will-download", receive);
        };
        entries.set(input.id, entry);
        owner.session.on("will-download", receive);
        publish(entry, state);
        try {
          owner.downloadURL(url.href);
        } catch {
          entry.cleanup();
          publish(entry, {
            ...state,
            status: "failed",
            message: "Could not start the download.",
          });
          // The retained transfer reports the failure; accepting the command lets Retry replace its old toast.
        }
      });
    });
    return DesktopDownloads.of({
      start,
      retryInput: Effect.fn("desktop.downloads.retryInput")(function* (id, senderId) {
        const entry = yield* attempt(() => owned(id, senderId));
        if (entry.state.status !== "failed") {
          return yield* new DesktopDownloadError({
            message: "Only failed downloads can be retried.",
          });
        }
        // The renderer renews environment asset capabilities using its current connection.
        return entry.input;
      }),
      acknowledge: (id, senderId) =>
        attempt(() => {
          const entry = owned(id, senderId);
          if (["completed", "cancelled", "failed"].includes(entry.state.status))
            entry.terminalPresented = true;
        }),
      cancel: (id, senderId) =>
        attempt(() => {
          const entry = owned(id, senderId);
          if (entry.state.status !== "preparing" && entry.state.status !== "progressing") return;
          if (entry.item) entry.item.cancel();
          else publish(entry, { ...entry.state, status: "cancelled" });
        }),
      open: Effect.fn("desktop.downloads.open")(function* (id, reveal, senderId) {
        const entry = yield* attempt(() => owned(id, senderId));
        if (entry.state.status !== "completed" || !entry.savePath) {
          return yield* new DesktopDownloadError({
            message: "The file has not finished downloading.",
          });
        }
        if (reveal) yield* attempt(() => Electron.shell.showItemInFolder(entry.savePath!));
        else {
          const error = yield* Effect.tryPromise({
            try: () => Electron.shell.openPath(entry.savePath!),
            catch: (cause) =>
              new DesktopDownloadError({ message: "Could not open the downloaded file.", cause }),
          });
          if (error) return yield* new DesktopDownloadError({ message: error });
        }
      }),
      list: (senderId) =>
        Effect.sync(() =>
          [...entries.values()]
            // Recover terminal events missed during reload without replaying notifications already shown.
            .filter((entry) => entry.owner.id === senderId && !entry.terminalPresented)
            .map((entry) => entry.state),
        ),
    });
  }),
);
