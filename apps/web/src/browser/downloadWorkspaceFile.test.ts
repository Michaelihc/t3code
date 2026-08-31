import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { downloadWorkspaceFile } from "./downloadWorkspaceFile";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

describe("downloadWorkspaceFile", () => {
  it("mints an exact workspace capability and starts the browser download", async () => {
    const createAssetUrl = vi.fn(async () =>
      AsyncResult.success({
        relativeUrl: "/api/assets/signed-token/Q3%20results.csv",
        expiresAt: Date.now() + 60_000,
      }),
    );
    const startDownload = vi.fn();

    const result = await downloadWorkspaceFile({
      threadRef,
      filePath: "reports/Q3 results.csv",
      httpBaseUrl: "https://remote-environment.example/base/",
      createAssetUrl,
      startDownload,
    });

    expect(result._tag).toBe("Success");
    expect(createAssetUrl).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        resource: {
          _tag: "workspace-file-download",
          threadId: threadRef.threadId,
          path: "reports/Q3 results.csv",
        },
      },
    });
    expect(startDownload).toHaveBeenCalledWith(
      "https://remote-environment.example/api/assets/signed-token/Q3%20results.csv",
      "Q3 results.csv",
    );
  });

  it("does not start a download when the environment returns an invalid URL", async () => {
    const startDownload = vi.fn();
    const result = await downloadWorkspaceFile({
      threadRef,
      filePath: "report.pdf",
      httpBaseUrl: "not a URL",
      createAssetUrl: async () =>
        AsyncResult.success({
          relativeUrl: "/api/assets/token/report.pdf",
          expiresAt: Date.now() + 60_000,
        }),
      startDownload,
    });

    expect(result._tag).toBe("Failure");
    expect(startDownload).not.toHaveBeenCalled();
  });
});
