/**
 * The list of programs installed on this computer, and the file picker that
 * covers the ones it missed.
 *
 * Both answer the same question the routine builder asks — "which program?" —
 * and neither asks the user to know a path, which was the whole problem with
 * a plain text field: `Chrome` is not a path, `C:\Program Files\Google\Chrome
 * \Application\chrome.exe` is not something anyone types, and the field
 * accepted both and only worked with the second.
 *
 * Scanning is the backend's job (`src-tauri/src/services/installed_apps.rs`)
 * and it is cached there, so calling {@link listInstalledApps} again is cheap
 * unless `refresh` is set.
 */

import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import type { InstalledApp } from "@/types/installed-app";

/**
 * Every program this computer knows about, by display name.
 *
 * `refresh` rescans instead of answering from the cache — for the picker's
 * reload, after the user has installed something without restarting the app.
 * Never rejects: a source that cannot be read contributes nothing and the
 * rest of the list still arrives.
 */
export async function listInstalledApps(refresh = false): Promise<InstalledApp[]> {
  return invoke<InstalledApp[]>("list_installed_applications", { refresh });
}

/**
 * Asks the OS for a program file, returning `null` if the user cancelled.
 *
 * The escape hatch for anything the scan does not list — a portable app in a
 * folder, a script, a program installed somewhere unusual. Shortcuts are
 * offered too: pointing at one is how a user gets at something whose real
 * executable is buried, and the launcher opens it through the shell.
 */
export async function pickApplicationFile(): Promise<string | null> {
  const chosen = await openFileDialog({
    directory: false,
    multiple: false,
    title: "Choose a program",
    filters: [
      { name: "Programs and shortcuts", extensions: ["exe", "lnk", "bat", "cmd", "com"] },
      { name: "All files", extensions: ["*"] },
    ],
  });

  // `multiple: false` means the array form cannot happen; narrowing it is
  // cheaper than trusting that.
  if (Array.isArray(chosen)) return chosen[0] ?? null;
  return chosen ?? null;
}
