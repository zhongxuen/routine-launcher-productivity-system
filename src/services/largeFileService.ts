/**
 * Typed wrappers around the Large File Finder commands (development-plan.md
 * sections 38, 41, 67).
 *
 * This is the "Service" layer of React UI -> Service -> Tauri Command ->
 * Rust -> filesystem (section 86): components and the store import from here
 * and never call `invoke` themselves.
 *
 * # Section 67 is expressed in the shape of this file
 *
 * The plan's rule is an order — scan, show results, user selects, confirm,
 * perform action — and the module is arranged so nothing here can shortcut
 * it:
 *
 * * {@link scanLargeFiles} is the only function that looks at more than one
 *   file, and it is read-only. Whatever it finds, it changes nothing.
 * * {@link moveLargeFile}, {@link archiveLargeFile} and
 *   {@link deleteLargeFile} each take exactly one path. There is no batch
 *   call, no "act on the whole scan", and nothing that takes a filter — so
 *   the only way to act on ten files is for the user to confirm ten times.
 * * The confirmation itself belongs to the caller
 *   (`LargeFileConfirmDialog`), because it is a UI step. This layer's part of
 *   the rule is not offering anything that could be called without one.
 *
 * The backend refuses independently: it will not move or delete a file
 * belonging to Windows or an installed program however it is asked, and a
 * delete goes to the Recycle Bin rather than being final.
 *
 * Every command rejects with a plain, user-presentable string, so callers can
 * put `String(error)` straight into a toast.
 */

import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import type {
  FileActionResult,
  LargeFilePreferences,
  LargeFileScan,
} from "@/types/large-files";

/** The thresholds the view offers, in MB. */
export const THRESHOLD_CHOICES_MB = [50, 100, 250, 500, 1024, 5120] as const;

// ---------------------------------------------------------------------------
// Choosing a folder
// ---------------------------------------------------------------------------

/**
 * Asks the OS for a folder, returning `null` if the user cancelled.
 *
 * The native picker rather than a text field, and the only way a path gets
 * into this feature: the user cannot mistype a folder, and the app never has
 * to guess at one. Used for the scan root, for a Move destination, and for
 * the archive folder — three different questions, so `title` says which one
 * is being asked.
 */
export async function pickFolder(
  title: string,
  defaultPath?: string | null,
): Promise<string | null> {
  const chosen = await openFileDialog({
    directory: true,
    multiple: false,
    title,
    defaultPath: defaultPath ?? undefined,
  });

  // The dialog plugin answers `string | string[] | null`; `multiple: false`
  // means the array form cannot happen, but narrowing it is cheaper than
  // trusting it.
  if (Array.isArray(chosen)) return chosen[0] ?? null;
  return chosen;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Where the last scan ran, how big "big" was, what is ignored and where
 * Archive puts things.
 *
 * Cheap and idempotent — read on mount so the view reopens on the folder the
 * user was last looking at instead of asking them to find it again.
 */
export async function getLargeFilePreferences(): Promise<LargeFilePreferences> {
  return invoke<LargeFilePreferences>("get_large_file_preferences");
}

/**
 * Walks `folder` and answers with the files over `thresholdMb`, largest
 * first.
 *
 * Read-only, and the slow one: seconds on a big tree, which is why the
 * backend runs it off the main thread and the view shows a spinner rather
 * than freezing. It stops itself on a folder too large to finish and says so
 * in `stopped` — a partial answer that admits it is partial, rather than one
 * that looks like the whole tree.
 *
 * Files on the ignore list are left out but still counted in
 * `ignoredMatches`, so the view can say how many are being hidden.
 */
export async function scanLargeFiles(
  folder: string,
  thresholdMb: number,
): Promise<LargeFileScan> {
  return invoke<LargeFileScan>("scan_large_files", { folder, thresholdMb });
}

// ---------------------------------------------------------------------------
// Acting on one file
// ---------------------------------------------------------------------------

/**
 * Opens a file with whatever the OS has registered for it.
 *
 * The one action with no confirmation, because it changes nothing — and
 * because deciding whether a video is still wanted usually means watching ten
 * seconds of it. An app that made *looking* awkward would push people towards
 * guessing before they delete.
 */
export async function openLargeFile(path: string): Promise<void> {
  return invoke<void>("open_large_file", { path });
}

/**
 * Moves one file into `destination`. Confirm before calling.
 *
 * Never overwrites: a name already taken at the destination is suffixed
 * `" (1)"` and `renamed` on the result says so.
 */
export async function moveLargeFile(
  path: string,
  destination: string,
): Promise<FileActionResult> {
  return invoke<FileActionResult>("move_large_file", { path, destination });
}

/**
 * Moves one file into the archive folder, under `YYYY-MM` for the month it
 * was last changed. Confirm before calling.
 *
 * `modifiedMs` comes from the scan row rather than being re-read, so the
 * folder named in the confirmation is the folder the file lands in.
 */
export async function archiveLargeFile(
  path: string,
  modifiedMs: number | null,
): Promise<FileActionResult> {
  return invoke<FileActionResult>("archive_large_file", { path, modifiedMs });
}

/**
 * Sends one file to the Recycle Bin. Confirm before calling.
 *
 * The Recycle Bin, not an unlink — so the confirmation can promise the file
 * is recoverable and be telling the truth. Refused outright for a file
 * belonging to Windows or to an installed program.
 */
export async function deleteLargeFile(path: string): Promise<FileActionResult> {
  return invoke<FileActionResult>("delete_large_file", { path });
}

// ---------------------------------------------------------------------------
// The ignore list
// ---------------------------------------------------------------------------

/**
 * Hides a file from future scans, answering with the list as it now stands.
 *
 * The one action of the five that has no confirmation and is not
 * destructive: nothing on disk changes, and the Ignored panel puts it back in
 * one click. This is what the user reaches for on the 8 GB file they know
 * about and are keeping — the alternative is a list that keeps asking about
 * it.
 */
export async function ignoreLargeFile(path: string): Promise<string[]> {
  return invoke<string[]>("ignore_large_file", { path });
}

/** Puts an ignored file back in the results of the next scan. */
export async function unignoreLargeFile(path: string): Promise<string[]> {
  return invoke<string[]>("unignore_large_file", { path });
}

/** Empties the ignore list. */
export async function clearIgnoredLargeFiles(): Promise<string[]> {
  return invoke<string[]>("clear_ignored_large_files");
}

// ---------------------------------------------------------------------------
// The archive folder
// ---------------------------------------------------------------------------

/** Points Archive at a folder of the user's choosing. */
export async function setLargeFileArchiveRoot(
  folder: string,
): Promise<LargeFilePreferences> {
  return invoke<LargeFilePreferences>("set_large_file_archive_root", { folder });
}

/** Goes back to `Documents/Routine Launcher Archive`. */
export async function resetLargeFileArchiveRoot(): Promise<LargeFilePreferences> {
  return invoke<LargeFilePreferences>("reset_large_file_archive_root");
}
