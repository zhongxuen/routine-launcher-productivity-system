//! `invoke`-able progression commands. Thin wrappers over `services::xp`
//! (section 86).
//!
//! Almost everything here is a *read*. That is the design, not an oversight:
//! XP is earned from the completions built in Stages 1, 2 and 4, and those
//! hooks live inside the services that own those completions, so there is no
//! "award me XP" command for a bug — or a devtools console — to call. The
//! frontend's job is to read where the user stands and to render it.
//!
//! The exception is [`complete_quest`], which the checklist calls when it
//! sees a quest finished. The caller only names the quest: Rust decides
//! whether it is one of today's, re-counts its requirement from the database,
//! and pays once per quest per day for what section 43 says the quest's band
//! is worth (section 88).

use tauri::State;

use crate::db::DbConnection;
use crate::services::quests::{self, DailyQuest};
use crate::services::xp::{
    self, Achievement, LevelProgress, Progress, QuestCompletion, StreakProgress, XpTransaction,
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// Level, streak and lifetime XP in one call — what the dashboard's Progress
/// widget and the Progress page both open with.
#[tauri::command]
pub fn get_progress(db: State<DbConnection>) -> Result<Progress, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    xp::progress(&conn).map_err(|e| e.to_string())
}

/// Section 45's `{level, xpIntoLevel, xpForNextLevel}`, on its own.
#[tauri::command]
pub fn get_level_progress(db: State<DbConnection>) -> Result<LevelProgress, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    xp::level_progress(&conn).map_err(|e| e.to_string())
}

/// Section 46's streak, recomputed from the days that actually counted.
#[tauri::command]
pub fn get_streak(db: State<DbConnection>) -> Result<StreakProgress, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    xp::streak(&conn).map_err(|e| e.to_string())
}

/// The XP ledger, newest first — section 63's audit trail. Also how a "+10
/// XP" toast finds out what the completion it is reacting to was worth.
#[tauri::command]
pub fn list_xp_transactions(
    db: State<DbConnection>,
    limit: Option<i64>,
) -> Result<Vec<XpTransaction>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    xp::list_transactions(&conn, limit).map_err(|e| e.to_string())
}

/// All six of section 47's achievements, locked and unlocked alike.
#[tauri::command]
pub fn list_achievements(db: State<DbConnection>) -> Result<Vec<Achievement>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    xp::list_achievements(&conn).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Quests (sections 44, 62)
// ---------------------------------------------------------------------------

/// The day's quests, at the daily quest count Settings holds, each with the
/// day's counts against its requirements. The checklist draws these; the
/// definitions and the counting are `services::quests`, and nowhere else.
#[tauri::command]
pub fn get_daily_quests(
    db: State<DbConnection>,
    date_key: String,
) -> Result<Vec<DailyQuest>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    quests::daily_quests(&conn, &date_key).map_err(|e| e.to_string())
}

/// The quests already paid for on a local date.
///
/// The frontend re-counts the day on every load, so it keeps concluding that
/// a finished objective is finished. This is how it tells that from one it
/// has not been paid for yet.
#[tauri::command]
pub fn list_quest_completions(
    db: State<DbConnection>,
    date_key: String,
) -> Result<Vec<QuestCompletion>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    xp::list_quest_completions(&conn, &date_key).map_err(|e| e.to_string())
}

/// Records a finished quest and pays for it, answering with what was granted.
///
/// Idempotent per quest per day: a second call — from a later load, or from
/// another window that reached the same conclusion at the same moment —
/// answers with the completion the first one recorded and grants nothing
/// more. Rejects a quest dated to any day but today, one the day does not
/// offer, and one whose requirement the database says is not met yet.
#[tauri::command]
pub fn complete_quest(
    db: State<DbConnection>,
    quest_id: String,
    date_key: String,
) -> Result<QuestCompletion, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    xp::complete_quest(&conn, &quest_id, &date_key).map_err(|e| e.to_string())
}
