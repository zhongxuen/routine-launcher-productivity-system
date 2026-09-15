//! The record of what the user did with the cleanup utilities
//! (development-plan.md sections 43, 44, 47, 67).
//!
//! The cleanup quest ("Organize Downloads") and the Organized achievement
//! both need to know that cleanup happened. The utilities themselves store
//! nothing, so this module keeps the smallest record that answers the
//! question: which utility, which action, how many items, when. It never
//! stores paths or file names. See `0009_cleanup_actions.sql`.
//!
//! # Section 67: the arrow only points one way
//!
//! A file action writes a row here. The quest and the achievement read the
//! rows. Nothing reads this table to decide what to do to a file, and
//! nothing here can reach a file, so a quest cannot cause a move or a delete
//! by any path through the code. It can only notice one that the user
//! already confirmed in a review flow.
//!
//! # Section 88: a cleanup action earns nothing
//!
//! No XP is granted here. Deleting one file ten times a day is button
//! clicking, which section 88 says XP must not reward. The payout for
//! cleanup goes through the quest: once a day, at the maintenance band's +25,
//! by the ordinary `xp::complete_quest` path. What [`note`] does call is
//! [`xp::evaluate`], so the tenth day with a cleanup action unlocks Organized
//! when it happens rather than on the next completed task. That unlock pays
//! the achievement's own reward, the same as every other achievement.
//!
//! # Failures are not the user's problem
//!
//! By the time a row is written, the files have already moved. A record
//! that cannot be written must not turn a successful move into an error
//! message, so the command layer calls [`note`], which logs a failure and
//! drops it, the way `xp::note` does for XP.

use rusqlite::types::{ToSql, ToSqlOutput};
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::db::DbConnection;
use crate::services::error::ServiceResult;
use crate::services::validate::validate_date;
use crate::services::xp;

/// Which utility ran the action. Stored as the `utility` column.
///
/// Storage, the sixth utility under Cleanup, has no variant because it has
/// no file actions: it reports sizes and links into Large Files and
/// Duplicates, and those two record their own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupUtility {
    Downloads,
    Desktop,
    Duplicates,
    LargeFiles,
    Screenshots,
}

impl CleanupUtility {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Downloads => "downloads",
            Self::Desktop => "desktop",
            Self::Duplicates => "duplicates",
            Self::LargeFiles => "large_files",
            Self::Screenshots => "screenshots",
        }
    }
}

impl ToSql for CleanupUtility {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.as_str()))
    }
}

/// What was done. Stored as the `action` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupAction {
    Move,
    Delete,
    /// Large Files' move into the dated archive folder.
    Archive,
    /// The Screenshot Organizer's move into dated folders.
    Organize,
}

impl CleanupAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Move => "move",
            Self::Delete => "delete",
            Self::Archive => "archive",
            Self::Organize => "organize",
        }
    }
}

impl ToSql for CleanupAction {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.as_str()))
    }
}

/// How many cleanup actions each utility recorded on one local day.
///
/// Counts of actions, not of files: organizing forty screenshots at once is
/// one action. The cleanup quest only asks whether its utility's count is
/// above zero, so the number says "you did this today" and nothing more.
///
/// camelCase on the wire, like the rest of the quest surface
/// (`src/types/quest.ts`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupDay {
    pub downloads: i64,
    pub desktop: i64,
    pub duplicates: i64,
    pub large_files: i64,
    pub screenshots: i64,
}

/// Writes one row for a confirmed action. Answers whether a row was written.
///
/// `item_count` is how many items the action actually handled. Zero writes
/// nothing: an action where every file failed, or a list that was empty,
/// did no cleanup, and a row for it would let a quest tick over on a failure.
pub fn record(
    conn: &Connection,
    utility: CleanupUtility,
    action: CleanupAction,
    item_count: usize,
) -> ServiceResult<bool> {
    if item_count == 0 {
        return Ok(false);
    }

    conn.execute(
        "INSERT INTO cleanup_actions (utility, action, item_count) VALUES (?1, ?2, ?3)",
        params![
            utility,
            action,
            i64::try_from(item_count).unwrap_or(i64::MAX)
        ],
    )?;
    Ok(true)
}

/// [`record`], called from a command after the files have been handled.
///
/// Takes the lock itself, because the commands deliberately do not hold it
/// while they read or write the disk. After a row is written, the
/// achievements are judged, so a tenth cleanup day unlocks Organized at once.
/// Every failure is logged and dropped. See the module docs for why.
pub fn note(db: &DbConnection, utility: CleanupUtility, action: CleanupAction, succeeded: usize) {
    if succeeded == 0 {
        return;
    }

    let occasion = format!("a {} {}", utility.as_str(), action.as_str());
    let conn = match db.lock() {
        Ok(conn) => conn,
        Err(error) => {
            crate::log_error!("[cleanup] could not record {occasion}: {error}");
            return;
        }
    };

    match record(&conn, utility, action, succeeded) {
        Ok(true) => {
            if let Err(error) = xp::evaluate(&conn) {
                crate::log_error!(
                    "[cleanup] could not judge achievements after {occasion}: {error}"
                );
            }
        }
        Ok(false) => {}
        Err(error) => crate::log_error!("[cleanup] could not record {occasion}: {error}"),
    }
}

