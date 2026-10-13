import { describe, expect, it } from "@effect/vitest";
import { MuseSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

import type { MuseSdkHost } from "./sdk.ts";
import {
  discoverMuseMetadata,
  museModelCapabilities,
  resolveMuseReasoningEffort,
} from "./modelCatalog.ts";

const settings = Schema.decodeSync(MuseSettings)({});
const host = (
  catalog: Record<string, unknown>,
  usage: Record<string, unknown> = {},
): MuseSdkHost => ({
  connection: {
    request: async (method) => (method === "usage/read" ? usage : catalog),
    command: async () => ({}),
    mintCommandId: () => "test",
    onNotification: () => {},
    onServerRequest: () => {},
    onProtocolError: () => {},
    closed: new Promise<void>(() => {}),
  },
  initializeResult: { grantedCapabilities: [] },
  exited: new Promise(() => {}),
  close: async () => {},
});

const row = (modelId: string, extra: Record<string, unknown> = {}) => ({
  modelId,
  displayLabel: modelId,
  providerId: "meta",
  profileId: "tbh",
  isDefault: false,
  contextLimit: 1_000_000,
  ...extra,
});

describe("Muse model catalog", () => {
  it.effect(
    "carries valid USD catalog prices without inventing prices for unknown currencies",
    () =>
      Effect.gen(function* () {
        const cost = { input: "2.50", output: "10", cached: "0.25", currency: "USD" };
        const { models, usageLimits } = yield* discoverMuseMetadata(
          settings,
          {},
          undefined,
          async () =>
            host(
              {
                providerId: "meta",
                models: [
                  row("priced", { cost }),
                  row("free", { cost: { ...cost, input: "0", output: "0", cached: "0" } }),
                  row("unknown-currency", { cost: { ...cost, currency: null } }),
                  row("foreign-currency", { cost: { ...cost, currency: "EUR" } }),
                  row("invalid", { cost: { ...cost, input: "" } }),
                  row("overflow", { cost: { ...cost, input: "9".repeat(400) } }),
                ],
              },
              {
                usage: {
                  observedAtMs: 1_800_000_000_000,
                  tier: "pro",
                  window: {
                    usedPercent: 41,
                    resetsAtMs: 1_800_001_000_000,
                    windowDurationMins: 300,
                  },
                  weekly: { usedPercent: 113, resetsAtMs: 1_800_010_000_000 },
                },
              },
            ),
        ).pipe(Effect.scoped);
        expect(models[0]?.tokenPrices).toEqual({
          inputCostPerMillionTokens: 2.5,
          outputCostPerMillionTokens: 10,
          cacheReadCostPerMillionTokens: 0.25,
        });
        expect(models[1]?.tokenPrices?.inputCostPerMillionTokens).toBe(0);
        expect(models.slice(2).every((model) => model.tokenPrices === undefined)).toBe(true);
        expect(usageLimits.checkedAt).toBe(
          DateTime.formatIso(DateTime.makeUnsafe(1_800_000_000_000)),
        );
        expect(usageLimits.windows.map((window) => window.usedPercent)).toEqual([41, 100]);
        expect(usageLimits.windows[0]?.windowDurationMins).toBe(300);
      }),
  );

  it.effect("keeps models available when an older host rejects usage/read", () =>
    Effect.gen(function* () {
      const sdk = host({ providerId: "meta", models: [row("available")] });
      const request = sdk.connection.request;
      sdk.connection.request = async (method, params) => {
        if (method === "usage/read") throw new Error("unsupported");
        return request(method, params);
      };
      const result = yield* discoverMuseMetadata(settings, {}, undefined, async () => sdk).pipe(
        Effect.scoped,
      );
      expect(result.models[0]?.slug).toBe("available");
      expect(result.usageLimits).toMatchObject({
        windows: [],
        unavailable: { reason: "probeFailed" },
      });
    }),
  );
  it.effect("uses the labels, efforts and defaults that model/list sends", () =>
    Effect.gen(function* () {
      const { models } = yield* discoverMuseMetadata(settings, {}, undefined, async () =>
        host({
          providerId: "meta",
          profileId: "tbh",
          source: "providerCatalog",
          models: [
            row("restful-walrus", {
              displayLabel: " Restful Walrus ",
              isDefault: true,
              variants: ["minimal", "low", "high", "future-tier"],
              reasoningEffortVariants: [{ tier: "low", description: "Quick" }],
              defaultReasoningEffort: "high",
            }),
            row("older-host"),
            row("unknown-efforts", { variants: "unknown" }),
            row("foreign", { providerId: "another" }),
          ],
        }),
      ).pipe(Effect.scoped);
      expect(models.map(({ slug, name, isDefault }) => [slug, name, isDefault])).toEqual([
        ["restful-walrus", "Restful Walrus", true],
        ["older-host", "older-host", false],
        ["unknown-efforts", "unknown-efforts", false],
      ]);
      expect(models[0]?.capabilities?.optionDescriptors).toEqual([
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "high",
          options: [
            { id: "minimal", label: "Minimal" },
            { id: "low", label: "Low", description: "Quick" },
            { id: "high", label: "High", isDefault: true },
          ],
        },
      ]);
      // Older hosts and "unknown" fall back to Muse's documented tiers.
      expect(models[1]?.capabilities).toEqual(museModelCapabilities());
      expect(models[2]?.capabilities).toEqual(museModelCapabilities());
    }),
  );

  it("normalizes saved and implicit efforts against the selected model before dispatch", () => {
    const fallback = museModelCapabilities();
    expect(resolveMuseReasoningEffort(fallback, undefined)).toBe("high");
    expect(resolveMuseReasoningEffort(fallback, "max")).toBe("max");
    expect(resolveMuseReasoningEffort(fallback, "ultra")).toBe("high");
    const restricted = museModelCapabilities({ variants: ["xhigh"] });
    expect(resolveMuseReasoningEffort(restricted, undefined)).toBe("xhigh");
    expect(resolveMuseReasoningEffort(restricted, "low")).toBe("xhigh");
    expect(
      resolveMuseReasoningEffort(museModelCapabilities({ variants: [] }), "max"),
    ).toBeUndefined();
    expect(resolveMuseReasoningEffort(undefined, "max")).toBe("max");
  });
});
