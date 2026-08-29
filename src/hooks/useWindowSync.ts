/**
 * Re-reads this window's stores when another window changes something.
 *
 * Mounted once per window — the app shell (`AppLayout`) for the main one, the
 * popup's root for the compact one (development-plan.md section 25) — so
 * neither ever shows a list the other has already moved past. See
 * `src/lib/window-sync.ts` for what is announced and why nothing but the
 * announcement travels.
 *
 * Reads only: the handler re-runs the query each store already knows how to
 * run, which is why this cannot loop. Nothing here writes, so nothing here
 * announces, so a re-read never provokes another one.
 */

import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { onDataChanged } from "@/lib/window-sync";
import { useRoutineStore } from "@/stores/routineStore";
import { useTaskStore } from "@/stores/taskStore";

export function useWindowSync(): void {
  useEffect(() => {
    // `listen` is async, so the window can be gone before the subscription
    // exists — in which case it is unsubscribed the moment it arrives rather
    // than left behind.
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    void onDataChanged((scope) => {
      if (scope === "tasks") {
        void useTaskStore.getState().refresh();
      } else {
        void useRoutineStore.getState().loadRoutines();
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((cause) => {
        // A window that cannot hear the others still works; it is just a
        // manual refresh behind. Not worth a visible error.
        console.error("Could not subscribe to changes from other windows:", cause);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}