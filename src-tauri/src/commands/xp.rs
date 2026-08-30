//! `invoke`-able progression commands. Thin wrappers over `services::xp`
//! (section 86).
//!
//! Almost everything here is a *read*. That is the design, not an oversight:
//! XP is earned from the completions built in Stages 1, 2 and 4, and those
//! hooks live inside the services that own those completions, so there is no
//! "award me XP" command for a bug — or a devtools console — to call. The
//! frontend's job is to read where the user stands and to render it.
//!
//! The exception is [`complete_quest`], because a quest is finished by the
//! user ticking it off rather than by anything the backend can observe. It is
//! still guarded: once per quest per day, only on the day in question, and
//! for what section 43 says the quest's band is worth rather than for
//! whatever the caller asked to be paid.

use tauri::State;

use crate::db::DbConnection;
use crate::services::xp::{
    self, Achievement, CompletedQuest, LevelProgress, Progress, QuestCompletion, StreakProgress,
    XpTransaction,
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
/// more. Rejects a quest dated to any day but today.
#[tauri::command]
pub fn complete_quest(
    db: State<DbConnection>,
    quest: CompletedQuest,
    date_key: String,
) -> Result<QuestCompletion, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    xp::complete_quest(&conn, quest, &date_key).map_err(|e| e.to_string())
}
