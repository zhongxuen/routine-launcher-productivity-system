//! Commands for the phone companion (development-plan.md section 92 Tier 5).
//! Thin wrappers over `services::companion` (section 86).

use tauri::{AppHandle, Manager, State};

use crate::db::DbConnection;
use crate::services::companion::{self, CompanionStatus};

#[tauri::command]
pub fn get_companion_status(db: State<DbConnection>) -> Result<CompanionStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    companion::status(&conn).map_err(|e| e.to_string())
}

/// Switches the companion on (starts listening) or off (stops).
///
/// A port that will not open is reported on the status rather than thrown:
/// the switch stays on, so the user can pick another port.
#[tauri::command]
pub fn set_companion_enabled(
    app: AppHandle,
    db: State<DbConnection>,
    enabled: bool,
) -> Result<CompanionStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    companion::set_enabled(&conn, enabled).map_err(|e| e.to_string())?;
    if enabled {
        let port = companion::port(&conn).map_err(|e| e.to_string())?;
        if let Err(error) = companion::start(app.clone(), port) {
            crate::log_warn!("[companion] {error}");
        }
    } else {
        companion::stop();
    }
    companion::status(&conn).map_err(|e| e.to_string())
}

/// Changes the port, restarting the server if it is on.
#[tauri::command]
pub fn set_companion_port(
    app: AppHandle,
    db: State<DbConnection>,
    port: u16,
) -> Result<CompanionStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    companion::set_port(&conn, port).map_err(|e| e.to_string())?;
    if companion::enabled(&conn).map_err(|e| e.to_string())? {
        if let Err(error) = companion::start(app.clone(), port) {
            crate::log_warn!("[companion] {error}");
        }
    }
    companion::status(&conn).map_err(|e| e.to_string())
}

/// Issues a new pairing token. Every phone has to scan again.
#[tauri::command]
pub fn rotate_companion_token(db: State<DbConnection>) -> Result<CompanionStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    companion::rotate_token(&conn).map_err(|e| e.to_string())?;
    companion::status(&conn).map_err(|e| e.to_string())
}

/// Starts the companion at launch if the user left it on.
pub fn restore(app: &AppHandle) {
    let Some(db) = app.try_state::<DbConnection>() else {
        return;
    };
    let settings = db.lock().ok().and_then(|conn| {
        let on = companion::enabled(&conn).ok()?;
        let port = companion::port(&conn).ok()?;
        Some((on, port))
    });
    if let Some((true, port)) = settings {
        if let Err(error) = companion::start(app.clone(), port) {
            crate::log_warn!("[companion] could not start at launch: {error}");
        }
    }
}
