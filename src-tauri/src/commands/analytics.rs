//! `invoke`-able analytics commands. Thin wrappers over
//! `services::analytics` (development-plan.md section 86).
//!
//! Every one is a read. There is nothing to write: the figures of sections 33,
//! 36 and 82 are aggregates of tasks, focus sessions and routine launches
//! that the other services already record, so there is no command here a bug
//! — or a devtools console — could call to make a week look better than it
//! was.

use tauri::State;

use crate::db::DbConnection;
use crate::services::analytics::{self, ProductivityStats, RoutineStatistics};

/// Sections 36 and 82's Today and This Week panels, plus the week's routine
/// usage, its best day and four weeks of streak history — in one call.
///
/// One command rather than seven because the panels are read together and all
/// of them are measured against the same local "today"; see
/// [`analytics::productivity_stats`].
#[tauri::command]
pub fn get_productivity_stats(db: State<DbConnection>) -> Result<ProductivityStats, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    analytics::productivity_stats(&conn).map_err(|e| e.to_string())
}

/// Section 33's five figures for every routine, in one read — what the cards
/// on the Routines page and the panel one of them opens both draw from.
#[tauri::command]
pub fn list_routine_statistics(db: State<DbConnection>) -> Result<Vec<RoutineStatistics>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    analytics::routine_statistics(&conn).map_err(|e| e.to_string())
}

/// The same figures for one routine. `None` if it no longer exists, which is
/// a normal answer for a panel left open while the routine was deleted rather
/// than an error.
#[tauri::command]
pub fn get_routine_statistics(
    db: State<DbConnection>,
    routine_id: i64,
) -> Result<Option<RoutineStatistics>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    analytics::routine_statistics_for(&conn, routine_id).map_err(|e| e.to_string())
}
