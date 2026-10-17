import * as NodeEvents from "node:events";
import { EnvironmentId, ChatAttachmentId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";

const shell = vi.hoisted(() => ({ openPath: vi.fn(async () => ""), showItemInFolder: vi.fn() }));
vi.mock("electron", () => ({ shell }));
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopDownloads from "./DesktopDownloads.ts";

class Item extends NodeEvents.EventEmitter {
  received = 0;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
  }
  getURLChain() {
    return [this.url];
  }
  getFilename() {
    return "walkthrough.mp4";
  }
  setSaveDialogOptions = vi.fn();
  getReceivedBytes() {
    return this.received;
  }
  getTotalBytes() {
    return 1024;
  }
  getSavePath() {
    return "C:/Downloads/report.bin";
  }
  canResume() {
    return false;
  }
  resume() {}
  cancel() {
    this.emit("done", undefined, "cancelled");
  }
}

function fixture(failFirstStart = false, deferDownload = false) {
  const session = new NodeEvents.EventEmitter();
  const items: Item[] = [];
  const owner = Object.assign(new NodeEvents.EventEmitter(), {
    id: 7,
    session,
    isDestroyed: () => false,
    send: vi.fn(),
    downloadURL: (url: string) => {
      if (failFirstStart) {
        failFirstStart = false;
        throw new Error("Could not start native transfer");
      }
      const item = new Item(url);
      items.push(item);
      if (!deferDownload) session.emit("will-download", undefined, item, owner);
    },
  });
  const window = {
    isDestroyed: () => false,
    webContents: owner,
  } as unknown as Electron.BrowserWindow;
  const main = Effect.succeed(Option.some(window));
  const layer = DesktopDownloads.layer.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main,
          currentMainOrFirst: main,
          focusedMainOrFirst: main,
          create: () => Effect.die("Unused"),
          setMain: () => Effect.void,
          clearMain: () => Effect.void,
          prepareReveal: () => Effect.succeed(true),
          reveal: () => Effect.void,
          sendAll: () => Effect.void,
          destroyAll: Effect.void,
          syncAllAppearance: () => Effect.void,
        }),
      ),
    ),
  );
  return {
    layer,
    items,
    owner,
    receive: (item: Item, source = owner) => session.emit("will-download", undefined, item, source),
    listenerCount: () => session.listenerCount("will-download"),
  };
}

