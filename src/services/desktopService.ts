/**
 * Typed wrappers around the Desktop Cleanup commands
 * (development-plan.md sections 38, 66, 67, 81).
 *
 * The "Service" layer of React UI -> Service -> Tauri Command -> Rust
 * (section 86): components and the store import from here and never call
 * `invoke` themselves. Every command rejects with a plain, user-presentable
 * string.
 *
 * Note what is *not* in this file. There is no `cleanUpDesktop()`, no "clear
 * everything older than a month", no "remove all the shortcuts", no folder
 * argument. The desktops are chosen by Rust from the OS, and the only way to
 * change anything is to name the exact items — which is section 67's rule
 * expressed as an API surface rather than as a convention somebody has to
 * remember:
 *
 * ```text
 * scanDesktop()  ->  show  ->  user selects  ->  confirm  ->  move/delete
 * ```
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { ActionReport, DesktopScan } from "@/types/desktop";

/**
 * Reads the top level of both desktops — the user's own and the public one —
 * and describes what is on them.
 *
 * Pure reading: nothing is opened, moved or removed, which is what makes it
 * safe to call on mount.
 */
export async function scanDesktop(): Promise<DesktopScan> {
  return invoke<DesktopScan>("scan_desktop");
}

/**
 * Moves the named items into `destination`.
 *
 * Rejects outright on an empty list, on a destination that is not a folder,
 * and on a destination that is one of the desktops itself. Individual failures
 * do not reject: they come back in the report's `outcomes`, so a locked file
 * does not hide the twenty that worked.
 */
export async function moveDesktopItems(
  paths: string[],
  destination: string,
): Promise<ActionReport> {
  return invoke<ActionReport>("move_desktop_items", { paths, destination });
}

/**
 * Deletes the named items, permanently.
 *
 * Only ever called from the confirmation step of the review flow. An empty
 * list is refused by Rust rather than treated as "all of them", and so are
 * folders and anything on the public desktop, whatever this layer sends.
 */
export async function deleteDesktopItems(paths: string[]): Promise<ActionReport> {
  return invoke<ActionReport>("delete_desktop_items", { paths });
}

/**
 * Opens one item with whatever the OS opens it with.
 *
 * For a shortcut this runs what the shortcut points at, which is exactly what
 * double-clicking it on the desktop does — it is how somebody works out
 * whether they still want it.
 */
export async function openDesktopItem(path: string): Promise<void> {
  return invoke<void>("open_desktop_item", { path });
}

/** Shows one item in the OS file manager. */
export async function revealDesktopItem(path: string): Promise<void> {
  return invoke<void>("reveal_desktop_item", { path });
}

/**
 * Asks the OS for the folder a move should go to, returning null if the user
 * cancelled.
 *
 * The native picker rather than a text field on purpose: a typed path is a
 * path that can be wrong, and "where did my files go" is the one question a
 * cleanup tool must never leave open. Rust still checks what comes back
 * exists, is a directory, and is not a desktop — the picker is a convenience,
 * not the guard.
 */
export async function chooseDestinationFolder(): Promise<string | null> {
  const chosen = await open({
    directory: true,
    multiple: false,
    title: "Move the selected items into…",
  });

  return typeof chosen === "string" ? chosen : null;
}
