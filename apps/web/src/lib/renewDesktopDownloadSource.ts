import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DesktopFileDownloadSource } from "@t3tools/contracts";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { assetEnvironment } from "../state/assets";
import { readPreparedConnection } from "../state/session";

export async function renewDesktopDownloadSource(source: DesktopFileDownloadSource) {
  const { environmentId, resource } = source;
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error("Reconnect to this environment and try again.");
  const result = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({ environmentId, input: { resource } }),
    { label: "Renew download URL", reportFailure: false, refresh: true },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
  if (!url) throw new Error("The environment returned an invalid download URL.");
  return url;
}
