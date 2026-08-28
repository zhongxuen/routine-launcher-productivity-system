//! `invoke`-able recurrence commands. Thin wrappers over
//! `services::task_recurrence` (section 86).
//!
//! Rules are created and edited through the task they belong to
//! (`create_task` / `update_task` take a `recurrence` field), so there is no
//! create or update command here — only the reads the Recurring view needs
//! and the delete that ends a series.

use tauri::State;

use crate::db::DbConnection;
use crate::services::task_recurrence::{self, Recurrence};

/// Every repeat schedule, for labelling the tasks that point at one.
#[tauri::command]
pub fn list_task_recurrences(db: State<DbConnection>) -> Result<Vec<Recurrence>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    task_recurrence::list(&conn).map_err(|e| e.to_string())
}

/// Returns `null` rather than an error when the rule does not exist.
#[tauri::command]
pub fn get_task_recurrence(
    db: State<DbConnection>,
    id: i64,
) -> Result<Option<Recurrence>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    task_recurrence::get(&conn, id).map_err(|e| e.to_string())
}

/// Ends a series. The tasks it already produced are kept and become ordinary
/// one-off tasks.
#[tauri::command]
pub fn delete_task_recurrence(db: State<DbConnection>, id: i64) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    task_recurrence::delete(&conn, id).map_err(|e| e.to_string())
}
