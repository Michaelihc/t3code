import {
  NodeId,
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderTurn,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RawEventId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { preserveTurnAccounting, summarizeTurnCost } from "@t3tools/shared/turnCost";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as UsageService from "../usage/UsageService.ts";
import { ProviderAdapterV2Event } from "./ProviderAdapter.ts";
import { makeProviderFailureTurnItem } from "./ProviderFailure.ts";

export class ProviderEventNormalizeError extends Schema.TaggedError<ProviderEventNormalizeError>()(
  "ProviderEventNormalizeError",
  {
    providerSessionId: ProviderSessionId,
    threadId: ThreadId,
    providerEvent: ProviderAdapterV2Event,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to normalize provider event ${this.providerEvent.type} for thread ${this.threadId}.`;
  }
}

export class ProviderEventPublishError extends Schema.TaggedError<ProviderEventPublishError>()(
  "ProviderEventPublishError",
  {
    providerSessionId: ProviderSessionId,
    eventCount: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to publish ${this.eventCount} normalized provider event(s).`;
  }
}

export const ProviderEventIngestorV2Error = Schema.Union([
  ProviderEventNormalizeError,
  ProviderEventPublishError,
]);
export type ProviderEventIngestorV2Error = typeof ProviderEventIngestorV2Error.Type;

export interface ProviderTurnAnalyticsContext {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

export class ProviderTurnAnalytics extends Context.Reference<{
  readonly record: (properties: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
}>("t3/orchestration-v2/ProviderTurnAnalytics", {
  defaultValue: () => ({ record: () => Effect.void }),
}) {}

export class ProviderTurnPricing extends Context.Reference<{
  readonly price: (
    turn: OrchestrationV2ProviderTurn,
    model: string | undefined,
  ) => Effect.Effect<OrchestrationV2ProviderTurn>;
}>("t3/orchestration-v2/ProviderTurnPricing", {
  defaultValue: () => ({ price: (turn) => Effect.succeed(turn) }),
}) {}

export const pricingLive = Layer.effect(
  ProviderTurnPricing,
  Effect.gen(function* () {
    const usage = yield* UsageService.UsageService;
    yield* usage.refreshRates.pipe(Effect.forkScoped);
    return {
      price: Effect.fn("ProviderTurnPricing.price")(function* (
        turn: OrchestrationV2ProviderTurn,
        model: string | undefined,
      ) {
        if (turn.turnCost || !turn.turnTokenUsage || !model) return turn;
        const cost = yield* usage.priceTurn(model, turn.turnTokenUsage);
        return cost === null || cost.costSource === "unpriced"
          ? turn
          : {
              ...turn,
              turnCost: { amountUsd: cost.costUsd, source: cost.costSource },
            };
      }),
    };
  }),
);

export const analyticsLive = Layer.effect(
  ProviderTurnAnalytics,
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    return {
      record: (properties: Readonly<Record<string, unknown>>) =>
        analytics.record("provider.turn.completed", properties),
    };
  }),
);

function providerTurnAnalyticsProperties(input: {
  readonly driver: ProviderAdapterV2Event["driver"];
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly context?: ProviderTurnAnalyticsContext;
}): Readonly<Record<string, unknown>> {
  const usage = input.providerTurn.turnTokenUsage;
  const modelSelection = input.context?.modelSelection;
  const effort = modelSelection
    ? (getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
      getModelSelectionStringOptionValue(modelSelection, "effort"))
    : undefined;
  return {
    provider: input.driver,
    terminalStatus: input.providerTurn.status,
    usageStatus: usage?.usageStatus ?? "unavailable",
    usageScope: usage?.usageScope ?? "main_agent",
    ...(usage ? { hasSubagents: usage.hasSubagents } : {}),
    ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage?.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage?.cacheCreationTokens === undefined
      ? {}
      : { cacheCreationTokens: usage.cacheCreationTokens }),
    ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(modelSelection ? { model: modelSelection.model, mixedModels: false } : {}),
    ...(effort ? { effort } : {}),
    ...(input.context?.runtimeMode ? { runtimeMode: input.context.runtimeMode } : {}),
    ...(input.context?.interactionMode ? { interactionMode: input.context.interactionMode } : {}),
    ...(input.providerTurn.startedAt && input.providerTurn.completedAt
      ? {
          durationMs: Math.max(
            0,
            DateTime.toEpochMillis(input.providerTurn.completedAt) -
              DateTime.toEpochMillis(input.providerTurn.startedAt),
          ),
        }
      : {}),
  };
}

type TodoListPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;

function withPlanStepDurations(
  plan: TodoListPlan,
  previous: TodoListPlan | undefined,
  occurredAt: DateTime.Utc,
): TodoListPlan {
  const occurredAtIso = DateTime.formatIso(occurredAt);
  const occurredAtMs = DateTime.toEpochMillis(occurredAt);
  const previousById = new Map(previous?.steps.map((step) => [step.id, step]));
  // Provider step IDs may be positional. Changed text must not inherit another task's timing.
  const previousStep = (step: TodoListPlan["steps"][number]) => {
    const prior = previousById.get(step.id);
    return prior?.text === step.text ? prior : undefined;
  };
  const hasNewCompletion = plan.steps.some((step) => {
    const prior = previousStep(step);
    return step.status === "completed" && prior?.status !== "completed";
  });
  let fallbackCompletionConsumed = false;

  return {
    ...plan,
    steps: plan.steps.map((step) => {
      const prior = previousStep(step);
      const baseStep = { id: step.id, text: step.text, status: step.status };
      if (step.status === "completed") {
        if (prior?.status === "completed") {
          return {
            ...baseStep,
            ...(prior.durationMs === undefined ? {} : { durationMs: prior.durationMs }),
          };
        }
        const durationAnchorAt =
          prior?.status === "running" || !fallbackCompletionConsumed
            ? prior?.durationAnchorAt
            : occurredAtIso;
        fallbackCompletionConsumed = true;
        const anchorMs =
          durationAnchorAt === undefined ? occurredAtMs : Date.parse(durationAnchorAt);
        const durationMs = Number.isFinite(anchorMs) ? Math.max(0, occurredAtMs - anchorMs) : 0;
        return {
          ...baseStep,
          ...(durationMs > 0 ? { durationMs } : {}),
        };
      }
      if (step.status === "running") {
        return {
          ...baseStep,
          durationAnchorAt:
            prior?.status === "running" ? (prior.durationAnchorAt ?? occurredAtIso) : occurredAtIso,
        };
      }
      return {
        ...baseStep,
        durationAnchorAt:
          hasNewCompletion || prior?.status !== "pending"
            ? occurredAtIso
            : (prior.durationAnchorAt ?? occurredAtIso),
      };
    }),
  };
}

export interface ProviderEventIngestInput {
  readonly providerSessionId: ProviderSessionId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly commandId?: CommandId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly nodeId?: NodeId;
  readonly rawEventId?: RawEventId;
  readonly event: ProviderAdapterV2Event;
  readonly analyticsContext?: ProviderTurnAnalyticsContext;
}

