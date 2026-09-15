/**
 * Export, import and reset (development-plan.md section 69).
 *
 * The "Service" layer of React UI -> Service -> Tauri Command -> Rust
 * (section 86): `DataCard` imports from here and never calls `invoke` or the
 * dialog plugin itself.
 *
 * # The file never crosses the bridge
 *
 * Only the *path* does. The save and open dialogs are the frontend's, because
 * choosing a file is the user's decision and the OS picker is the only honest
 * way to ask for one; reading and writing what they chose is the backend's,
 * because the main window is not granted the `fs` plugin (see
 * `src-tauri/capabilities/default.json`) and because a backup of a long-used
 * database is megabytes that have no reason to be serialised into a JS string
 * on their way to disk.
 *
 * ```text
 * pickBackupDestination()  ->  exportBackup(path)          // save dialog, then Rust writes
 * pickBackupFile()  ->  inspectBackup(path)  ->  confirm  ->  importBackup(path)
 * ```
 *
 * That middle step is section 67's rule, and it is why import is two calls
 * rather than one: the confirmation is built from a file that has actually
 * been read and validated, so the user is agreeing to replace their data with
 * *that backup* rather than with a filename.
 *
 * # Why the window reloads afterwards
 *
 * [`importBackup`] and [`resetAppData`] replace the database underneath every
 * store in every window — tasks, routines, focus, progress, quests, analytics,
 * the widget's settings, the id of a focus session that may no longer exist.
 * `window-sync.ts`'s announcement covers two of those scopes, which is enough
 * for the other windows and nowhere near enough for this one. So this one
 * reloads, through [`reloadAfterRestore`]. Nothing is lost by that: everything
 * a store was holding came out of the database that has just been replaced.
 */

import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";

import { announceDataChanged } from "@/lib/window-sync";
import type { BackupInfo } from "@/types/backup";

/** The `.json` filter both dialogs offer, so the picker starts narrow. */
const JSON_FILTER = [{ name: "JSON backup", extensions: ["json"] }];

/**
 * The filename Export suggests (`routine-launcher-backup.json`).
 *
 * Asked of the backend rather than written here, so the name section 69
 * specifies lives in exactly one place.
 */
export async function getDefaultBackupFileName(): Promise<string> {
  return invoke<string>("default_backup_file_name");
}

/**
 * Asks the OS where to save a backup, returning `null` if the user cancelled.
 *
 * The save dialog handles the overwrite warning itself, which is why nothing
 * here checks whether the file exists: replacing last week's backup is the
 * normal case, and Windows has already asked.
 */
export async function pickBackupDestination(): Promise<string | null> {
  return saveFileDialog({
    title: "Export Routine Launcher data",
    defaultPath: await getDefaultBackupFileName(),
    filters: JSON_FILTER,
  });
}

/** Asks the OS for a backup file to read, returning `null` if cancelled. */
export async function pickBackupFile(): Promise<string | null> {
  const chosen = await openFileDialog({
    title: "Import Routine Launcher data",
    multiple: false,
    directory: false,
    filters: JSON_FILTER,
  });

  // The plugin answers `string | string[] | null`; `multiple: false` means the
  // array form cannot happen, but narrowing it is cheaper than trusting it.
  if (Array.isArray(chosen)) return chosen[0] ?? null;
  return chosen;
}

/**
 * Writes every table to `path` and describes what went in.
 *
 * Pure reading as far as the database is concerned — the only thing it
 * changes is a file the user just named.
 */
export async function exportBackup(path: string): Promise<BackupInfo> {
  return invoke<BackupInfo>("export_backup", { path });
}

/**
 * Reads a backup file and says what is in it, without importing it.
 *
 * Rejects for the same reasons the import would — not a backup, a newer
 * format, a newer schema, a column this build does not know — so a file that
 * cannot be restored is refused before the user is asked to confirm
 * replacing their data with it.
 */
export async function inspectBackup(path: string): Promise<BackupInfo> {
  return invoke<BackupInfo>("inspect_backup", { path });
}

/**
 * Replaces everything in the database with the contents of `path`.
 *
 * Destructive, and only ever called from the confirmation step. It either
 * fully lands or fully does not: the restore is one transaction, so a backup
 * that turns out to be inconsistent rejects with a message saying nothing was
 * changed rather than leaving half of it behind.
 */
export async function importBackup(path: string): Promise<BackupInfo> {
  return invoke<BackupInfo>("import_backup", { path });
}

/**
 * Wipes every task, routine, focus session, XP transaction and setting,
 * leaving the app as a fresh install.
 *
 * There is no undo and nothing partial. Only ever called after the typed
 * confirmation in `DataCard`.
 */
export async function resetAppData(): Promise<void> {
  await invoke<void>("reset_app_data");
}

/**
 * Tells the other windows, then restarts this one, so nothing anywhere is
 * still showing rows out of the database that has just been replaced.
 *
 * The reload is deliberately blunt. The alternative — refreshing each store in
 * turn — is a list that has to be kept in step with every store the app ever
 * grows, and the one that gets forgotten shows the user tasks that no longer
 * exist. A reload cannot be incomplete.
 *
 * The broadcast is for the windows a reload here cannot reach: the popup, the
 * quick launcher and the widget are separate webviews with their own copies of
 * every store, and `useWindowSync` is how they are told. It is coarser than
 * this situation deserves — it re-reads tasks, routines and the daily
 * settings, not the focus session or the day's XP — but a widget one scope
 * behind is better than one
 * listing a routine that has been deleted, and the alternative would be a
 * cross-window "everything changed" event that nothing else in the app needs.
 *
 * The delay is so the success toast is readable before the window goes; the
 * caller has already said what happened, and a page that vanishes mid-sentence
 * reads as a crash rather than as a success.
 */
export function reloadAfterRestore(delayMs = 1200): void {
  announceDataChanged("tasks");
  announceDataChanged("routines");
  announceDataChanged("settings");
  window.setTimeout(() => window.location.reload(), delayMs);
}
