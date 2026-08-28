//! `invoke`-able task category commands. Thin wrappers over
//! `services::task_categories` (section 86).

use tauri::State;

use crate::db::DbConnection;
use crate::services::task_categories::{
    self, NewTaskCategory, TaskCategory, TaskCategoryUpdate,
};

#[tauri::command]
pub fn list_task_categories(db: State<DbConnection>) -> Result<Vec<TaskCategory>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    task_categories::list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_task_category(
    db: State<DbConnection>,
    id: i64,
) -> Result<Option<TaskCategory>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    task_categories::get(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_task_category(
    db: State<DbConnection>,
    category: NewTaskCategory,
) -> Result<TaskCategory, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    task_categories::create(&conn, category).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_task_category(
    db: State<DbConnection>,
    id: i64,
    updates: TaskCategoryUpdate,
) -> Result<TaskCategory, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    task_categories::update(&conn, id, updates).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_task_category(db: State<DbConnection>, id: i64) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    task_categories::delete(&conn, id).map_err(|e| e.to_string())
}
