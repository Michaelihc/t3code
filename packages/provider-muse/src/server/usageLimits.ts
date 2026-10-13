import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

const Timestamp = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(8_640_000_000_000_000),
);
const Window = Schema.Struct({
  usedPercent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  resetsAtMs: Timestamp,
});
const SubscriptionUsage = Schema.Struct({
  observedAtMs: Timestamp,
  weekly: Window,
  window: Schema.Struct({
    ...Window.fields,
    windowDurationMins: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
});
const decodeSubscriptionUsage = Schema.decodeUnknownEffect(SubscriptionUsage);

/** Muse reports host-wide observations, without a session id. */
export const decodeMuseUsageLimits = Effect.fn("decodeMuseUsageLimits")(function* (data: unknown) {
  const usage = yield* decodeSubscriptionUsage(data);
  return {
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(usage.observedAtMs)),
    windows: [
      {
        id: "window",
        kind: "session",
        label: "Session",
        usedPercent: Math.min(100, usage.window.usedPercent),
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(usage.window.resetsAtMs)),
        windowDurationMins: usage.window.windowDurationMins,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: Math.min(100, usage.weekly.usedPercent),
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(usage.weekly.resetsAtMs)),
        windowDurationMins: 10_080,
      },
    ],
  } satisfies ServerProviderUsageLimits;
});
