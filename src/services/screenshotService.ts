/**
 * Typed wrappers around the Screenshot Organizer commands
 * (development-plan.md sections 38, 42, 67).
 *
 * The "Service" layer of React UI -> Service -> Tauri Command -> Rust
 * (section 86): components and the store import from here and never call
 * `invoke` themselves. Every command rejects with a plain, user-presentable
 * string.
 *
 * Note what is *not* in this file. There is no `organizeAll()`, no "file
 * everything older than a month", no folder argument on the scan. The folders
 * to look in are chosen by Rust from the OS, and the only way to move a
 * screenshot is to name the exact files and the exact destination — which is
 * section 67's rule expressed as an API surface rather than as a convention
 * somebody has to remember:
 *
 * ```text
 * scanScreenshots()  ->  show  ->  user selects  ->  confirm  ->  organize
 * ```
 */

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { Grouping, OrganizeResult, ScreenshotScan } from "@/types/screenshot";

/**
 * Looks through the folders screenshots land in and describes what is there.
 *
 * Pure reading — nothing is opened, moved or removed — which is what makes it
 * safe to call on mount. It walks real folders, so it is not instant on a
 * large Pictures library; the caller shows a loading state rather than
 * assuming it returns in a frame.
 */
export async function scanScreenshots(): Promise<ScreenshotScan> {
  return invoke<ScreenshotScan>("scan_screenshots");
}

/**
 * Moves the named screenshots into `destination`.
 *
 * Only ever called from the confirmation step of the review flow. Rejects
 * outright on an empty list or a destination that is not an existing folder;
 * individual failures do not reject but come back in `outcomes`, so one
 * locked file does not hide the twenty that worked.
 *
 * Rust re-tests every path against the same folders the scan used and skips
 * anything it would not have found itself — so this function cannot be talked
 * into moving something the user never saw in the list.
 */
export async function organizeScreenshots(
  paths: string[],
  destination: string,
  grouping: Grouping,
): Promise<OrganizeResult> {
  return invoke<OrganizeResult>("organize_screenshots", {
    request: { paths, destination, grouping },
  });
}

/**
 * Opens one screenshot with whatever the OS opens images with.
 *
 * Reading, not acting — but it is most of how a review gets made, because a
 * screenshot is a picture and a filename is a poor description of one. Rust
 * applies the same guard the move does, so this cannot open a path that no
 * scan produced.
 */
export async function openScreenshot(path: string): Promise<void> {
  return invoke<void>("open_screenshot", { path });
}

/** Shows one screenshot in the OS file manager. */
export async function revealScreenshot(path: string): Promise<void> {
  return invoke<void>("reveal_screenshot", { path });
}

/**
 * Asks the OS for the folder to organise into, returning null if the user
 * cancelled.
 *
 * The native picker rather than a text field on purpose: a typed path is a
 * path that can be wrong, and "where did my screenshots go" is the one
 * question a tool like this must never leave open. Rust still checks that
 * what comes back exists and is a directory — the picker is a convenience,
 * not the guard.
 *
 * It opens on the user's screenshots folder when there is one, because the
 * common case is filing screenshots *within* it rather than somewhere new.
 */
export async function chooseDestinationFolder(): Promise<string | null> {
  const chosen = await open({
    directory: true,
    multiple: false,
    title: "Organize the selected screenshots into…",
    defaultPath: (await defaultDestination()) ?? undefined,
  });

  return typeof chosen === "string" ? chosen : null;
}

/**
 * Where the picker should open. Null means "wherever the OS would normally",
 * which is a fine answer and not an error worth reporting.
 */
async function defaultDestination(): Promise<string | null> {
  try {
    return await invoke<string | null>("default_screenshot_destination");
  } catch {
    return null;
  }
}
