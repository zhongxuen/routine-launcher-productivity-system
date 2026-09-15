//! The read side of the cleanup record (development-plan.md sections 44, 67).
//!
//! One command, and it only reads. Rows are written by the utilities' own
//! move / delete / archive / organize commands after the user confirmed
//! them, through `services::cleanup_actions::note`. There is no command that
//! writes a row, so no quest, and no stray `invoke`, can claim a cleanup
//! that did not happen.

use tauri::State;

use crate::db::DbConnection;
use crate::services::cleanup_actions::{self, CleanupDay};

/// How many cleanup actions each utility recorded on a local date — what the
/// cleanup quest is measured against.
#[tauri::command]
pub fn get_cleanup_day(db: State<DbConnection>, date_key: String) -> Result<CleanupDay, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    cleanup_actions::day(&conn, &date_key).map_err(|e| e.to_string())
}
