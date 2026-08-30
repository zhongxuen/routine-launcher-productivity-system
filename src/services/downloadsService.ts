/**
 * Typed wrappers around the Downloads Cleanup commands
 * (development-plan.md sections 38-39).
 *
 * The "Service" layer of React UI -> Service -> Tauri Command -> Rust
 * (section 86): components and the store import from here and never call
 * `invoke` themselves. Every command rejects with a plain, user-presentable
 * string.
 *
 * Note what is *not* in this file. There is no `cleanUpDownloads()`, no
 * "delete everything older than N", no folder argument. The folder is chosen
 * by Rust from the OS, and the only way to change a file is to name the exact
 * files — which is section 67's rule expressed as an API surface rather than
 * as a convention somebody has to remember:
 *
 * ```text
 * scanDownloads()  ->  show  ->  user selects  ->  confirm  ->  move/delete
 * ```
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { ActionReport, DownloadsScan } from "@/types/downloads";

/**
 * Reads the top level of the user's Downloads folder and describes it.
 *
 * Pure reading — nothing is opened, moved or removed — which is what makes it
 * safe to call on mount.
 */
export async function scanDownloads(): Promise<DownloadsScan> {
  return invoke<DownloadsScan>("scan_downloads");
}

/**
 * Moves the named files into `destination`.
 *
 * Rejects outright on an empty list or a destination that is not a folder.
 * Individual failures do not reject: they come back in the report's
 * `outcomes`, so a locked file does not hide the twenty that worked.
 */
export async function moveDownloadsFiles(
  paths: string[],
  destination: string,
): Promise<ActionReport> {
  return invoke<ActionReport>("move_downloads_files", { paths, destination });
}

/**
 * Deletes the named files, permanently.
 *
 * Only ever called from the confirmation step of the review flow. An empty
 * list is refused by Rust rather than treated as "all of them".
 */
export async function deleteDownloadsFiles(paths: string[]): Promise<ActionReport> {
  return invoke<ActionReport>("delete_downloads_files", { paths });
}

/** Opens one downloaded file with whatever the OS opens it with. */
export async function openDownloadsFile(path: string): Promise<void> {
  return invoke<void>("open_downloads_file", { path });
}

/** Shows one downloaded file in the OS file manager. */
export async function revealDownloadsFile(path: string): Promise<void> {
  return invoke<void>("reveal_downloads_file", { path });
}

/**
 * Asks the OS for the folder a move should go to, returning null if the user
 * cancelled.
 *
 * The native picker rather than a text field on purpose: a typed path is a
 * path that can be wrong, and "where did my files go" is the one question a
 * cleanup tool must never leave open. Rust still checks what comes back
 * exists and is a directory — the picker is a convenience, not the guard.
 */
export async function chooseDestinationFolder(): Promise<string | null> {
  const chosen = await open({
    directory: true,
    multiple: false,
    title: "Move the selected downloads into…",
  });

  return typeof chosen === "string" ? chosen : null;
}
