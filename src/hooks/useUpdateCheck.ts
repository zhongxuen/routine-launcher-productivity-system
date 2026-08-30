/**
 * The once-per-launch look for a new release (development-plan.md section 85).
 *
 * Mounted in the app shell rather than in Settings &rsaquo; Updates, because
 * the check belongs to the *launch* and not to a page: a user who never opens
 * Settings is exactly the user an update check exists for. The card reads the
 * same store afterwards, so opening it later shows what this already found
 * without asking the endpoint twice.
 *
 * Two things it deliberately does not do.
 *
 * It does not install anything. Section 85 asks for an update strategy, not
 * for software that replaces itself while its owner is looking the other way
 * — so the most this can do is say so, and the installing is a button in
 * Settings. See `src-tauri/src/services/updates.rs`.
 *
 * And it does not report a failure. An endpoint that could not be reached is
 * the ordinary condition of a laptop that opened on a train, and a toast
 * about it every launch would train the user to dismiss the one that
 * eventually matters. The failure is kept in the store, where the Updates
 * card shows it to somebody who has gone looking.
 *
 * The toast is also the reason this hook holds the subscription to the
 * backend's progress event: the install can be started from the toast's
 * action or from the card, and the bar has to fill either way.
 */

import { useEffect } from "react";
import { toast } from "sonner";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { getCheckUpdatesOnLaunch, onUpdateProgress } from "@/services/updateService";
import { useUpdateStore } from "@/stores/updateStore";

export function useUpdateCheck(): void {
  useEffect(() => {
    let isCurrent = true;
    let unlisten: UnlistenFn | null = null;

    void onUpdateProgress((progress) => useUpdateStore.getState().setProgress(progress))
      .then((fn) => {
        // The effect may already have been torn down — React's development
        // double-mount is the common way — in which case the subscription is
        // dropped rather than kept for a cleanup that has been and gone.
        if (!isCurrent) fn();
        else unlisten = fn;
      })
      .catch((cause) => console.error("Could not listen for update progress:", cause));

    void runLaunchCheck();

    return () => {
      isCurrent = false;
      unlisten?.();
    };
  }, []);
}

/**
 * Reads the setting and, if it is on, makes the check.
 *
 * The `hasCheckedThisRun` guard is what makes "once per launch" true rather
 * than "once per mount": a re-mounted shell, and React's development
 * double-mount, both arrive here a second time.
 */
async function runLaunchCheck(): Promise<void> {
  const store = useUpdateStore.getState();
  if (store.hasCheckedThisRun || store.status === "checking") return;

  let enabled: boolean;
  try {
    enabled = await getCheckUpdatesOnLaunch();
  } catch (cause) {
    // Nothing on screen depends on this, and the switch that would explain it
    // is in Settings, which is where the user would go anyway.
    console.error("Could not read the update-check setting:", cause);
    return;
  }

  if (!enabled) return;

  const found = await useUpdateStore.getState().check();
  if (!found) return;

  const update = useUpdateStore.getState().update;
  if (!update) return;

  // Not auto-dismissed: an update is worth one deliberate acknowledgement,
  // and a toast that vanished while the user was typing would have been the
  // only notice they ever got.
  toast(`Routine Launcher ${update.version} is available`, {
    description: `You are on ${update.currentVersion}. Install it from Settings › Updates.`,
    duration: Infinity,
  });
}
