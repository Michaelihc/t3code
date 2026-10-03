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
  session.setMaxListeners(0);
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
    receive: (item: Item) => session.emit("will-download", undefined, item, owner),
  };
}

describe("retained native downloads", () => {
  it.effect(
    "cancelled preparations release active slots and still cancel late native items",
    () => {
      const { layer, items, receive } = fixture(false, true);
      return Effect.gen(function* () {
        const downloads = yield* DesktopDownloads.DesktopDownloads;
        for (let index = 0; index < 20; index++) {
          yield* downloads.start(
            { id: `cancelled-${index}`, url: `https://files.example/${index}`, name: "report.bin" },
            7,
          );
          yield* downloads.cancel(`cancelled-${index}`, 7);
        }
        yield* downloads.start(
          { id: "active", url: "https://files.example/new", name: "new.bin" },
          7,
        );
        const cancel = vi.spyOn(items[0]!, "cancel");
        receive(items[0]!);
        expect(cancel).toHaveBeenCalledOnce();
        receive(items[20]!);
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
      expect(items.map((item) => item.url)).toEqual([
        "https://files.example/report?signature=expired",
        "https://files.example/report?signature=fresh",
      ]);
    }).pipe(Effect.provide(layer));
  });
});
