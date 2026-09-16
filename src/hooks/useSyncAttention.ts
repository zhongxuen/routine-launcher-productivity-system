/**
 * Says so when automatic sync finds something the user has to decide
 * (development-plan.md section 92's sync folder).
 *
 * Automatic sync pushes this computer's changes by itself, but it never
 * replaces the data under an open window. Newer data from another computer,
 * or changes on both sides, arrive as `sync://attention`; this turns that into
 * one toast. Newer data offers Pull now, which is safe because nothing here
 * changed since the last sync; a conflict only points to Settings › Sync,
 * where both choices are explained.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { reloadAfterRestore } from "@/services/backupService";
import { SYNC_ATTENTION_EVENT, syncPull } from "@/services/tier5Service";
import type { SyncStatus } from "@/types/tier5";

export function useSyncAttention(): void {
  const navigate = useNavigate();

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    void listen<SyncStatus>(SYNC_ATTENTION_EVENT, ({ payload }) => {
      const from = payload.remote?.deviceName ?? "another computer";

      if (payload.state === "remote_changes") {
        toast(`Newer data from ${from}`, {
          description: "Pull it to see the latest tasks and routines here.",
          duration: 30_000,
          action: {
            label: "Pull now",
            onClick: () =>
              void syncPull(false)
                .then(() => {
                  toast.success("Pulled from the sync folder", { description: "Reloading…" });
                  reloadAfterRestore();
                })
                .catch((cause) =>
                  toast.error("Could not pull from the sync folder", { description: String(cause) }),
                ),
          },
        });
        return;
      }

      toast.warning(`Sync needs you: this computer and ${from} both changed`, {
        description: "Choose which data to keep in Settings › Sync.",
        duration: 30_000,
        action: { label: "Open Settings", onClick: () => navigate("/settings") },
      });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((cause) => console.error("Could not listen for sync events:", cause));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [navigate]);
}
