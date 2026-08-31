import {
  EventId,
  type OrchestrationThreadActivity,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  latestV2WorkspaceMutationId,
  latestWorkspaceMutationId,
  workspaceMutationRefreshToken,
} from "./useWorkspaceMutationRefresh";

function activity(
  id: string,
  kind: string,
  itemType: string,
  status?: string,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    tone: "tool",
    summary: "Tool activity",
    payload: { itemType, ...(status ? { status } : {}) },
    turnId: null,
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

function v2Item(id: string, type: string, status: string): OrchestrationV2ProjectedTurnItem {
  return { item: { id, type, status } } as unknown as OrchestrationV2ProjectedTurnItem;
}

describe("workspace mutation refresh", () => {
  it("tracks the latest completed file change or command", () => {
    expect(
      latestWorkspaceMutationId([
        activity("file-started", "tool.started", "file_change"),
        activity("search-completed", "tool.completed", "web_search"),
        activity("file-completed", "tool.completed", "file_change"),
        activity("command-completed", "tool.completed", "command_execution"),
      ]),
    ).toBe("command-completed");
  });

  it("ignores read-only and in-progress tools", () => {
    expect(
      latestWorkspaceMutationId([
        activity("command-updated", "tool.updated", "command_execution", "inProgress"),
        activity("legacy-command-updated", "tool.updated", "command_execution", "in_progress"),
        activity("image-completed", "tool.completed", "image_view"),
      ]),
    ).toBeNull();
  });

  it("accepts providers that report terminal state on an update", () => {
    expect(
      latestWorkspaceMutationId([
        activity("file-updated", "tool.updated", "file_change", "completed"),
      ]),
    ).toBe("file-updated");
  });

  it("tracks only terminal orchestration-v2 workspace mutations", () => {
    expect(
      latestV2WorkspaceMutationId([
        v2Item("command-running", "command_execution", "running"),
        v2Item("search-completed", "web_search", "completed"),
        v2Item("file-completed", "file_change", "completed"),
        v2Item("command-failed", "command_execution", "failed"),
      ]),
    ).toBe("command-failed");
    expect(
      latestV2WorkspaceMutationId([v2Item("file-waiting", "file_change", "waiting")]),
    ).toBeNull();
  });

  it("scopes the same mutation to each preview resource", () => {
    expect(workspaceMutationRefreshToken("file:/repo/README.md", "event-1")).not.toBe(
      workspaceMutationRefreshToken("diff:/repo", "event-1"),
    );
    expect(workspaceMutationRefreshToken("file:/repo/README.md", null)).toBeNull();
  });
});
