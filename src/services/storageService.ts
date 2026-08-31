/**
 * Typed wrappers around the Storage Overview commands (development-plan.md
 * sections 38, 66, 67).
 *
 * This is the "Service" layer of React UI -> Service -> Tauri Command ->
 * Rust -> filesystem (section 86): the store imports from here and never
 * calls `invoke` itself.
 *
 * # The whole file is read-only, and that is the feature
 *
 * There is no move here, no delete, no open and no reveal — not because they
 * were left for later but because this utility does not have them. Section
 * 67's scan -> show -> select -> confirm -> act stops at "show", and where
 * the four tools beside this one would offer an action, this one offers a
 * link into `largeFileService` or `duplicateService`, which keep their own
 * confirmations. Nothing that can be called from this module can change a
 * file, so there is nothing here to guard beyond the read itself.
 *
 * Every command rejects with a plain, user-presentable string, so callers can
 * put `String(error)` straight into a toast.
 */

import { invoke } from "@tauri-apps/api/core";

import type { FolderSize, StorageOverview } from "@/types/storage";

/**
 * The fixed drives, the profile path, and the profile's top-level folders —
 * everything the page draws before any folder has been sized.
 *
 * Fast: one directory listing and a few OS calls. It also *starts* a scan and
 * returns its token, so calling it again abandons whatever the previous visit
 * left walking. That means it must not be called speculatively — once per
 * deliberate load, which is what the store does.
 */
export async function getStorageOverview(): Promise<StorageOverview> {
  return invoke<StorageOverview>("storage_overview");
}

/**
 * Adds up one top-level folder of the profile.
 *
 * The slow one — seconds on `AppData` — and the reason this feature is shaped
 * the way it is. One call is one complete answer about one folder, so the
 * view can draw each figure as it lands instead of waiting for the whole
 * profile, and the backend runs the walk on a blocking thread so nothing
 * freezes while it does.
 *
 * `token` comes from {@link getStorageOverview}. A stale one does not fail:
 * the walk stops at its first check and answers with `stopped: "cancelled"`,
 * which is how the caller knows to discard the result rather than show it.
 *
 * Folders it cannot open are counted in `skippedFolders` and skipped. A
 * locked `AppData` subfolder is normal on every Windows machine and is never
 * an error.
 */
export async function sizeProfileFolder(folder: string, token: number): Promise<FolderSize> {
  return invoke<FolderSize>("size_profile_folder", { folder, token });
}

/**
 * Stops the walk that is running now.
 *
 * The Stop button, and also what the store calls before starting a fresh
 * scan. The call in flight comes back on its own with `stopped: "cancelled"`;
 * nothing is left behind, because a read holds nothing.
 */
export async function cancelStorageScan(): Promise<void> {
  return invoke<void>("cancel_storage_scan");
}
