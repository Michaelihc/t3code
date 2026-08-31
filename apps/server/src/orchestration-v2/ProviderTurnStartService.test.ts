import { expect, it, vi } from "vite-plus/test";
import {
  CheckpointScopeId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  ProjectId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { ProviderAdapterEnsureThreadError } from "./ProviderAdapter.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

it("does not commit running state when inherited background routing cannot be read", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch: "feature/restore",
      worktreePath: "/tmp/missing-provider-turn-start-worktree",
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const pruneWorktrees = vi.fn(() => Effect.void);
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.succeed(FileSystem.FileSystem, { exists: () => Effect.succeed(false) } as never),
        Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees, createWorktree }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => {
            projectionReadCount += 1;
            return projectionReadCount === 1
              ? Effect.succeed(projection)
              : Effect.fail(
                  new ProjectionStore.ProjectionStoreReadError({
                    threadId,
                    cause: "simulated inherited-background projection failure",
                  }),
                );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
      ),
    ),
  );

  await Effect.gen(function* () {
    const error = yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(projectionReadCount).toBe(2);
    expect(pruneWorktrees).toHaveBeenCalledWith({ cwd: "/tmp/provider-turn-start-project" });
    expect(createWorktree).toHaveBeenCalledWith({
      cwd: "/tmp/provider-turn-start-project",
      refName: "feature/restore",
      path: "/tmp/missing-provider-turn-start-worktree",
    });
    expect(writeIfRunCurrent).not.toHaveBeenCalled();
    expect(startRootRun).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("terminalizes a starting run when the provider thread open times out", async () => {
  const threadId = ThreadId.make("thread_provider_turn_start_timeout");
  const runId = RunId.make("run_provider_turn_start_timeout");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_timeout");
  const rootNodeId = NodeId.make("node_provider_turn_start_timeout");
  const providerThreadId = ProviderThreadId.make("provider_thread_provider_turn_start_timeout");
  const providerSessionId = ProviderSessionId.make("provider_session_provider_turn_start_timeout");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const driver = ProviderDriverKind.make("codex");
  const messageId = MessageId.make("message_provider_turn_start_timeout");
  const checkpointScopeId = CheckpointScopeId.make("checkpoint_scope_provider_turn_start_timeout");
  const projection = {
    thread: { id: threadId, providerInstanceId },
    runs: [
      {
        id: runId,
        threadId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        providerInstanceId,
        userMessageId: messageId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol", options: [] },
        ordinal: 1,
        queuePosition: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        checkpointScopeId,
        status: "pending",
        completedAt: null,
      },
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        status: "pending",
        completedAt: null,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        providerSessionId,
        providerInstanceId,
        driver,
        nativeThreadRef: null,
        status: "not_loaded",
      },
    ],
    providerSessions: [],
    providerTurns: [],
    messages: [
      {
        id: messageId,
        text: "start the turn",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    ],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    subagents: [],
    turnItems: [{ ordinal: 1_000_002 }],
  } as unknown as OrchestrationV2ThreadProjection;
  const timeoutError = new ProviderAdapterEnsureThreadError({
    driver,
    threadId,
    timedOut: true,
    cause: "simulated unanswered thread/start",
  });
  let committedWrite: unknown;
  const writeIfRunCurrent = vi.fn((input: unknown) =>
    Effect.sync(() => {
      committedWrite = input;
      return { committed: true, storedEvents: [] } as never;
    }),
  );
  const release = vi.fn(() => Effect.void);
  const startRootRun = vi.fn(() => Effect.void);
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.succeed(FileSystem.FileSystem, { exists: () => Effect.succeed(true) } as never),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              driver,
              providerSession: { id: providerSessionId },
              ensureThread: () => Effect.fail(timeoutError),
            } as never),
          release,
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );

  await Effect.service(ProviderTurnStart.ProviderTurnStartServiceV2).pipe(
    Effect.flatMap((service) => service.start({ threadId, runId })),
    Effect.provide(layer),
    Effect.runPromise,
  );

  expect(writeIfRunCurrent).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledWith({
    providerSessionId,
    reason: "runtime_error",
    detail: `Provider thread start timed out for run ${runId}.`,
  });
  expect(startRootRun).not.toHaveBeenCalled();
  const write = committedWrite as {
    readonly expectedStatus: string;
    readonly events: ReadonlyArray<{
      readonly type: string;
      readonly payload: {
        readonly status?: string;
        readonly type?: string;
        readonly failure?: unknown;
      };
    }>;
  };
  expect(write.expectedStatus).toBe("starting");
  expect(
    write.events.some(
      (event) =>
        event.type === "turn-item.updated" &&
        event.payload.type === "error" &&
        event.payload.status === "failed" &&
        event.payload.failure !== undefined,
    ),
  ).toBe(true);
  expect(
    write.events.some((event) => event.type === "run.updated" && event.payload.status === "failed"),
  ).toBe(true);
  expect(
    write.events.some(
      (event) => event.type === "run-attempt.updated" && event.payload.status === "failed",
    ),
  ).toBe(true);
  expect(
    write.events.some(
      (event) => event.type === "node.updated" && event.payload.status === "failed",
    ),
  ).toBe(true);
});
