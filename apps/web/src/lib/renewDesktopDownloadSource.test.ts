import { EnvironmentId, ChatAttachmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connection: vi.fn(),
  createUrl: vi.fn(() => "url-atom"),
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: "registry" }));
vi.mock("../state/assets", () => ({ assetEnvironment: { createUrl: mocks.createUrl } }));
vi.mock("../state/session", () => ({ readPreparedConnection: mocks.connection }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.query,
  squashAtomCommandFailure: () => new Error("Signing failed"),
}));
import { renewDesktopDownloadSource } from "./renewDesktopDownloadSource";

const source = {
  environmentId: EnvironmentId.make("remote"),
  resource: { _tag: "attachment" as const, attachmentId: ChatAttachmentId.make("report") },
};
afterEach(() => vi.clearAllMocks());

describe("download capability renewal", () => {
  it("forces a fresh capability and resolves against the current remote origin", async () => {
    mocks.connection.mockReturnValue({ httpBaseUrl: "https://current.example" });
    mocks.query.mockResolvedValue({
      _tag: "Success",
      value: { relativeUrl: "/api/assets/report?signature=fresh" },
    });
    expect(await renewDesktopDownloadSource(source)).toBe(
      "https://current.example/api/assets/report?signature=fresh",
    );
    expect(mocks.createUrl).toHaveBeenCalledWith({
      environmentId: source.environmentId,
      input: { resource: source.resource },
    });
    expect(mocks.query).toHaveBeenCalledWith(
      "registry",
      "url-atom",
      expect.objectContaining({ refresh: true }),
    );
  });
  it("requires the environment to be connected", async () => {
    mocks.connection.mockReturnValue(null);
    await expect(renewDesktopDownloadSource(source)).rejects.toThrow("Reconnect");
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("reports signing failures instead of reusing the expired URL", async () => {
    mocks.connection.mockReturnValue({ httpBaseUrl: "https://current.example" });
    mocks.query.mockResolvedValue({ _tag: "Failure" });
    await expect(renewDesktopDownloadSource(source)).rejects.toThrow("Signing failed");
  });
});
