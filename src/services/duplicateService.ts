/**
 * Typed wrappers around the Duplicate Finder commands
 * (development-plan.md sections 38, 40, 67).
 *
 * The "Service" layer of React UI -> Service -> Tauri Command -> Rust
 * (section 86): components and the store import from here and never call
 * `invoke` themselves. Every command rejects with a plain, user-presentable
 * string.
 *
 * Note the shape of what is here, because it is section 67 expressed as an
 * API rather than as a convention:
 *
 * ```text
 * scanDuplicates()  ->  show  ->  user selects  ->  confirm  ->  move/delete
 * ```
 *
 * {@link scanDuplicates} answers with groups and takes no action. The two
 * functions that change a file take a list of paths and nothing else — no
 * group, no scan, no "the ones you found". So there is no call anywhere in
 * this app that can turn a scan into a deletion; something has to hand over
 * the exact paths, and the only thing that does is the confirmation the user
 * clicked through.
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type {
  DuplicateScan,
  DuplicateScanRequest,
  FileActionResult,
} from "@/types/duplicates";

/**
 * The folders a scan starts with: Downloads and Desktop, per prompt 10.2, and
 * only the ones that exist on this machine.
 *
 * Read rather than hard-coded because the real paths come from the OS — a
 * redirected Downloads folder, or a non-English Windows, would make a guessed
 * `C:\Users\...\Downloads` wrong.
 */
export async function defaultDuplicateFolders(): Promise<string[]> {
  return invoke<string[]>("default_duplicate_folders");
}

/**
 * Scans for duplicates. Read-only: it opens files to hash them and changes
 * nothing, which is what makes it safe to run from a button the user pressed
 * by accident.
 *
 * An omitted or empty `folders` means the defaults above.
 */
export async function scanDuplicates(
  request: DuplicateScanRequest = {},
): Promise<DuplicateScan> {
  return invoke<DuplicateScan>("scan_duplicates", { request });
}

/**
 * Deletes exactly the named files, permanently.
 *
 * Reachable only from the confirmation step. Rust refuses an empty list rather
 * than reading it as "all of them", so a component bug cannot turn a
 * mis-click into a mass deletion.
 *
 * Individual failures do not reject — a file open in another program comes
 * back as an `ok: false` outcome so the ones that worked are still reported.
 */
export async function deleteDuplicateFiles(paths: string[]): Promise<FileActionResult[]> {
  return invoke<FileActionResult[]>("delete_duplicate_files", { paths });
}

/**
 * Moves exactly the named files into `destination`, never overwriting: a name
 * already taken there gets ` (1)` appended.
 *
 * The reversible alternative to deleting, and the one to reach for on a
 * `similar-name` group where the contents are known to differ.
 */
export async function moveDuplicateFiles(
  paths: string[],
  destination: string,
): Promise<FileActionResult[]> {
  return invoke<FileActionResult[]>("move_duplicate_files", { paths, destination });
}

/** Opens one file with whatever application the OS has registered for it. */
export async function openDuplicateFile(path: string): Promise<void> {
  return invoke<void>("open_duplicate_file", { path });
}

/** Opens the folder a file lives in, so a copy can be looked at in place. */
export async function revealDuplicateFile(path: string): Promise<void> {
  return invoke<void>("reveal_duplicate_file", { path });
}

/**
 * Asks the OS which folders to scan, returning null if the user cancelled.
 *
 * Multi-select, because the default is itself two folders and "Downloads plus
 * that project directory" is the ordinary shape of the question. The native
 * picker rather than a text field: a typed path is a path that can be wrong,
 * and Rust still checks what comes back is a folder that exists.
 */
export async function chooseScanFolders(): Promise<string[] | null> {
  const chosen = await open({
    directory: true,
    multiple: true,
    title: "Scan these folders for duplicates…",
  });

  if (Array.isArray(chosen)) return chosen.length > 0 ? chosen : null;
  return typeof chosen === "string" ? [chosen] : null;
}

/**
 * Asks the OS for the folder a move should go to, returning null if the user
 * cancelled.
 */
export async function chooseDestinationFolder(): Promise<string | null> {
  const chosen = await open({
    directory: true,
    multiple: false,
    title: "Move the selected copies into…",
  });

  return typeof chosen === "string" ? chosen : null;
}
