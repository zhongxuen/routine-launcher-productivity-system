//! Commands for section 84's first-run walkthrough.
//!
//! Two, and both are the same key seen from the two directions the frontend
//! needs it: "should I run the tour?" at startup, and "never again" when it
//! ends. Everything the tour actually *does* — creating the first task, the
//! first routine, linking one to the other — goes through the commands those
//! features already own, so there is nothing here about any of it.

use tauri::State;

use crate::db::DbConnection;
use crate::services::onboarding;

/// Whether the walkthrough has already been seen. False on a fresh install.
#[tauri::command]
pub fn get_onboarding_seen(db: State<DbConnection>) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    onboarding::is_seen(&conn).map_err(|e| e.to_string())
}

/// Records that the walkthrough has been seen — or puts it back for the
/// Settings card's "show it again" — answering with what was stored.
#[tauri::command]
pub fn set_onboarding_seen(db: State<DbConnection>, seen: bool) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    onboarding::set_seen(&conn, seen).map_err(|e| e.to_string())?;
    Ok(seen)
}
