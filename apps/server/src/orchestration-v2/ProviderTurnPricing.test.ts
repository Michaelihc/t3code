import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageService from "../usage/UsageService.ts";
import { createOverrideRateTable, priceTurnUsage } from "../usage/usagePricing.ts";
import { layerPricing, ProviderTurnPricing } from "./ProviderEventIngestor.ts";

it.effect("prices a completed Muse turn with its own instance's catalog", () => {
  const model = "muse-example";
  const providers = [100, 2].map((rate, index) => ({
    ...buildServerProvider({
      presentation: { displayName: "Muse" },
      enabled: true,
      checkedAt: "2026-10-13T00:00:00.000Z",
      probe: { installed: true, version: "1.4.7", status: "ready", auth: { status: "unknown" } },
      models: [
        {
          slug: model,
          name: model,
          isCustom: false,
          capabilities: null,
          tokenPrices: {
            inputCostPerMillionTokens: rate,
            outputCostPerMillionTokens: 8,
            cacheReadCostPerMillionTokens: 0.2,
          },
        },
      ],
    }),
    instanceId: ProviderInstanceId.make(`muse-${index}`),
    driver: ProviderDriverKind.make("muse"),
    continuation: { groupKey: `muse-${index}` },
  }));
  const turn: OrchestrationV2ProviderTurn = {
    id: ProviderTurnId.make("turn"),
    providerThreadId: ProviderThreadId.make("thread"),
    nodeId: NodeId.make("node"),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal: 1,
    status: "completed",
    startedAt: null,
    completedAt: null,
    turnTokenUsage: {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      outputTokens: 100_000,
    },
  };
  return Effect.gen(function* () {
    const pricing = yield* ProviderTurnPricing;
    const priced = yield* pricing.price(turn, model, ProviderInstanceId.make("muse-1"));
    assert.closeTo(priced.turnCost?.amountUsd ?? -1, 1.36, 1e-12);
    assert.strictEqual(priced.turnCost?.source, "modelPriced");
    assert.isUndefined(
      (yield* pricing.price(turn, model, ProviderInstanceId.make("missing"))).turnCost,
    );
    const reported = { ...turn, turnCost: { amountUsd: 0.1, source: "providerReported" as const } };
    assert.strictEqual(
      yield* pricing.price(reported, model, ProviderInstanceId.make("muse-1")),
      reported,
    );
  }).pipe(
    Effect.provide(
      layerPricing.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed(providers),
            }),
            Layer.mock(UsageService.UsageService)({
              refreshRates: Effect.succeed({
                status: "unavailable",
                source: "test",
                fetchedAt: null,
                knownModels: 0,
              }),
              priceTurn: (model, usage, catalog) =>
                Effect.succeed(
                  priceTurnUsage(
                    createOverrideRateTable(catalog ? { [model]: catalog } : {}),
                    model,
                    usage,
                  ),
                ),
            }),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );
});
