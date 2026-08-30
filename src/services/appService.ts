/**
 * The application-as-an-installed-program side of the `invoke` boundary
 * (development-plan.md section 85).
 *
 * Everything else in this folder is about what the app *holds* — tasks,
 * routines, focus sessions, files on disk. This one is about the app itself:
 * which build is running, and whether Windows starts it.
 *
 * Launch-at-startup goes through this app's own commands rather than through
 * `@tauri-apps/plugin-autostart`, which is loaded in Rust but not granted to
 * any window. Section 86's rule is that native OS operations belong behind a
 * command, and writing the `Run` key of the registry is exactly that — see
 * `src-tauri/src/services/startup.rs`.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * The running build's version, as `major.minor.patch`.
 *
 * Read from the bundle, so it is the same number the installer stamped and
 * the same one Apps & features lists.
 */
export async function getAppVersion(): Promise<string> {
  return invoke<string>("get_app_version");
}

/**
 * Whether the app is registered to launch when Windows starts.
 *
 * Read from the registry on every call rather than from a cached preference:
 * the user can remove the entry from Task Manager's Startup tab without ever
 * opening this app, and the switch should show that when they come back.
 */
export async function getLaunchAtStartup(): Promise<boolean> {
  return invoke<boolean>("get_launch_at_startup");
}

/**
 * Adds or removes the Windows startup entry, answering with what is actually
 * registered afterwards.
 *
 * Trust the answer over the argument. A machine whose `Run` key is managed by
 * policy will accept the call and change nothing, and the returned value is
 * what the switch should end up showing.
 */
export async function setLaunchAtStartup(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("set_launch_at_startup", { enabled });
}