/// The actions recorded on a local date, `YYYY-MM-DD`, per utility.
///
/// Timestamps are stored as UTC, so each one is converted with
/// `'localtime'` before it is compared: an organize at 11pm belongs to the
/// evening the user did it in. This is the same conversion `xp.rs` uses for
/// the streak and for Organized's day count.
pub fn day(conn: &Connection, date_key: &str) -> ServiceResult<CleanupDay> {
    let date_key = validate_date("Cleanup date", date_key)?;

    let mut statement = conn.prepare(
        "SELECT utility, COUNT(*) AS actions
           FROM cleanup_actions
          WHERE DATE(created_at, 'localtime') = ?1
          GROUP BY utility",
    )?;
    let rows = statement.query_map(params![date_key], |row| {
        Ok((
            row.get::<_, String>("utility")?,
            row.get::<_, i64>("actions")?,
        ))
    })?;

    let mut day = CleanupDay::default();
    for row in rows {
        let (utility, actions) = row?;
        // A utility this build does not know (a backup from a later version)
        // is left out rather than refused. It cannot be any quest's utility.
        match utility.as_str() {
            "downloads" => day.downloads = actions,
            "desktop" => day.desktop = actions,
            "duplicates" => day.duplicates = actions,
            "large_files" => day.large_files = actions,
            "screenshots" => day.screenshots = actions,
            _ => {}
        }
    }
    Ok(day)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::db::init_memory_db;

    fn today(conn: &Connection) -> String {
        conn.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))
            .unwrap()
    }

    fn rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM cleanup_actions", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn an_action_that_handled_nothing_is_not_recorded() {
        let conn = init_memory_db().unwrap();

        assert!(!record(&conn, CleanupUtility::Downloads, CleanupAction::Delete, 0).unwrap());
        assert_eq!(
            rows(&conn),
            0,
            "a delete where every file failed did no cleanup"
        );

        assert!(record(&conn, CleanupUtility::Downloads, CleanupAction::Delete, 3).unwrap());
        assert_eq!(rows(&conn), 1);
    }

    #[test]
    fn a_row_holds_no_path_or_file_name() {
        // What the table *can* hold, checked against the schema itself, so a
        // later migration that adds a `path` column fails here first.
        let conn = init_memory_db().unwrap();
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(cleanup_actions)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();

        assert_eq!(
            columns,
            ["id", "utility", "action", "item_count", "created_at"]
        );
    }

    #[test]
    fn a_day_is_counted_per_utility_in_local_time() {
        let conn = init_memory_db().unwrap();
        record(&conn, CleanupUtility::Downloads, CleanupAction::Move, 4).unwrap();
        record(&conn, CleanupUtility::Downloads, CleanupAction::Delete, 1).unwrap();
        record(
            &conn,
            CleanupUtility::Screenshots,
            CleanupAction::Organize,
            40,
        )
        .unwrap();

        // Yesterday's action is not today's.
        record(&conn, CleanupUtility::Desktop, CleanupAction::Move, 2).unwrap();
        conn.execute(
            "UPDATE cleanup_actions SET created_at = datetime('now', '-1 day')
              WHERE utility = 'desktop'",
            [],
        )
        .unwrap();

        assert_eq!(
            day(&conn, &today(&conn)).unwrap(),
            CleanupDay {
                downloads: 2,
                screenshots: 1,
                ..CleanupDay::default()
            },
            "actions are counted, not files, and yesterday's desktop move is not today's"
        );
    }

    #[test]
    fn a_day_has_to_be_a_date() {
        let conn = init_memory_db().unwrap();
        assert!(day(&conn, "today").is_err());
    }

    #[test]
    fn noting_an_action_earns_no_xp() {
        // Section 88. The quest pays for cleanup, once a day; the action
        // itself is worth nothing, however many times it is repeated.
        let conn = init_memory_db().unwrap();
        let db = Mutex::new(conn);

        for _ in 0..5 {
            note(&db, CleanupUtility::LargeFiles, CleanupAction::Delete, 1);
        }

        let conn = db.lock().unwrap();
        assert_eq!(rows(&conn), 5);
        assert_eq!(xp::total_xp(&conn).unwrap(), 0);
    }

    #[test]
    fn the_tenth_cleanup_day_unlocks_organized_as_it_happens() {
        let conn = init_memory_db().unwrap();
        for days_ago in 1..10 {
            record(&conn, CleanupUtility::Desktop, CleanupAction::Move, 1).unwrap();
            conn.execute(
                "UPDATE cleanup_actions SET created_at = datetime('now', ?1)
                  WHERE id = last_insert_rowid()",
                [format!("-{days_ago} days")],
            )
            .unwrap();
        }
        let db = Mutex::new(conn);

        note(&db, CleanupUtility::Downloads, CleanupAction::Delete, 2);

        let conn = db.lock().unwrap();
        let unlocked: bool = conn
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM user_achievements u
                       JOIN achievements a ON a.id = u.achievement_id
                      WHERE a.key = 'organized'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            unlocked,
            "the action that made ten days is the one that unlocks it"
        );
        assert_eq!(
            xp::total_xp(&conn).unwrap(),
            xp::ACHIEVEMENT_XP,
            "the unlock pays the achievement's reward, and the action itself nothing"
        );
    }
}
