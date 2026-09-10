import { RotateCwIcon } from "lucide-react";
import { useState } from "react";
import { useAssetUrlRefresh } from "../../assets/assetUrls";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { MediaActionSource } from "./MediaActions";

export function RefreshImageButton({ asset }: { asset: NonNullable<MediaActionSource["asset"]> }) {
  const refresh = useAssetUrlRefresh(asset.environmentId, asset.resource);
  const [refreshing, setRefreshing] = useState(false);
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="secondary"
      aria-label="Refresh image"
      title="Refresh image"
      disabled={refreshing}
      onClick={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        setRefreshing(true);
        try {
          await refresh();
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Unable to refresh image",
            description: error instanceof Error ? error.message : "Try again after reconnecting.",
          });
        } finally {
          setRefreshing(false);
        }
      }}
    >
      <RotateCwIcon />
    </Button>
  );
}