export interface ProviderEventIngestorV2Shape {
  readonly normalize: (
    input: ProviderEventIngestInput,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, ProviderEventIngestorV2Error>;
  readonly ingestNormalized: (
    input: ProviderEventIngestInput & {
      /**
       * Atomically reject mutable provider state emitted by an attempt that
       * lost ownership while the adapter event was in flight.
       */
      readonly writeIfRunCurrent?: {
        readonly runId: RunId;
        readonly activeAttemptId: RunAttemptId;
        readonly expectedStatus: OrchestrationV2Run["status"];
      };
      /**
       * Atomically reject provider-thread snapshots from an attempt that no
       * longer owns the run or from a run that no longer owns the thread.
       */
      readonly writeIfProviderThreadOwner?: {
        readonly providerThreadId: ProviderThreadId;
        readonly runId: RunId;
        readonly activeAttemptId: RunAttemptId;
        readonly expectedLastRunOrdinal: number;
      };
    },
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, ProviderEventIngestorV2Error>;
}

export class ProviderEventIngestorV2 extends Context.Service<
  ProviderEventIngestorV2,
  ProviderEventIngestorV2Shape
>()("t3/orchestration-v2/ProviderEventIngestor/ProviderEventIngestorV2") {}

function compactUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

const decodeDomainEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);

export const layer: Layer.Layer<
  ProviderEventIngestorV2,
  never,
  EventSink.EventSinkV2 | IdAllocator.IdAllocatorV2 | ProjectionStore.ProjectionStoreV2
> = Layer.effect(
  ProviderEventIngestorV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const analytics = yield* ProviderTurnAnalytics;
    const pricing = yield* ProviderTurnPricing;
    const accountingPermit = yield* Semaphore.make(1);
    const completedTurnAnalytics = new Set<string>();

    const makeDomainEvent = (
      input: ProviderEventIngestInput,
      payloadInput: {
        readonly type: OrchestrationV2DomainEvent["type"];
        readonly payload: OrchestrationV2DomainEvent["payload"];
        readonly threadId?: ThreadId;
        readonly runId?: RunId | null;
        readonly nodeId?: NodeId | null;
        readonly occurredAt?: DateTime.Utc;
      },
    ) =>
      Effect.gen(function* () {
        const threadId = payloadInput.threadId ?? input.threadId;
        const eventId = yield* idAllocator.allocate.event({
          threadId,
          providerSessionId: input.providerSessionId,
        });
        const occurredAt = payloadInput.occurredAt ?? (yield* DateTime.now);
        return yield* decodeDomainEvent(
          compactUndefined({
            id: eventId,
            type: payloadInput.type,
            threadId,
            runId: payloadInput.runId ?? input.runId,
            nodeId: payloadInput.nodeId ?? input.nodeId,
            driver: input.event.driver,
            providerInstanceId: input.providerInstanceId,
            rawEventId: input.rawEventId,
            occurredAt,
            payload: payloadInput.payload,
          }),
        );
      });

    const dismissNativeUserInputs = Effect.fn("ProviderEventIngestor.dismissNativeUserInputs")(
      function* (
        input: ProviderEventIngestInput,
        providerTurnId: ProviderTurnId,
        threadId = input.threadId,
      ) {
        const pending = yield* projections.getPendingNativeUserInputs(threadId, providerTurnId);
        const now = yield* DateTime.now;
        const events: Array<OrchestrationV2DomainEvent> = [];
        for (const request of pending.runtimeRequests) {
          events.push(
            yield* makeDomainEvent(input, {
              type: "runtime-request.updated",
              threadId,
              nodeId: request.nodeId,
              payload: { ...request, status: "cancelled", resolvedAt: now },
            }),
          );
        }
        for (const node of pending.nodes) {
          events.push(
            yield* makeDomainEvent(input, {
              type: "node.updated",
              threadId,
              nodeId: node.id,
              runId: node.runId,
              payload: { ...node, status: "cancelled", completedAt: now },
            }),
          );
        }
        for (const item of pending.turnItems) {
          events.push(
            yield* makeDomainEvent(input, {
              type: "turn-item.updated",
              threadId,
              nodeId: item.nodeId,
              runId: item.runId,
              payload: { ...item, status: "cancelled", completedAt: now, updatedAt: now },
            }),
          );
        }
        return events;
      },
    );

    const normalize: ProviderEventIngestorV2Shape["normalize"] = (input) =>
      Effect.gen(function* () {
        switch (input.event.type) {
          case "app_thread.created":
            return [
              yield* makeDomainEvent(input, {
                type: "thread.created",
                threadId: input.event.appThread.id,
                payload: input.event.appThread,
              }),
            ];
          case "provider_session.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "provider-session.updated",
                payload: input.event.providerSession,
              }),
            ];
          case "provider_thread.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "provider-thread.updated",
                threadId: input.event.providerThread.appThreadId ?? input.threadId,
                payload: input.event.providerThread,
              }),
            ];
          case "provider_turn.updated": {
            let turn = input.event.providerTurn;
            let model = input.analyticsContext?.modelSelection.model;
            if (turn.turnTokenUsage !== undefined || turn.costParent !== undefined) {
              const threadId = input.event.threadId ?? input.threadId;
              const thread = yield* projections.getThread(threadId);
              const parentId =
                thread.lineage.relationshipToParent === "subagent"
                  ? thread.lineage.parentThreadId
                  : null;
              if (parentId || turn.costParent) {
                const projection = yield* projections.getThreadProjection(threadId);
                turn = preserveTurnAccounting(
                  projection.providerTurns.find((entry) => entry.id === turn.id),
                  turn,
                );
                if (!turn.costParent && parentId && thread.forkedFrom?.type === "node") {
                  const parent = yield* projections.getThreadProjection(parentId);
                  const spawnNodeId = thread.forkedFrom.nodeId;
                  const spawn = parent.nodes.find((node) => node.id === spawnNodeId);
                  const attempt = projection.attempts.find(
                    (entry) => entry.id === turn.runAttemptId,
                  );
                  const run = projection.runs.find((entry) => entry.id === attempt?.runId);
                  // A later, independently prompted child run belongs to itself.
                  if (spawn?.providerTurnId && (turn.runAttemptId === null || run?.ordinal === 1)) {
                    turn = {
                      ...turn,
                      costParent: { threadId: parentId, turnId: spawn.providerTurnId },
                    };
                  }
                }
              }
              // Native children share their parent's ingestion context, not its model.
              model =
                turn.costModel ??
                (threadId !== input.threadId ? thread.modelSelection.model : model);
              if (model) turn = { ...turn, costModel: model };
            }
            return [
              ...(["completed", "interrupted", "failed", "cancelled"].includes(
                input.event.providerTurn.status,
              )
                ? yield* dismissNativeUserInputs(
                    input,
                    input.event.providerTurn.id,
                    input.event.threadId,
                  )
                : []),
              yield* makeDomainEvent(input, {
                type: "provider-turn.updated",
                ...(input.event.threadId === undefined ? {} : { threadId: input.event.threadId }),
                payload: yield* pricing.price(turn, model),
                nodeId: input.event.providerTurn.nodeId,
              }),
            ];
          }
          case "node.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "node.updated",
                threadId: input.event.node.threadId,
                payload: input.event.node,
                runId: input.event.node.runId,
                nodeId: input.event.node.id,
              }),
            ];
          case "subagent.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "subagent.updated",
                threadId: input.event.subagent.threadId,
                payload: input.event.subagent,
                runId: input.event.subagent.runId,
                nodeId: input.event.subagent.id,
              }),
            ];
          case "message.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "message.updated",
                threadId: input.event.message.threadId,
                payload: input.event.message,
                runId: input.event.message.runId,
                nodeId: input.event.message.nodeId,
              }),
            ];
          case "turn_item.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "turn-item.updated",
                threadId: input.event.turnItem.threadId,
                payload: input.event.turnItem,
                runId: input.event.turnItem.runId,
                nodeId: input.event.turnItem.nodeId,
              }),
            ];
          case "runtime_request.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "runtime-request.updated",
                ...(input.event.threadId === undefined ? {} : { threadId: input.event.threadId }),
                payload: input.event.runtimeRequest,
                nodeId: input.event.runtimeRequest.nodeId,
              }),
            ];
          case "plan.updated": {
            const occurredAt = yield* DateTime.now;
            const plan = input.event.plan;
            const previous =
              plan.kind === "todo_list"
                ? yield* projections.getPlan(plan.threadId, plan.id)
                : undefined;
            const payload =
              plan.kind === "todo_list"
                ? withPlanStepDurations(
                    plan,
                    previous?.kind === "todo_list" ? previous : undefined,
                    occurredAt,
                  )
                : plan;
            return [
              yield* makeDomainEvent(input, {
                type: "plan.updated",
                threadId: plan.threadId,
                payload,
                runId: plan.runId,
                nodeId: plan.nodeId,
                occurredAt,
              }),
            ];
          }
          case "turn.terminal":
            const dismissed = yield* dismissNativeUserInputs(input, input.event.providerTurnId);
            if (input.event.status !== "failed") {
              return dismissed;
            }
            const occurredAt = yield* DateTime.now;
            return [
              ...dismissed,
              yield* makeDomainEvent(input, {
                type: "turn-item.updated",
                payload: makeProviderFailureTurnItem({
                  idAllocator,
                  driver: input.event.driver,
                  threadId: input.threadId,
                  runId: input.runId ?? null,
                  nodeId: input.nodeId ?? null,
                  providerThreadId: input.event.providerThreadId,
                  providerTurnId: input.event.providerTurnId,
                  itemOrdinal: input.event.failureItemOrdinal,
                  failure: input.event.failure,
                  ...(input.event.retry === undefined ? {} : { retry: input.event.retry }),
                  ...(input.event.retryStartedAt === undefined
                    ? {}
                    : { retryStartedAt: input.event.retryStartedAt }),
                  occurredAt,
                }),
              }),
            ];
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderEventNormalizeError({
              providerSessionId: input.providerSessionId,
              threadId: input.threadId,
              providerEvent: input.event,
              cause,
            }),
        ),
      );

    const rollUpCosts = Effect.fn("ProviderEventIngestor.rollUpCosts")(function* (
      input: ProviderEventIngestInput,
      storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>,
    ) {
      if (storedEvents.length === 0) return;
      const event = input.event;
      if (event.type !== "provider_turn.updated" && event.type !== "subagent.updated") return;
      const accepted = storedEvents.find(
        (stored) => stored.event.type === "provider-turn.updated",
      )?.event;
      if (
        event.type === "provider_turn.updated" &&
        accepted?.type === "provider-turn.updated" &&
        !accepted.payload.costParent &&
        !accepted.payload.turnTokenUsage?.hasSubagents
      )
        return;
      // Context-window notifications are frequent and carry no billed usage.
      if (
        event.type === "provider_turn.updated" &&
        !event.providerTurn.turnTokenUsage &&
        !event.providerTurn.costParent
      )
        return;
      let threadId =
        event.type === "subagent.updated"
          ? event.subagent.threadId
          : (event.threadId ?? input.threadId);
      let projection = yield* projections.getThreadProjection(threadId);
      let turnId =
        event.type === "provider_turn.updated"
          ? event.providerTurn.id
          : projection.nodes.find((node) => node.id === event.subagent.id)?.providerTurnId;
      const seen = new Set<string>();
      while (turnId && !seen.has(turnId)) {
        seen.add(turnId);
        let turn = projection.providerTurns.find((candidate) => candidate.id === turnId);
        if (!turn) return;
        const count = projection.subagents.filter((agent) =>
          projection.nodes.some((node) => node.id === agent.id && node.providerTurnId === turnId),
        ).length;
        if (count > (turn.subagentCount ?? 0)) {
          turn = { ...turn, subagentCount: count };
          yield* eventSink.write({
            events: [
              yield* makeDomainEvent(input, {
                type: "provider-turn.updated",
                threadId,
                payload: turn,
                nodeId: turn.nodeId,
                runId: null,
              }),
            ],
          });
        }
        if (!turn.costParent) return;
        const parentRef = turn.costParent;
        if (seen.has(parentRef.turnId)) return;
        const parentProjection = yield* projections.getThreadProjection(parentRef.threadId);
        const parent = parentProjection.providerTurns.find(
          (candidate) => candidate.id === parentRef.turnId,
        );
        if (!parent) return;
        const total = summarizeTurnCost(turn);
        const entry = {
          turnId: turn.id,
          providerThreadId: turn.providerThreadId,
          model: turn.costModel ?? "Unknown model",
          amountUsd: total.amountUsd,
          estimated: total.estimated,
          complete: total.complete,
        };
        const previous = parent.subagentCosts ?? [];
        const oldEntry = previous.find((candidate) => candidate.turnId === turn.id);
        if (
          oldEntry?.amountUsd === entry.amountUsd &&
          oldEntry.complete === entry.complete &&
          oldEntry.estimated === entry.estimated &&
          oldEntry.model === entry.model
        )
          return;
        const updated = {
          ...parent,
          subagentCosts: [...previous.filter((candidate) => candidate.turnId !== turn.id), entry],
        };
        yield* eventSink.write({
          events: [
            yield* makeDomainEvent(input, {
              type: "provider-turn.updated",
              threadId: parentRef.threadId,
              payload: updated,
              nodeId: parent.nodeId,
              runId: null,
            }),
          ],
        });
        threadId = parentRef.threadId;
        turnId = parentRef.turnId;
        projection = {
          ...parentProjection,
          providerTurns: parentProjection.providerTurns.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        };
      }
    });

    return ProviderEventIngestorV2.of({
      normalize,
      ingestNormalized: (input) =>
        Effect.gen(function* () {
          const events = yield* normalize(input);
          if (events.length === 0) {
            return [];
          }
          const mapWriteError = (cause: unknown) =>
            new ProviderEventPublishError({
              providerSessionId: input.providerSessionId,
              eventCount: events.length,
              cause,
            });
          if (input.writeIfProviderThreadOwner !== undefined) {
            const ownerResult = yield* eventSink
              .writeIfProviderThreadOwner({
                guardPendingUserInputCancellations: true,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                ...input.writeIfProviderThreadOwner,
                events,
              })
              .pipe(Effect.mapError(mapWriteError));
            return ownerResult.storedEvents;
          }
          if (input.writeIfRunCurrent === undefined) {
            return yield* eventSink
              .write({
                guardPendingUserInputCancellations: true,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                events,
              })
              .pipe(Effect.mapError(mapWriteError));
          }
          const result = yield* eventSink
            .writeIfRunCurrent({
              guardPendingUserInputCancellations: true,
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
              threadId: input.threadId,
              ...input.writeIfRunCurrent,
              events,
            })
            .pipe(Effect.mapError(mapWriteError));
          return result.storedEvents;
        }).pipe(
          Effect.tap((events) =>
            rollUpCosts(input, events).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderEventPublishError({
                    providerSessionId: input.providerSessionId,
                    eventCount: events.length,
                    cause,
                  }),
              ),
            ),
          ),
          Effect.tap((storedEvents) =>
            Effect.gen(function* () {
              if (storedEvents.length === 0 || input.event.type !== "provider_turn.updated") return;
              const providerTurn = input.event.providerTurn;
              if (
                providerTurn.status !== "completed" &&
                providerTurn.status !== "failed" &&
                providerTurn.status !== "interrupted" &&
                providerTurn.status !== "cancelled"
              )
                return;
              const key = `${input.providerInstanceId}:${providerTurn.id}`;
              if (completedTurnAnalytics.has(key)) return;
              completedTurnAnalytics.add(key);
              if (completedTurnAnalytics.size > 4096) {
                const oldest = completedTurnAnalytics.values().next().value;
                if (oldest !== undefined) completedTurnAnalytics.delete(oldest);
              }
              yield* analytics.record(
                providerTurnAnalyticsProperties({
                  driver: input.event.driver,
                  providerTurn,
                  ...(input.analyticsContext === undefined
                    ? {}
                    : { context: input.analyticsContext }),
                }),
              );
            }),
          ),
          (effect) =>
            input.event.type === "provider_turn.updated" || input.event.type === "subagent.updated"
              ? accountingPermit.withPermit(effect)
              : effect,
        ),
    });
  }),
);
