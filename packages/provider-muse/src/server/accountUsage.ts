import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import { decodeMuseUsageLimits } from "./usageLimits.ts";

const Credentials = Schema.Struct({
  providers: Schema.Struct({
    meta: Schema.Struct({ mechanism: Schema.Literal("oauth"), access_token: Schema.String }),
  }),
});
const QuotaWindow = Schema.Struct({ used_percent: Schema.Number, resets_at: Schema.Number });
const AccountUsage = Schema.Struct({
  subs_usage: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        window: Schema.Struct({ ...QuotaWindow.fields, window_duration_mins: Schema.Number }),
        weekly: QuotaWindow,
      }),
    ),
  ),
});

/** A fresh MSP host has no observations. Read quota using Muse's existing OAuth login. */
export const readMuseAccountUsage = Effect.fn("readMuseAccountUsage")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const platform = yield* HostProcess.Platform;
  const env = (name: string) => {
    const key =
      platform === "win32"
        ? Object.keys(environment).find((key) => key.toUpperCase() === name)
        : name;
    return key === undefined ? undefined : environment[key];
  };
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unavailable = (message: string) =>
    makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message,
    });
  // An explicit API key selects a different account from the CLI's OAuth login.
  if (env("META_API_KEY")?.trim()) {
    return unavailable("Muse subscription limits are unavailable for an API-key connection.");
  }
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home =
      (platform === "win32" ? env("USERPROFILE") : env("HOME")) ||
      (yield* HostProcess.HomeDirectory);
    const authPath =
      env("MUSE_AUTH_PATH") ||
      path.join(env("XDG_CONFIG_HOME") || path.join(home, ".config"), "muse", "auth.json");
    const credentials = yield* fs
      .readFileString(authPath)
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Credentials))));
    const token = credentials.providers.meta.access_token;
    // Do not substitute the model API key or prompt for Keychain access in a background probe.
    if (!/^dca:[^\s]+$/.test(token)) {
      return unavailable("Muse limits will appear when Muse reports usage during a turn.");
    }
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.post("https://api.meta.ai/muse-code/key").pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${token}`,
            "x-api-version": "1.0.0",
          }),
          HttpClientRequest.bodyText('{"onboard":false}', "application/json"),
        ),
      )
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
    const body = yield* HttpClientResponse.schemaBodyJson(AccountUsage)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    // Meta omits both windows when the short window is idle; absence is not zero usage.
    if (!body.subs_usage) {
      return unavailable(
        "Muse has not supplied usage limits. They will update when Muse reports usage during a turn.",
      );
    }
    return yield* decodeMuseUsageLimits({
      observedAtMs: Date.parse(checkedAt),
      window: {
        usedPercent: body.subs_usage.window.used_percent,
        resetsAtMs: body.subs_usage.window.resets_at * 1_000,
        windowDurationMins: body.subs_usage.window.window_duration_mins,
      },
      weekly: {
        usedPercent: body.subs_usage.weekly.used_percent,
        resetsAtMs: body.subs_usage.weekly.resets_at * 1_000,
      },
    });
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.orElseSucceed(() =>
      unavailable(
        "Muse account limits could not be read. Limits will update when Muse reports usage during a turn.",
      ),
    ),
  );
});
