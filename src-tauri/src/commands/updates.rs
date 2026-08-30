//! Commands for section 85's update strategy.
//!
//! Four, in two pairs, and the split between them is not cosmetic.
//!
//! [`get_check_updates_on_launch`] and [`set_check_updates_on_launch`] are the
//! preference: one row in the `settings` table, read and written
//! synchronously with the connection borrowed for the length of the call.
//!
//! [`check_for_update`] and [`install_update`] talk to the network and are
//! therefore `async`, and neither takes the database — deliberately. An
//! `async` command that held the shared connection across an `await` would
//! hold it for the length of an HTTP request, and on a slow link that is the
//! tray, the reminder scheduler and every other window stopped dead behind a
//! download. `install_update` does need the connection for one moment (to
//! close the running focus session), and reaches for it through the app
//! handle at that moment rather than being handed it for the whole call —
//! see `services::updates::install`.
//!
//! The plugin's own JavaScript commands are not exposed to any window: see
//! `capabilities/desktop.json` and the module docs of `services::updates`.

use tauri::{AppHandle, State};

use crate::db::DbConnection;
use crate::services::updates::{self, AvailableUpdate};

/// Whether the app looks for a new release when it starts.
#[tauri::command]
pub fn get_check_updates_on_launch(db: State<DbConnection>) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    updates::check_on_launch(&conn).map_err(|e| e.to_string())
}

/// Turns the launch check on or off, answering with what was stored.
#[tauri::command]
pub fn set_check_updates_on_launch(
    db: State<DbConnection>,
    enabled: bool,
) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    updates::set_check_on_launch(&conn, enabled).map_err(|e| e.to_string())?;
    Ok(enabled)
}

/// Asks the release endpoint for anything newer than this build.
///
/// `null` means "up to date", which is an answer and not a failure — the card
/// says so in words rather than showing an error.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<AvailableUpdate>, String> {
    updates::check(&app).await
}

/// Downloads the newest release and runs its installer.
///
/// On success this never returns: the installer takes the machine and the
/// process ends. A frontend awaiting it should therefore treat the promise
/// settling at all as a failure to install, and only ever as that.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    updates::install(&app).await
}
