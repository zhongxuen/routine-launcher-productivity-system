//! Commands for PLAN TODAY's top priorities (sections 20 and 51). Thin
//! wrappers over `services::daily_plans` (section 86).
//!
//! Argument names are single words (`date`, `priorities`) so the key the
//! frontend passes to `invoke` is the Rust parameter name as it stands.

use tauri::State;

use crate::db::DbConnection;
use crate::services::daily_plans::{self, DailyPlan};

/// The priorities picked for `date` (`YYYY-MM-DD`), rank 1 first.
#[tauri::command]
pub fn get_daily_plan(db: State<DbConnection>, date: String) -> Result<DailyPlan, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    daily_plans::get(&conn, &date).map_err(|e| e.to_string())
}

/// Replaces `date`'s priorities with `priorities` (task ids, rank 1 first; at
/// most three). A refusal writes nothing.
#[tauri::command]
pub fn set_daily_plan(
    db: State<DbConnection>,
    date: String,
    priorities: Vec<i64>,
) -> Result<DailyPlan, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    daily_plans::set(&conn, &date, priorities).map_err(|e| e.to_string())
}
