import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderSetupError,
  type ProviderAuthState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  ProviderSessionCloseError,
  ProviderSessionManagerV2,
} from "../../orchestration-v2/ProviderSessionManager.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import type { ProviderAuthController } from "../Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { makeProviderAuthService } from "./ProviderAuthService.ts";

const instanceId = ProviderInstanceId.make("antigravity-personal");
const unsupportedInstanceId = ProviderInstanceId.make("codex");
const driverKind = ProviderDriverKind.make("antigravity");
const owner = "paired-client-owner";
const otherOwner = "paired-client-other";
const flowId = "test-sign-in-flow";
const callbackUrl = "http://127.0.0.1:48123/?state=test-state&code=test-code";
const idleAuthState: ProviderAuthState = {
  instanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
};
const waitingAuthState: ProviderAuthState = {
  ...idleAuthState,
  phase: "waiting",
  flowId,
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-state",
  expiresAt: "2026-09-02T00:05:00.000Z",
};

function makeInstance(input: {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly auth?: ProviderAuthController;
}): ProviderInstance {
  return {
    ...input,
    driverKind,
    displayName: undefined,
    continuationIdentity: { driverKind, continuationKey: input.instanceId },
    get snapshot(): never {
      throw new Error("Auth routing must not refresh the provider snapshot.");
    },
    get orchestrationAdapter(): never {
      throw new Error("Auth routing must not start an orchestration session.");
    },
    get textGeneration(): never {
      throw new Error("Auth routing must not generate text.");
    },
  };
}

const unusedSessionManager = {
  shutdown: Effect.void,
  open: () => Effect.die("unexpected open"),
  get: () => Effect.succeed(Option.none()),
  close: () => Effect.void,
  release: () => Effect.void,
  detach: () => Effect.void,
};

const makeHarness = Effect.fn("ProviderAuthService.test.makeHarness")(function* (input?: {
  readonly enabled?: boolean;
  readonly closeError?: ProviderSessionCloseError;
  readonly logoutError?: ProviderSetupError;
}) {
  const actions: string[] = [];
  const registryChanges = yield* PubSub.unbounded<void>();
  let state = idleAuthState;
  let flowOwner: string | undefined;

  const checkOwner = (ownerSessionId: string, requestedFlowId: string, operation: string) =>
    ownerSessionId === flowOwner && requestedFlowId === state.flowId
      ? Effect.void
      : Effect.fail(
          new ProviderSetupError({
            instanceId,
            operation,
            detail: "This sign-in belongs to another client or has expired.",
          }),
        );

  const auth: ProviderAuthController = {
    start: Effect.fn(function* (ownerSessionId, stopSessions) {
      actions.push("close-gate");
      yield* stopSessions ?? Effect.void;
      flowOwner = ownerSessionId;
      state = waitingAuthState;
      actions.push("start-sign-in");
      return state;
    }),
    complete: Effect.fn(function* (ownerSessionId, request) {
      yield* checkOwner(ownerSessionId, request.flowId, "complete");
      if (request.callbackUrl !== callbackUrl) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "complete",
          detail: "The redirect URL does not match this sign-in.",
        });
      }
      state = { ...idleAuthState, flowId, phase: "succeeded" };
      return state;
    }),
    cancel: Effect.fn(function* (ownerSessionId, requestedFlowId) {
      yield* checkOwner(ownerSessionId, requestedFlowId, "cancel");
      state = { ...idleAuthState, flowId, phase: "cancelled" };
      return state;
    }),
    logout: Effect.fn(function* (stopSessions) {
      actions.push("close-gate");
      yield* stopSessions;
      if (input?.logoutError) return yield* input.logoutError;
      actions.push("native-logout");
      state = idleAuthState;
      return state;
    }),
    subscribe: (ownerSessionId) =>
      Stream.succeed(ownerSessionId === flowOwner ? state : idleAuthState),
    isLogoutPrompt: (text, hasAttachments) => !hasAttachments && text.trim() === "/logout",
  };
  const instances = [
    makeInstance({ instanceId, enabled: input?.enabled ?? true, auth }),
    makeInstance({ instanceId: unsupportedInstanceId, enabled: true }),
  ];
  const service = yield* makeProviderAuthService.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: (id) =>
            Effect.succeed(instances.find((instance) => instance.instanceId === id)),
          subscribeChanges: PubSub.subscribe(registryChanges),
        }),
        Layer.succeed(
          ProviderSessionManagerV2,
          ProviderSessionManagerV2.of({
            ...unusedSessionManager,
            closeProviderInstance: () => {
              actions.push("close-instance-sessions");
              return input?.closeError ? Effect.fail(input.closeError) : Effect.void;
            },
          }),
        ),
      ),
    ),
  );
  return { service, actions };
});

