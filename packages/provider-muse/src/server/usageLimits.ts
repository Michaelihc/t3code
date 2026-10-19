/**
 * Muse Code's subscription usage limits. Meta reports the account's windows
 * with every model response, and Muse forwards them as `usage/changed`. When a
 * window runs out, Meta refuses the next request and Muse fails the turn.
 */
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { LATEST_DATE_MS, MuseSubscriptionUsage } from "./protocol.ts";

/**
 * Muse surfaces Meta's quota refusal as `API error 429: Subscription quota
 * exhausted. Your usage window resets at 2026-10-13T10:45:52Z.`, at times
 * wrapped by a credential proxy. Muse can also type the stop as `error.quota`,
 * but a relayed refusal arrives untyped, so the text still counts.
 */
export function isMuseUsageLimitFailure(message: string | undefined): boolean {
  return message !== undefined && /\b429\b/.test(message) && /quota|usage limit/i.test(message);
}

const NAMED_RESET =
  /\bresets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i;

/**
 * When a stopped turn can run again: every exhausted window must reset first.
 * The resets come from the typed quota, the time the refusal names, and the
 * used-up windows of the last report before it; the latest one still ahead wins.
 */
export function museUsageLimitResetAt(
  usage: MuseSubscriptionUsage | undefined,
  nowMs: number,
  refusal?: {
    readonly quota?: { readonly resetsAtMs: number } | undefined;
    readonly message?: string | undefined;
  },
): string | null {
  const named = refusal?.message?.match(NAMED_RESET)?.[1];
  const resets = [
    ...[usage?.window, usage?.weekly].map((window) =>
      window && window.usedPercent >= 100 ? window.resetsAtMs : undefined,
    ),
    refusal?.quota?.resetsAtMs,
    named === undefined ? undefined : Date.parse(named),
  ].filter(
    (ms): ms is number =>
      ms !== undefined && Number.isFinite(ms) && ms > nowMs && ms <= LATEST_DATE_MS,
  );
  return resets.length > 0 ? DateTime.formatIso(DateTime.makeUnsafe(Math.max(...resets))) : null;
}

const decodeSubscriptionUsage = Schema.decodeUnknownEffect(
  Schema.Struct({
    observedAtMs: Schema.Finite.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(LATEST_DATE_MS),
    ),
    window: MuseSubscriptionUsage.fields.window,
    weekly: MuseSubscriptionUsage.fields.weekly,
  }),
);

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
