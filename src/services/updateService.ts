/**
 * The update strategy's side of the `invoke` boundary (development-plan.md
 * section 85).
 *
 * `appService.ts` next door answers "which build is this"; this file answers
 * "is there a newer one, and would you like it". They are deliberately
 * separate: the version is a fact about the running process that every screen
 * may read, and this is the one part of the app that reaches the network.
 *
 * Nothing here goes through `@tauri-apps/plugin-updater`. That plugin is
 * loaded in Rust and granted to no window — running an installer is a native
 * OS operation and section 86 puts those behind this app's own commands, the
 * same way launch-at-startup is. See `src-tauri/src/services/updates.rs` for
 * what the check consists of and what it is not allowed to send.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Emitted by the backend while an update is downloading. */
const PROGRESS_EVENT = "updates://progress";

/** A release newer than the running build. */
export interface AvailableUpdate {
  /** The version being offered, e.g. `0.2.0`. */
  version: string;
  /** The version doing the offering, so the card can show both ends of it. */
  currentVersion: string;
  /** Release notes from the manifest, if it carried any. */
  notes: string | null;
  /** Release date as `YYYY-MM-DD`, if the manifest carried one. */
  date: string | null;
}

/** How far a download has got. */
export interface DownloadProgress {
  downloaded: number;
  /**
   * The total size, or null when the server did not send a `Content-Length`.
   * A null is "we cannot know", not "zero" — the bar goes indeterminate
   * rather than dividing by it.
   */
  total: number | null;
}

/** Whether the app looks for a new release when it starts. */
export async function getCheckUpdatesOnLaunch(): Promise<boolean> {
  return invoke<boolean>("get_check_updates_on_launch");
}

/** Turns the launch check on or off, answering with what was stored. */
export async function setCheckUpdatesOnLaunch(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_check_updates_on_launch", { enabled });
}

/**
 * Asks the release endpoint for anything newer than this build.
 *
 * Resolves to `null` when there is nothing — which is an answer, not a
 * failure. It rejects only when the check could not be made or could not be
 * trusted: no network, an endpoint that did not answer with a manifest, or a
 * manifest whose signature does not match the key this build carries.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  return invoke<AvailableUpdate | null>("check_for_update");
}

/**
 * Downloads the newest release and hands the machine to its installer.
 *
 * **On success this never resolves.** The installer takes over and the
 * process ends, so a settled promise — resolved or rejected — means the
 * install did not happen. Callers should treat it that way rather than
 * showing "done".
 */
export async function installUpdate(): Promise<void> {
  return invoke("install_update");
}

/**
 * Subscribes to download progress. Returns a promise for the unsubscribe
 * function, so it can be awaited inside an effect and called on cleanup.
 */
export async function onUpdateProgress(
  handler: (progress: DownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<DownloadProgress>(PROGRESS_EVENT, (event) => handler(event.payload));
}
