import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { readMuseAccountUsage } from "./accountUsage.ts";

const quota = {
  subs_usage: {
    window: { used_percent: 0, window_duration_mins: 300, resets_at: 1_791_906_112 },
    weekly: { used_percent: 14, resets_at: 1_792_368_000 },
  },
};
const login = JSON.stringify({
  providers: { meta: { mechanism: "oauth", access_token: "dca:test", api_key: "not-for-quota" } },
});
const refuse = HttpClient.make(() => Effect.die("Unexpected account request"));
const respond = (body: unknown, status = 200) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
  );
const authFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  const file = path.join(directory, "auth.json");
  yield* fs.writeFileString(file, login);
  return { fs, path, directory, file };
});

it.layer(NodeServices.layer)("Muse account quota", (it) => {
  it.effect("refreshes quota without a model turn or credential writes", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* authFile;
      const client = HttpClient.make((request) =>
        Effect.withFiber((fiber) => {
          expect(request.url).toBe("https://api.meta.ai/muse-code/key");
          expect(request.method).toBe("POST");
          expect(request.headers.authorization).toBe("Bearer dca:test");
          expect(request.headers["x-api-version"]).toBe("1.0.0");
          expect(Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect).toBe(
            "manual",
          );
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json({ ...quota, api_key: "discard-me" })),
          );
        }),
      );
      const result = yield* readMuseAccountUsage({ MUSE_AUTH_PATH: file }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(result.windows.map((w) => [w.id, w.usedPercent])).toEqual([
        ["window", 0],
        ["weekly", 14],
      ]);
      expect(result.windows[0]?.resetsAt).toBe("2026-10-13T15:41:52.000Z");
      expect(result.windows[0]?.windowDurationMins).toBe(300);
      expect(JSON.stringify(result)).not.toContain("discard-me");
      expect(yield* fs.readFileString(file)).toBe(login);
    }),
  );

  it.effect("does not invent zero limits for idle, invalid or rejected responses", () =>
    Effect.gen(function* () {
      const { file } = yield* authFile;
      for (const [body, status] of [
        [{}, 200],
        [{ subs_usage: null }, 200],
        [{ subs_usage: { window: { used_percent: -1 }, weekly: {} } }, 200],
        [quota, 401],
        [quota, 302],
      ] as const) {
        const result = yield* readMuseAccountUsage({ MUSE_AUTH_PATH: file }).pipe(
          Effect.provideService(HttpClient.HttpClient, respond(body, status)),
        );
        expect(result.windows).toEqual([]);
        expect(result).toMatchObject({ unavailable: { reason: "probeFailed" } });
      }
    }),
  );

  it.effect("does not request unrelated login quotas or open Keychain", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* authFile;
      const apiKey = yield* readMuseAccountUsage({
        MUSE_AUTH_PATH: file,
        META_API_KEY: "explicit-other-account",
      }).pipe(Effect.provideService(HttpClient.HttpClient, refuse));
      expect(apiKey.windows).toEqual([]);
      for (const body of [
        "{",
        "{}",
        JSON.stringify({
          providers: {
            meta: { mechanism: "oauth", access_token: "keychain:meta", api_key: "model-api-key" },
          },
        }),
      ]) {
        yield* fs.writeFileString(file, body);
        const result = yield* readMuseAccountUsage({ MUSE_AUTH_PATH: file }).pipe(
          Effect.provideService(HttpClient.HttpClient, refuse),
        );
        expect(result.windows).toEqual([]);
      }
    }),
  );

  it.effect("uses Windows environment casing for account overrides and auth paths", () =>
    Effect.gen(function* () {
      const { file } = yield* authFile;
      const overridden = yield* readMuseAccountUsage({
        meta_api_key: "other-account",
        Muse_Auth_Path: file,
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HttpClient.HttpClient, refuse),
      );
      expect(overridden.windows).toEqual([]);
      const result = yield* readMuseAccountUsage({ Muse_Auth_Path: file }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HttpClient.HttpClient, respond(quota)),
      );
      expect(result.windows).toHaveLength(2);
    }),
  );

  it.effect("resolves XDG and default config paths on the provider host", () =>
    Effect.gen(function* () {
      const { fs, path, directory } = yield* authFile;
      for (const xdg of [undefined, path.join(directory, "custom-config")]) {
        const config = xdg ?? path.join(directory, ".config");
        yield* fs.makeDirectory(path.join(config, "muse"), { recursive: true });
        yield* fs.writeFileString(path.join(config, "muse", "auth.json"), login);
        const result = yield* readMuseAccountUsage(xdg ? { XDG_CONFIG_HOME: xdg } : {}).pipe(
          Effect.provideService(HostProcess.HomeDirectory, directory),
          Effect.provideService(HttpClient.HttpClient, respond(quota)),
        );
        expect(result.windows).toHaveLength(2);
      }
    }),
  );
});
