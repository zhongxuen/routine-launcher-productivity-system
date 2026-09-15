//! Commands for section 52's Daily Settings. Thin wrappers over
//! `services::settings` (section 86).
//!
//! One read and one write, each of the whole group: two of the nine settings
//! are only valid together, so the card saves them together and the service
//! checks them together. See [`DailySettings`].

use tauri::State;

use crate::db::DbConnection;
use crate::services::settings::{self, DailySettings};

/// All nine Daily Settings, each unset one as its default.
#[tauri::command]
pub fn get_daily_settings(db: State<DbConnection>) -> Result<DailySettings, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    settings::daily_settings(&conn).map_err(|e| e.to_string())
}

/// Validates and stores all nine, answering with what was stored. A refusal
/// is a sentence the card shows as it is, and writes nothing.
#[tauri::command]
pub fn set_daily_settings(
    db: State<DbConnection>,
    settings: DailySettings,
) -> Result<DailySettings, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    settings::set_daily_settings(&conn, settings).map_err(|e| e.to_string())
}