describe("retained native downloads", () => {
  it.effect("tracks a video-control download before any managed download", () => {
    const { layer, receive, owner, listenerCount } = fixture();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    return Effect.gen(function* () {
      const downloads = yield* DesktopDownloads.DesktopDownloads;
      expect(yield* downloads.list(8)).toEqual([]);
      expect(listenerCount()).toBe(0);
      expect(yield* downloads.list(7)).toEqual([]);
      yield* downloads.list(7);
      expect(listenerCount()).toBe(1);
      const item = new Item("https://remote.example/api/assets/video?signature=valid");
      receive(item);
      receive(item);
      const active = yield* downloads.list(7);
      expect(active).toHaveLength(1);
      const id = active[0]!.id;
      expect(active[0]).toMatchObject({ name: "walkthrough.mp4", status: "progressing" });
      expect(item.setSaveDialogOptions).not.toHaveBeenCalled();
      item.received = 512;
      clock.mockReturnValue(250);
      item.emit("updated", undefined, "progressing");
      expect(owner.send).toHaveBeenLastCalledWith(
        IpcChannels.FILE_DOWNLOAD_EVENT_CHANNEL,
        expect.objectContaining({
          id,
          status: "progressing",
          receivedBytes: 512,
          totalBytes: 1024,
        }),
      );
      item.received = 1024;
      item.emit("done", undefined, "completed");
      expect(owner.send).toHaveBeenLastCalledWith(
        IpcChannels.FILE_DOWNLOAD_EVENT_CHANNEL,
        expect.objectContaining({ id, status: "completed", receivedBytes: 1024 }),
      );
      yield* downloads.acknowledge(id, 7);
      expect(yield* downloads.list(7)).toEqual([]);
      yield* downloads.open(id, true, 7);
      expect(shell.showItemInFolder).toHaveBeenCalledWith("C:/Downloads/report.bin");
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => clock.mockRestore())));
  });
  it.effect("keeps native download failures retryable through the managed path", () => {
    const { layer, receive, items } = fixture();
    return Effect.gen(function* () {
      const downloads = yield* DesktopDownloads.DesktopDownloads;
      yield* downloads.list(7);
      const url = "https://remote.example/api/assets/video?signature=valid";
      const item = new Item(url);
      receive(item);
      item.emit("done", undefined, "interrupted");
      const failed = yield* downloads.list(7);
      expect(failed).toMatchObject([{ status: "failed" }]);
      const id = failed[0]!.id;
      expect(yield* downloads.retryInput(id, 8).pipe(Effect.isFailure)).toBe(true);
      const input = yield* downloads.retryInput(id, 7);
      expect(input).toEqual({ id, url, name: "walkthrough.mp4" });
      yield* downloads.start({ ...input, id: "retry" }, 7);
      expect(items).toHaveLength(1);
      expect(yield* downloads.list(7)).toContainEqual(
        expect.objectContaining({ id: "retry", status: "progressing" }),
      );
    }).pipe(Effect.provide(layer));
  });
  it.effect(
    "ignores other contents and local exports while tracking distinct native transfers",
    () => {
      const { layer, receive, owner } = fixture();
      return Effect.gen(function* () {
        const downloads = yield* DesktopDownloads.DesktopDownloads;
        yield* downloads.list(7);
        receive(new Item("https://files.example/other"), { ...owner, id: 8 });
        receive(new Item("blob:https://app.t3.codes/file"));
        receive(new Item("data:text/plain,export"));
        expect(yield* downloads.list(7)).toEqual([]);
        const first = new Item("https://files.example/video");
        const second = new Item(first.url);
        receive(first);
        receive(second);
        const active = yield* downloads.list(7);
        expect(active).toHaveLength(2);
        expect(active[0]!.id).not.toBe(active[1]!.id);
        expect(yield* downloads.cancel(active[0]!.id, 8).pipe(Effect.isFailure)).toBe(true);
        yield* downloads.cancel(active[0]!.id, 7);
        expect(yield* downloads.list(7)).toMatchObject([
          { status: "cancelled" },
          { status: "progressing" },
        ]);
        owner.emit("destroyed");
        expect(second.listenerCount("updated")).toBe(0);
        expect(owner.session.listenerCount("will-download")).toBe(0);
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect("a cancelled preparation cannot consume a new transfer of the same URL", () => {
    const { layer, items, receive } = fixture(false, true);
    return Effect.gen(function* () {
      const downloads = yield* DesktopDownloads.DesktopDownloads;
      const url = "https://files.example/report";
      yield* downloads.start({ id: "cancelled", url, name: "report.bin" }, 7);
      yield* downloads.cancel("cancelled", 7);
      yield* downloads.start({ id: "active", url, name: "report.bin" }, 7);
      const lateCancel = vi.spyOn(items[0]!, "cancel");
      receive(items[0]!);
      expect(lateCancel).toHaveBeenCalledOnce();
      const activeCancel = vi.spyOn(items[1]!, "cancel");
      receive(items[1]!);
      expect(activeCancel).not.toHaveBeenCalled();
      expect(yield* downloads.list(7)).toContainEqual(
        expect.objectContaining({ id: "active", status: "progressing" }),
      );
    }).pipe(Effect.provide(layer));
  });
  it.effect(
    "cancelled preparations release active slots and still cancel late native items",
    () => {
      const { layer, items, receive, listenerCount } = fixture(false, true);
      return Effect.gen(function* () {
        const downloads = yield* DesktopDownloads.DesktopDownloads;
        for (let index = 0; index < 80; index++) {
          yield* downloads.start(
            { id: `cancelled-${index}`, url: `https://files.example/${index}`, name: "report.bin" },
            7,
          );
          yield* downloads.cancel(`cancelled-${index}`, 7);
          yield* downloads.acknowledge(`cancelled-${index}`, 7);
        }
        yield* downloads.start(
          { id: "active", url: "https://files.example/new", name: "new.bin" },
          7,
        );
        const cancel = vi.spyOn(items[0]!, "cancel");
        expect(listenerCount()).toBe(1);
        receive(items[0]!);
        expect(cancel).toHaveBeenCalledOnce();
        const blob = new Item("blob:https://app.t3.codes/file");
        const blobCancel = vi.spyOn(blob, "cancel");
        receive(blob);
        expect(blobCancel).not.toHaveBeenCalled();
        const rendererItem = new Item("https://files.example/renderer");
        const rendererCancel = vi.spyOn(rendererItem, "cancel");
        receive(rendererItem);
        expect(rendererCancel).not.toHaveBeenCalled();
        receive(items[80]!);
        expect(yield* downloads.list(7)).toContainEqual(
          expect.objectContaining({ id: "active", status: "progressing" }),
        );
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect("keeps retry metadata when native startup throws", () => {
    const { layer, items } = fixture(true);
    return Effect.gen(function* () {
      const downloads = yield* DesktopDownloads.DesktopDownloads;
      const input = { id: "failed-start", url: "https://files.example/report", name: "report.bin" };
      yield* downloads.start(input, 7);
      expect(yield* downloads.list(7)).toMatchObject([{ id: input.id, status: "failed" }]);
      expect(yield* downloads.retryInput(input.id, 8).pipe(Effect.isFailure)).toBe(true);
      const retained = yield* downloads.retryInput(input.id, 7);
      yield* downloads.start({ ...retained, id: "restarted" }, 7);
      expect(items).toHaveLength(1);
      expect(yield* downloads.list(7)).toMatchObject([
        { id: "failed-start", status: "failed" },
        { id: "restarted", status: "progressing" },
      ]);
    }).pipe(Effect.provide(layer));
  });
  it.effect(
    "keeps persistent failure Retry actions through more than 50 terminal transfers",
    () => {
      const { layer, items } = fixture();
      return Effect.gen(function* () {
        const downloads = yield* DesktopDownloads.DesktopDownloads;
        for (let index = 0; index < 60; index++) {
          yield* downloads.start(
            { id: `failed-${index}`, url: `https://files.example/${index}`, name: "report.bin" },
            7,
          );
          items[index]!.emit("done", undefined, "interrupted");
        }
        expect(yield* downloads.retryInput("failed-0", 7)).toMatchObject({ id: "failed-0" });
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect("protects recent completed actions before pruning acknowledged history", () => {
    const { layer, items } = fixture();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    return Effect.gen(function* () {
      const downloads = yield* DesktopDownloads.DesktopDownloads;
      for (let index = 0; index < 60; index++) {
        yield* downloads.start(
          { id: `completed-${index}`, url: `https://files.example/${index}`, name: "report.bin" },
          7,
        );
        items[index]!.emit("done", undefined, "completed");
        yield* downloads.acknowledge(`completed-${index}`, 7);
      }
      yield* downloads.open("completed-0", true, 7);
      clock.mockReturnValue(120_000);
      yield* downloads.start(
        { id: "new", url: "https://files.example/new", name: "report.bin" },
        7,
      );
      items[60]!.emit("done", undefined, "completed");
      expect(yield* downloads.open("completed-0", true, 7).pipe(Effect.isFailure)).toBe(true);
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => clock.mockRestore())));
  });
  it.effect(
    "recovers a missed completion once and keeps its saved-file actions after acknowledgement",
    () => {
      const { layer, items } = fixture();
      return Effect.gen(function* () {
        const downloads = yield* DesktopDownloads.DesktopDownloads;
        yield* downloads.start(
          { id: "one", url: "https://files.example/report", name: "report.bin" },
          7,
        );
        items[0]!.received = 1024;
        items[0]!.emit("done", undefined, "completed");
        expect(yield* downloads.list(7)).toMatchObject([{ id: "one", status: "completed" }]);
        expect(yield* downloads.list(8)).toEqual([]);
        yield* downloads.acknowledge("one", 7);
        expect(yield* downloads.list(7)).toEqual([]);
        yield* downloads.open("one", true, 7);
        expect(shell.showItemInFolder).toHaveBeenCalledWith("C:/Downloads/report.bin");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("retains the asset source for renewal after reload and checks ownership", () => {
    const { layer, items } = fixture();
    return Effect.gen(function* () {
      const downloads = yield* DesktopDownloads.DesktopDownloads;
      const source = {
        environmentId: EnvironmentId.make("remote"),
        resource: { _tag: "attachment" as const, attachmentId: ChatAttachmentId.make("report") },
      };
      yield* downloads.start(
        {
          id: "old",
          url: "https://files.example/report?signature=expired",
          name: "report.bin",
          source,
        },
        7,
      );
      expect(yield* downloads.retryInput("old", 7).pipe(Effect.isFailure)).toBe(true);
      items[0]!.emit("done", undefined, "interrupted");
      expect(yield* downloads.list(7)).toMatchObject([{ id: "old", status: "failed" }]);
      expect(yield* downloads.retryInput("old", 8).pipe(Effect.isFailure)).toBe(true);
      const input = yield* downloads.retryInput("old", 7);
      expect(input.source).toEqual(source);
      yield* downloads.start(
        { ...input, id: "new", url: "https://files.example/report?signature=fresh" },
        7,
      );
      yield* downloads.acknowledge("old", 7);
      const restored = yield* downloads.list(7);
      expect(restored).toMatchObject([{ name: "report.bin", status: "progressing" }]);
      expect(restored[0]!.id).not.toBe("old");
      expect(
        items.map((item) => {
          const url = new URL(item.url);
          url.hash = "";
          return url.href;
        }),
      ).toEqual([
        "https://files.example/report?signature=expired",
        "https://files.example/report?signature=fresh",
      ]);
    }).pipe(Effect.provide(layer));
  });
});