describe("ProviderAuthService", () => {
  it.effect("closes OV2 sessions before starting sign-in, including for a disabled instance", () =>
    Effect.gen(function* () {
      const { service, actions } = yield* makeHarness({ enabled: false });
      const state = yield* service.start({ instanceId }, owner);

      assert.strictEqual(state.phase, "waiting");
      assert.deepStrictEqual(actions, ["close-gate", "close-instance-sessions", "start-sign-in"]);
    }),
  );

  it.effect("keeps sign-in state private and accepts only the owner's redirect", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const waiting = yield* service.start({ instanceId }, owner);
      const ownerStates = yield* service
        .subscribe({ instanceId }, owner)
        .pipe(Stream.take(1), Stream.runCollect);
      const otherStates = yield* service
        .subscribe({ instanceId }, otherOwner)
        .pipe(Stream.take(1), Stream.runCollect);

      assert.deepStrictEqual(ownerStates, [waiting]);
      assert.strictEqual(otherStates[0]?.authorizationUrl, null);
      const otherError = yield* Effect.flip(
        service.complete({ instanceId, flowId, callbackUrl }, otherOwner),
      );
      assert.strictEqual(otherError.operation, "complete");
      assert.strictEqual(
        (yield* service.complete({ instanceId, flowId, callbackUrl }, owner)).phase,
        "succeeded",
      );
    }),
  );

  it.effect("rejects unavailable and unsupported provider instances", () =>
    Effect.gen(function* () {
      const { service, actions } = yield* makeHarness();
      for (const [id, detail] of [
        [ProviderInstanceId.make("missing"), "no longer available"],
        [unsupportedInstanceId, "does not support sign-in"],
      ] as const) {
        const error = yield* Effect.flip(service.start({ instanceId: id }, owner));
        assert.instanceOf(error, ProviderSetupError);
        assert.include(error.detail, detail);
      }
      assert.deepStrictEqual(actions, []);
    }),
  );

  it.effect("handles only a standalone logout command", () =>
    Effect.gen(function* () {
      const { service, actions } = yield* makeHarness();
      assert.isFalse(
        yield* service.tryHandlePromptCommand({
          instanceId,
          text: "/logout please",
          hasAttachments: false,
        }),
      );
      assert.isTrue(
        yield* service.tryHandlePromptCommand({
          instanceId,
          text: "  /logout\n",
          hasAttachments: false,
        }),
      );
      assert.deepStrictEqual(actions, ["close-gate", "close-instance-sessions", "native-logout"]);
    }),
  );

  it.effect("redacts OV2 session close failures", () =>
    Effect.gen(function* () {
      const closeError = new ProviderSessionCloseError({
        providerSessionId: ProviderSessionId.make("private-session-id"),
        cause: "private process diagnostics",
      });
      const { service } = yield* makeHarness({ closeError });
      const error = yield* Effect.flip(service.logout({ instanceId }));

      assert.strictEqual(error.operation, "stopSessions");
      assert.notInclude(error.detail, "private process diagnostics");
    }),
  );
});
