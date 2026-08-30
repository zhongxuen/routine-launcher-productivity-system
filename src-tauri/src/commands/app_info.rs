//! Commands about the application as an *installed program* rather than
//! about anything in it (development-plan.md section 85).
//!
//! Two subjects, one module, because Settings shows them as one group: which
//! build this is, and whether Windows starts it. Neither has anything to do
//! with tasks, routines or focus, and neither reads the database.
//!
//! The version is answered from `package_info()`, which the build embeds from
//! `tauri.conf.json` — the same number the installer is stamped with, so what
//! the About card shows and what Apps & features lists can never disagree.
//! See `scripts/set-version.mjs` for what keeps the four places that carry it
//! in step.

use tauri::AppHandle;

use crate::services::startup;

/// The running build's version, as `major.minor.patch`.
///
/// Read from the bundle rather than from a constant in the source, so a
/// build's own claim about itself comes from the thing that was built.
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Whether the app is registered to launch when Windows starts.
#[tauri::command]
pub fn get_launch_at_startup(app: AppHandle) -> Result<bool, String> {
    startup::is_enabled(&app)
}

/// Adds or removes the Windows startup entry, answering with what is
/// registered afterwards.
///
/// The answer is re-read from the registry rather than echoed, so a switch
/// that could not actually be flipped comes back in the position it is really
/// in — see `services::startup::set_enabled`.
#[tauri::command]
pub fn set_launch_at_startup(app: AppHandle, enabled: bool) -> Result<bool, String> {
    startup::set_enabled(&app, enabled)
}
