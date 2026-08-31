import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useAssetUrl } from "../../state/assets";
import { resolveWorkspaceFilePath } from "./filePath";

function useWorkspaceFileAssetUrlForTag(props: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
  readonly tag: "workspace-file" | "workspace-file-download";
}) {
  const absolutePath = useMemo(
    () =>
      props.cwd !== null && props.relativePath !== null
        ? resolveWorkspaceFilePath(props.cwd, props.relativePath)
        : null,
    [props.cwd, props.relativePath],
  );

  return useAssetUrl(
    props.environmentId,
    absolutePath !== null && props.threadId !== null
      ? {
          _tag: props.tag,
          threadId: props.threadId,
          path: absolutePath,
        }
      : null,
  );
}

type WorkspaceFileAssetUrlProps = Omit<Parameters<typeof useWorkspaceFileAssetUrlForTag>[0], "tag">;

export function useWorkspaceFileAssetUrl(props: WorkspaceFileAssetUrlProps) {
  return useWorkspaceFileAssetUrlForTag({ ...props, tag: "workspace-file" });
}

export function useWorkspaceFileDownloadUrl(props: WorkspaceFileAssetUrlProps) {
  return useWorkspaceFileAssetUrlForTag({ ...props, tag: "workspace-file-download" });
}
