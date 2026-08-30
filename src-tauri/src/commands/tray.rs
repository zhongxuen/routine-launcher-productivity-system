//! Commands for the system tray (development-plan.md sections 27, 79).
//!
//! There is deliberately almost nothing here. The tray menu is built and
//! handled in Rust (`services/tray.rs`) and its items reach the frontend as
//! an event rather than an `invoke`, so the only thing the UI needs to ask
//! the backend is the one preference section 27 leaves to the user: whether
//! closing the main window puts it in the tray or quits.

use tauri::{AppHandle, State};

use crate::db::DbConnection;
use crate::services::settings;
use crate::services::tray::{self, MINIMIZE_TO_TRAY_KEY};

/// Whether closing the main window minimises to the tray. True on a fresh
/// install — see `services::tray::minimize_on_close`.
#[tauri::command]
pub fn get_minimize_to_tray(db: State<DbConnection>) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    settings::get_bool(&conn, MINIMIZE_TO_TRAY_KEY, true).map_err(|e| e.to_string())
}

/// Turns close-to-tray on or off, answering with what was stored.
///
/// Turning it *off* is the opt-out section 27's tray needs to be tolerable:
/// the app then quits when its window is closed, like any other, and the tray
/// icon is only there while it is running.
#[tauri::command]
pub fn set_minimize_to_tray(db: State<DbConnection>, enabled: bool) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    settings::set_bool(&conn, MINIMIZE_TO_TRAY_KEY, enabled).map_err(|e| e.to_string())?;
    Ok(enabled)
}

/// Rebuilds the tray menu now.
///
/// The tray already keeps itself current from the `app://data-changed`
/// broadcast and from the pointer arriving on the icon, so nothing in the app
/// needs to call this. It exists for the cases those two miss by design — a
/// window that wants the menu to agree with something it has just done
/// locally, without announcing a change it did not make.
#[tauri::command]
pub fn refresh_tray_menu(app: AppHandle) {
    tray::refresh(&app);
}
