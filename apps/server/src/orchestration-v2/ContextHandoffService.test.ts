import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ContextHandoffServiceV2,
  captureActiveForkSnapshot,
  activeForkSnapshotPrompt,
  layer as contextHandoffServiceLayer,
  providerMessageWithContextHandoff,
} from "./ContextHandoffService.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";

const TestLayer = contextHandoffServiceLayer.pipe(Layer.provide(idAllocatorLayer));

function importedItem(
  input:
    | {
        readonly role: "user";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      }
    | {
        readonly role: "assistant";
        readonly id: string;
        readonly text: string;
        readonly ordinal: number;
      },
): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const base = {
    id: TurnItemId.make(`turn-item:${input.id}`),
    threadId: ThreadId.make("thread:legacy-context"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
  };
  return input.role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : {
        ...base,
        type: "assistant_message",
        streaming: false,
      };
}

it.layer(TestLayer)("ContextHandoffService legacy import", (it) => {
  it.effect("prepares imported history for the first native v2 turn", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({ role: "user", id: "one", text: "What did we decide?", ordinal: 1 }),
          importedItem({
            role: "assistant",
            id: "two",
            text: "We decided to keep the migration lightweight.",
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.equal(handoff.strategy, "manual_context");
      assert.deepStrictEqual(handoff.fromProviderThreadIds, []);
      assert.include(handoff.summaryText, "What did we decide?");
      assert.include(handoff.summaryText, "keep the migration lightweight");
      const providerMessage = providerMessageWithContextHandoff({
        handoff,
        userText: "Continue from there.",
      });
      assert.include(providerMessage, handoff.summaryText);
      assert.include(providerMessage, "User message:\nContinue from there.");
    }),
  );

  it.effect("preserves role attribution when truncating imported history", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "user",
            id: "long",
            text: `${"x".repeat(35_000)} retained final words`,
            ordinal: 1,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... retained final words");
      assert.notMatch(handoff.summaryText, /\n+x+ retained final words/);
    }),
  );

  it.effect("retains the newest oversized import even when it has no whitespace", () =>
    Effect.gen(function* () {
      const service = yield* ContextHandoffServiceV2;
      const handoff = yield* service.prepareLegacyImport({
        threadId: ThreadId.make("thread:legacy-context"),
        targetRunId: RunId.make("run:first-v2"),
        toProviderThreadId: ProviderThreadId.make("provider-thread:first-v2"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        items: [
          importedItem({
            role: "assistant",
            id: "older",
            text: "older message",
            ordinal: 1,
          }),
          importedItem({
            role: "user",
            id: "long-single-token",
            text: `${"🧪".repeat(20_000)}LATEST_SINGLE_TOKEN`,
            ordinal: 2,
          }),
        ],
        createdAt: DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"),
      });

      assert.include(
        handoff.history?.omittedItemIds ?? [],
        TurnItemId.make("turn-item:long-single-token"),
      );
      assert.isAtMost(handoff.summaryText.length, 32_000);
      assert.include(handoff.summaryText, "User:\n... ");
      assert.include(handoff.summaryText, "LATEST_SINGLE_TOKEN");
      assert.notInclude(handoff.summaryText, "\ufffd");
    }),
  );
});

it.layer(TestLayer)("active fork snapshots", (it) => {
  it.effect(
    "sends frozen context and the idle instruction only with the user's explicit message",
    () =>
      Effect.gen(function* () {
        const items = [
          importedItem({
            role: "user",
            id: "goal",
            text: "Implement the original task",
            ordinal: 1,
          }),
          importedItem({
            role: "assistant",
            id: "partial",
            text: "Progress before fork",
            ordinal: 2,
          }),
        ];
        const snapshot = captureActiveForkSnapshot(items);
        items.push(
          importedItem({
            role: "assistant",
            id: "later",
            text: "Source output after fork",
            ordinal: 3,
          }),
        );
        const service = yield* ContextHandoffServiceV2;
        const handoff = yield* service.prepareProviderHandoff({
          threadId: ThreadId.make("fork"),
          targetRunId: RunId.make("explicit-followup"),
          toProviderThreadId: ProviderThreadId.make("fork-provider"),
          toProviderInstanceId: ProviderInstanceId.make("codex"),
          transferId: null,
          fromProviderThreadIds: [],
          fromProviderInstanceId: ProviderInstanceId.make("codex"),
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "full_thread_summary",
          activeFork: true,
          items: snapshot,
          createdAt: DateTime.makeUnsafe("2026-09-16T00:00:00.000Z"),
        });
        const providerMessage = providerMessageWithContextHandoff({
          handoff,
          userText: "Now investigate the failing test only.",
        });
        assert.include(
          providerMessage,
          "You are a fork. Do not continue work unless explicitly instructed.",
        );
        assert.include(
          handoff.history!.coverage,
          "You are a fork. Do not continue work unless explicitly instructed.",
        );
        assert.include(providerMessage, "Implement the original task");
        assert.include(providerMessage, "Progress before fork");
        assert.notInclude(providerMessage, "Source output after fork");
        assert.include(providerMessage, "Now investigate the failing test only.");
      }),
  );
});

it("bounds active snapshots and discloses omitted history", () => {
  const snapshot = captureActiveForkSnapshot([
    importedItem({
      role: "assistant",
      id: "long",
      text: "x".repeat(140_000) + "recent context",
      ordinal: 1,
    }),
  ]);
  const prompt = activeForkSnapshotPrompt(snapshot);
  assert.isBelow(prompt.length, 129_000);
  assert.include(prompt, "Earlier text omitted from fork snapshot");
  assert.include(prompt, "recent context");
  assert.include(prompt, "tool results may be omitted");
});
