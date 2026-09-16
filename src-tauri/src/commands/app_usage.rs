//! Commands for application usage tracking (development-plan.md section 37).
//! Thin wrappers over `services::app_usage` (section 86).

use tauri::State;

use crate::db::DbConnection;
use crate::services::app_usage::{self, UsageSummary};

/// Usage over the last `days` local days, today included.
#[tauri::command]
pub fn get_app_usage(db: State<DbConnection>, days: i64) -> Result<UsageSummary, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    app_usage::summary(&conn, days).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_usage_tracking_enabled(db: State<DbConnection>) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    app_usage::tracking_enabled(&conn).map_err(|e| e.to_string())
}

/// Switches tracking on or off, and answers what was stored.
#[tauri::command]
pub fn set_usage_tracking_enabled(db: State<DbConnection>, enabled: bool) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    app_usage::set_tracking_enabled(&conn, enabled).map_err(|e| e.to_string())
}

/// Deletes all recorded usage. The switch is left alone.
#[tauri::command]
pub fn clear_app_usage(db: State<DbConnection>) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    app_usage::clear(&conn).map_err(|e| e.to_string())
}
