//! Commands for section 55's rule-based suggestions. Thin wrappers over
//! `services::suggestions` (section 86).
//!
//! Neither changes a task. Taking a suggestion goes through the ordinary task
//! commands, from a click.

use tauri::State;

use crate::db::DbConnection;
use crate::services::suggestions::{self, Suggestion};

/// Every suggestion that applies now and has not been dismissed.
#[tauri::command]
pub fn list_suggestions(db: State<DbConnection>) -> Result<Vec<Suggestion>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    suggestions::list(&conn).map_err(|e| e.to_string())
}

/// Declines the suggestion `key` for good.
#[tauri::command]
pub fn dismiss_suggestion(db: State<DbConnection>, key: String) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    suggestions::dismiss(&conn, &key).map_err(|e| e.to_string())
}
