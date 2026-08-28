//! `invoke`-able task commands. Each one locks the connection, forwards to
//! `services::tasks`, and flattens the service error to a `String` the
//! frontend can surface. No SQL and no rules live here (section 86).
//!
//! Argument names are single words on purpose (`task`, `updates`, `filter`),
//! so the key the frontend passes to `invoke` is identical to the Rust
//! parameter name with no camelCase/snake_case conversion in between.

use tauri::State;

use crate::db::DbConnection;
use crate::services::tasks::{self, NewTask, Task, TaskFilter, TaskUpdate};

#[tauri::command]
pub fn create_task(db: State<DbConnection>, task: NewTask) -> Result<Task, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    tasks::create(&conn, task).map_err(|e| e.to_string())
}

/// Returns `null` rather than an error when the task does not exist, so the
/// caller can treat "deleted elsewhere" as an ordinary outcome.
#[tauri::command]
pub fn get_task(db: State<DbConnection>, id: i64) -> Result<Option<Task>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    tasks::get(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_task(db: State<DbConnection>, id: i64, updates: TaskUpdate) -> Result<Task, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    tasks::update(&conn, id, updates).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_task(db: State<DbConnection>, id: i64) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    tasks::delete(&conn, id).map_err(|e| e.to_string())
}

/// Backs every task view (Today / Upcoming / Inbox / Completed / Recurring)
/// plus the category, status and priority filters. Omitting `filter` lists
/// everything.
#[tauri::command]
pub fn list_tasks(db: State<DbConnection>, filter: Option<TaskFilter>) -> Result<Vec<Task>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    tasks::list(&conn, filter.unwrap_or_default()).map_err(|e| e.to_string())
}

/// Brings today's repeating tasks into existence (section 23) and returns the
/// ones that were missing. Safe to call on every load — a series that already
/// has today's task is left alone — so the frontend can simply run it before
/// listing rather than tracking when it last ran.
#[tauri::command]
pub fn ensure_recurring_tasks(db: State<DbConnection>) -> Result<Vec<Task>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    tasks::ensure_recurring_instances(&conn).map_err(|e| e.to_string())
}
