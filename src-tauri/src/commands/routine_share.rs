//! Commands for shared routine files (development-plan.md section 92 Tier 5).
//! Thin wrappers over `services::routine_share` (section 86).
//!
//! Like section 69's backup, the user picks the file in an OS dialog and only
//! the path crosses the bridge, and import is two calls: inspect, then import.

use tauri::{AppHandle, State};

use crate::db::DbConnection;
use crate::services::routine_share::{self, RoutinePreview};
use crate::services::routines::{self, Routine};

/// The file name the save dialog offers for routine `id`.
#[tauri::command]
pub fn suggest_routine_file_name(db: State<DbConnection>, id: i64) -> Result<String, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let routine = routines::get(&conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Routine {id} was not found."))?;
    Ok(routine_share::suggested_file_name(&routine.name))
}

#[tauri::command]
pub fn export_routine(
    app: AppHandle,
    db: State<DbConnection>,
    id: i64,
    path: String,
) -> Result<(), String> {
    let version = app.package_info().version.to_string();
    let conn = db.lock().map_err(|e| e.to_string())?;
    routine_share::export_to_file(&conn, id, &version, &path).map_err(|e| e.to_string())
}

/// Reads a shared routine file and describes what importing it would create.
/// Creates nothing.
#[tauri::command]
pub fn inspect_routine_file(db: State<DbConnection>, path: String) -> Result<RoutinePreview, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routine_share::inspect_file(&conn, &path).map_err(|e| e.to_string())
}

/// Creates a routine from a shared file, with any command switched off.
#[tauri::command]
pub fn import_routine_file(db: State<DbConnection>, path: String) -> Result<Routine, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routine_share::import_from_file(&conn, &path).map_err(|e| e.to_string())
}
