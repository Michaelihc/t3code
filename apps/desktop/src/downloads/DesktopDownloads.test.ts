import * as NodeEvents from "node:events";
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
  cancel() {
    this.emit("done", undefined, "cancelled");
  }
}

function fixture() {
  const session = new NodeEvents.EventEmitter();
  const items: Item[] = [];
  const owner = Object.assign(new NodeEvents.EventEmitter(), {
    id: 7,
    session,
    isDestroyed: () => false,
    send: vi.fn(),
    downloadURL: (url: string) => {
      const item = new Item(url);
      items.push(item);
      session.emit("will-download", undefined, item, owner);
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
  return { layer, items };
}

describe("retained native downloads", () => {
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

  it.effect("retries a retained failure without renderer metadata and checks ownership", () => {
    const { layer, items } = fixture();
    return Effect.gen(function* () {
      const downloads = yield* DesktopDownloads.DesktopDownloads;
      yield* downloads.start(
        { id: "old", url: "https://files.example/report", name: "report.bin" },
        7,
      );
      items[0]!.emit("done", undefined, "interrupted");
      expect(yield* downloads.list(7)).toMatchObject([{ id: "old", status: "failed" }]);
      expect(yield* downloads.retry("old", 8).pipe(Effect.isFailure)).toBe(true);
      yield* downloads.acknowledge("old", 7);
      yield* downloads.retry("old", 7);
      const restored = yield* downloads.list(7);
      expect(restored).toMatchObject([{ name: "report.bin", status: "progressing" }]);
      expect(restored[0]!.id).not.toBe("old");
      expect(items.map((item) => item.url)).toEqual([
        "https://files.example/report",
        "https://files.example/report",
      ]);
    }).pipe(Effect.provide(layer));
  });
});
