use tauri::State;

use crate::db::DbConnection;
use crate::services::health;

/// Temporary command that proves the SQLite round trip works end-to-end.
/// Called once from the Dashboard placeholder on mount. Remove/replace once
/// a real feature reads/writes the database from the UI.
#[tauri::command]
pub fn db_health_check(db: State<DbConnection>) -> Result<String, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    health::check(&conn).map_err(|e| e.to_string())
}
