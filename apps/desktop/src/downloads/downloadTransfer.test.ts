import * as NodeEvents from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";
import { trackDownloadTransfer } from "./downloadTransfer.ts";

class Transfer extends NodeEvents.EventEmitter {
  received = 0;
  total = 100;
  getReceivedBytes() {
    return this.received;
  }
  getTotalBytes() {
    return this.total;
  }
  getSavePath() {
    return "C:/Downloads/report.zip";
  }
  cancel() {
    this.emit("done", undefined, "cancelled");
  }
}

function setup() {
  const item = new Transfer();
  const publish = vi.fn();
  let now = 0;
  const dispose = trackDownloadTransfer({
    item,
    publish,
    now: () => now,
    initial: {
      id: "test",
      name: "report.zip",
      status: "preparing",
      receivedBytes: 0,
      totalBytes: null,
      message: null,
    },
  });
  return {
    item,
    publish,
    dispose,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("native file downloads", () => {
  it("does not claim completion when all bytes arrive before disk completion", () => {
    const { item, publish, advance } = setup();
    item.received = 100;
    advance(250);
    item.emit("updated", undefined, "progressing");
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "progressing", receivedBytes: 100 }),
      null,
    );
    item.emit("done", undefined, "completed");
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "completed" }),
      "C:/Downloads/report.zip",
    );
    expect(item.listenerCount("updated")).toBe(0);
    expect(item.listenerCount("done")).toBe(0);
  });
  it("limits progress traffic but always delivers the terminal event", () => {
    const { item, publish, advance } = setup();
    for (let index = 0; index < 100; index++) {
      item.received = index;
      advance(1);
      item.emit("updated", undefined, "progressing");
    }
    expect(publish).toHaveBeenCalledTimes(1);
    item.cancel();
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "cancelled", receivedBytes: 99 }),
      null,
    );
  });
  it("reports unknown totals without a fabricated percentage", () => {
    const { item, publish, advance } = setup();
    item.total = 0;
    item.received = 45;
    advance(250);
    item.emit("updated", undefined, "progressing");
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ totalBytes: null, receivedBytes: 45 }),
      null,
    );
  });
  it("reports interruptions as failure and never exposes a partial file as completed", () => {
    const { item, publish } = setup();
    item.emit("done", undefined, "interrupted");
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "failed", message: expect.any(String) }),
      null,
    );
  });
  it("stops an interrupted update and offers failure without waiting for a native terminal event", () => {
    const { item, publish } = setup();
    const cancel = vi.spyOn(item, "cancel");
    item.emit("updated", undefined, "interrupted");
    expect(cancel).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed" }), null);
    expect(item.listenerCount("updated")).toBe(0);
    expect(item.listenerCount("done")).toBe(0);
  });
  it("detaches listeners when its owner is disposed", () => {
    const { item, publish, dispose } = setup();
    dispose();
    item.emit("done", undefined, "completed");
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
