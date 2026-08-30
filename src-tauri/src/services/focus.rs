//! Focus session persistence — the record of actual focused work.
//!
//! Owns every SQL statement that touches the `focus_sessions` table (schema
//! in development-plan.md section 61, the fields it stands for in section 35,
//! the presets it supports in section 34). Commands in
//! `src-tauri/src/commands/focus.rs` stay thin and only forward here.
//!
//! **The clock lives in the frontend, the truth lives here.** Rust does not
//! run a timer: a background process ticking once a second would be a lot of
//! machinery to reproduce something the UI has to render anyway. Instead
//! `start` writes `started_at` immediately and `end` writes what actually
//! happened, so the elapsed time is always recoverable from two timestamps.
//! Reload the window mid-session and [`active`] hands the session back with
//! `elapsed_seconds` already counted — the clock picks up where it was rather
//! than starting over, and a session that is never ended (a crash, a closed
//! window) is still on record instead of vanishing.
//!
//! Breaks are deliberately not stored. A 25/5 preset's five minutes are not
//! focused work, and section 35's data exists to answer "how much did I
//! actually focus" — so the break is a countdown for the UI to run and
//! nothing the statistics in section 36 should ever add up.
//!
//! Timestamps are UTC `YYYY-MM-DD HH:MM:SS` strings from SQLite's
//! `datetime('now')`, matching every other table.

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, Value, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row, ToSql};
use serde::{Deserialize, Serialize};

use super::error::{ServiceError, ServiceResult};
use super::routines;
use super::validate::validate_optional_date;
use super::xp;

/// The longest a single custom session may be asked to run. Twelve hours is
/// far past any believable stretch of focus; the cap is here so a stray
/// keystroke in the minutes field cannot store a timer that never ends.
const MAX_PLANNED_SECONDS: i64 = 12 * 60 * 60;

/// The shortest custom session. Below a minute there is nothing to focus on.
const MIN_PLANNED_SECONDS: i64 = 60;

const MISSING_TASK: &str = "That task no longer exists.";
const MISSING_ROUTINE: &str = "That routine no longer exists.";

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/// The session lengths from development-plan.md section 34.
///
/// Only the focus half of each pair (the 25 of 25/5, the 50 of 50/10, the 90
/// of 90/15) lives here, because only focused time is measured and stored —
/// the break minutes belong to the countdown the UI runs afterwards, and are
/// defined next to it in `src/types/focus.ts`. `Custom` is any length the
/// user types, and `Stopwatch` counts up with no fixed end at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
// The wire values are section 34's own names for the presets, and are what
// the `preset` column stores, what `invoke` carries, and what the picker in
// `src/types/focus.ts` keys off — one vocabulary end to end. They are spelled
// out rather than derived because serde would render `Pomodoro25` as
// `pomodoro25`, and a preset called one thing in the database and another on
// the wire is a bug waiting to happen.
#[serde(rename_all = "snake_case")]
pub enum FocusPreset {
    /// 25 minutes of focus, 5 minutes of break.
    #[serde(rename = "25-5")]
    Pomodoro25,
    /// 50 minutes of focus, 10 minutes of break.
    #[serde(rename = "50-10")]
    Pomodoro50,
    /// 90 minutes of focus, 15 minutes of break.
    #[serde(rename = "90-15")]
    Pomodoro90,
    /// Whatever length the caller asked for.
    #[default]
    Custom,
    /// Count-up. No target, so `planned_seconds` is NULL and the session runs
    /// until the user stops it.
    Stopwatch,
}

impl FocusPreset {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pomodoro25 => "25-5",
            Self::Pomodoro50 => "50-10",
            Self::Pomodoro90 => "90-15",
            Self::Custom => "custom",
            Self::Stopwatch => "stopwatch",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "25-5" => Some(Self::Pomodoro25),
            "50-10" => Some(Self::Pomodoro50),
            "90-15" => Some(Self::Pomodoro90),
            "custom" => Some(Self::Custom),
            "stopwatch" => Some(Self::Stopwatch),
            _ => None,
        }
    }

    /// The focus half of the preset, in minutes. `None` for the two presets
    /// that have no length of their own: `Custom` is told one, `Stopwatch`
    /// never has one.
    pub fn focus_minutes(self) -> Option<i64> {
        match self {
            Self::Pomodoro25 => Some(25),
            Self::Pomodoro50 => Some(50),
            Self::Pomodoro90 => Some(90),
            Self::Custom | Self::Stopwatch => None,
        }
    }

    /// The break half of the preset, in minutes — the `5` of 25/5. `None` for
    /// the two presets that name no break: a `Custom` length is a length the
    /// user chose, not a Pomodoro, and a `Stopwatch` has no cycle at all.
    ///
    /// Nothing schedules this break; it is what the completion notification
    /// suggests when a session runs out (see `services/notifications.rs`).
    pub fn break_minutes(self) -> Option<i64> {
        match self {
            Self::Pomodoro25 => Some(5),
            Self::Pomodoro50 => Some(10),
            Self::Pomodoro90 => Some(15),
            Self::Custom | Self::Stopwatch => None,
        }
    }
}

impl ToSql for FocusPreset {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.as_str()))
    }
}

impl FromSql for FocusPreset {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let raw = value.as_str()?;
        Self::parse(raw)
            .ok_or_else(|| FromSqlError::Other(format!("unknown focus preset {raw:?}").into()))
    }
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// Every column of `focus_sessions` plus the derived `elapsed_seconds`,
/// `task_title` and `routine_name`, in the order [`FocusSession::from_row`]
/// reads them.
///
/// A running session's elapsed time is computed rather than stored, so a
/// caller that just reloaded gets the real figure without having to trust —
/// or reproduce — any arithmetic of its own. The two names are joined in for
/// the same reason: History (section 64) lists what each session was *for*,
/// and looking that up from the frontend would be a query per line.
const SESSION_COLUMNS: &str = "s.id, s.task_id, s.routine_id, s.preset, s.planned_seconds, \
     s.started_at, s.ended_at, s.duration_seconds, s.completed, s.interrupted, \
     CASE WHEN s.ended_at IS NULL \
          THEN MAX(0, CAST(strftime('%s', 'now') - strftime('%s', s.started_at) AS INTEGER)) \
          ELSE COALESCE(s.duration_seconds, 0) END AS elapsed_seconds, \
     t.title AS task_title, r.name AS routine_name";

/// The joined source [`SESSION_COLUMNS`] is selected from. Both joins are
/// LEFT joins: most sessions are attached to nothing, and one that was
/// attached to a since-deleted task has had its `task_id` cleared to NULL by
/// `ON DELETE SET NULL` — either way the session itself still counts.
const SESSION_SOURCE: &str = "focus_sessions AS s \
     LEFT JOIN tasks AS t ON t.id = s.task_id \
     LEFT JOIN routines AS r ON r.id = s.routine_id";

/// A focus session as stored (section 61), plus `elapsed_seconds`.
#[derive(Debug, Clone, Serialize)]
pub struct FocusSession {
    pub id: i64,
    /// The task being worked on (section 19), or null for a session that was
    /// launched on its own. Cleared by `ON DELETE SET NULL` if the task is
    /// deleted, so the focused time survives even when the work it was
    /// against does not.
    pub task_id: Option<i64>,
    /// The routine whose workspace this session was started with, or null.
    pub routine_id: Option<i64>,
    pub preset: FocusPreset,
    /// The length the session was meant to run for, or null for a stopwatch.
    pub planned_seconds: Option<i64>,
    pub started_at: String,
    /// Null while the session is still running.
    pub ended_at: Option<String>,
    /// The focused seconds the session actually recorded, written when it
    /// ends. Null while it is still running — read `elapsed_seconds` for
    /// that.
    pub duration_seconds: Option<i64>,
    /// The session ran to its target (or a stopwatch was deliberately
    /// stopped).
    pub completed: bool,
    /// The session was stopped early, or was still running when the app was
    /// closed. Always the opposite of `completed` once a session has ended;
    /// both are false while it is running.
    pub interrupted: bool,
    /// Derived: focused seconds so far. Wall-clock time since `started_at`
    /// while the session runs, and `duration_seconds` once it has ended.
    pub elapsed_seconds: i64,
    /// Derived: the title of the task this session is against, for History's
    /// "what was this?" line. Null when the session was independent — and
    /// also once the task has been deleted, which clears `task_id` with it.
    pub task_title: Option<String>,
    /// Derived: the name of the routine, on the same terms.
    pub routine_name: Option<String>,
}

impl FocusSession {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            task_id: row.get("task_id")?,
            routine_id: row.get("routine_id")?,
            preset: row.get("preset")?,
            planned_seconds: row.get("planned_seconds")?,
            started_at: row.get("started_at")?,
            ended_at: row.get("ended_at")?,
            duration_seconds: row.get("duration_seconds")?,
            completed: row.get("completed")?,
            interrupted: row.get("interrupted")?,
            elapsed_seconds: row.get("elapsed_seconds")?,
            task_title: row.get("task_title")?,
            routine_name: row.get("routine_name")?,
        })
    }
}

/// What starting a session accepts. Everything is optional: an independent
/// 25/5 session (section 34) is `{ "preset": "25-5" }` and nothing
/// else.
#[derive(Debug, Default, Deserialize)]
pub struct NewFocusSession {
    /// Checked against the `tasks` table, so a session can only point at a
    /// task that exists.
    #[serde(default)]
    pub task_id: Option<i64>,
    /// Checked against the `routines` table, likewise.
    #[serde(default)]
    pub routine_id: Option<i64>,
    /// Defaults to `Custom`, which then requires `planned_seconds`.
    #[serde(default)]
    pub preset: FocusPreset,
    /// Only meaningful for `Custom`, where it is required. The fixed presets
    /// derive their length from the preset itself and a stopwatch has none,
    /// so passing a conflicting value there is rejected rather than quietly
    /// ignored — a timer that runs for a different length than the caller
    /// asked for is worse than an error.
    #[serde(default)]
    pub planned_seconds: Option<i64>,
}

/// How a session ended.
#[derive(Debug, Deserialize)]
pub struct FocusSessionOutcome {
    /// True when the session reached its target (or a stopwatch was
    /// deliberately stopped), false when it was abandoned part-way. This is
    /// the finished/interrupted distinction section 35 asks for.
    pub completed: bool,
    /// The focused seconds the frontend measured, if it measured them.
    ///
    /// A paused timer is why this exists: wall-clock time between
    /// `started_at` and now counts the pause, and the point of the table is
    /// how much was actually *focused*. Omit it and the wall clock is used.
    /// A value larger than the wall clock is clamped down to it, so a wrong
    /// number can shorten a session's record but never inflate it.
    #[serde(default)]
    pub duration_seconds: Option<i64>,
}

/// Filters for [`list`]. All fields combine with AND; leaving everything
/// unset returns every session, newest first.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct FocusFilter {
    /// Only sessions against this task.
    pub task_id: Option<i64>,
    /// Only sessions against this routine.
    pub routine_id: Option<i64>,
    /// Only sessions started on or after this local date (`YYYY-MM-DD`) —
    /// "today's focus time" is `since` = today.
    pub since: Option<String>,
    /// Drop the session that is still running, which is what the History
    /// view (section 64) wants: a list of what has already happened.
    pub only_ended: bool,
    /// Cap the number of rows returned.
    pub limit: Option<i64>,
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

pub fn get(conn: &Connection, id: i64) -> ServiceResult<Option<FocusSession>> {
    conn.query_row(
        &format!("SELECT {SESSION_COLUMNS} FROM {SESSION_SOURCE} WHERE s.id = ?1"),
        params![id],
        FocusSession::from_row,
    )
    .optional()
    .map_err(ServiceError::from)
}

/// The session that is still running, if there is one.
///
/// This is what makes a session survive a reload: the frontend asks for it on
/// mount and rebuilds its clock from `started_at`/`elapsed_seconds` instead
/// of losing the time that passed. [`start`] keeps at most one session open,
/// so "the active session" is always unambiguous; the newest is returned
/// regardless, rather than failing, if a database ever holds more.
pub fn active(conn: &Connection) -> ServiceResult<Option<FocusSession>> {
    conn.query_row(
        &format!(
            "SELECT {SESSION_COLUMNS} FROM {SESSION_SOURCE} \
             WHERE s.ended_at IS NULL ORDER BY s.started_at DESC, s.id DESC LIMIT 1"
        ),
        [],
        FocusSession::from_row,
    )
    .optional()
    .map_err(ServiceError::from)
}

/// Past sessions, newest first — the History view of section 64 and the raw
/// material for the focus statistics of section 36.
pub fn list(conn: &Connection, filter: FocusFilter) -> ServiceResult<Vec<FocusSession>> {
    let mut clauses: Vec<String> = Vec::new();
    let mut args: Vec<Value> = Vec::new();

    if let Some(task_id) = filter.task_id {
        clauses.push(format!("s.task_id = ?{}", args.len() + 1));
        args.push(Value::Integer(task_id));
    }

    if let Some(routine_id) = filter.routine_id {
        clauses.push(format!("s.routine_id = ?{}", args.len() + 1));
        args.push(Value::Integer(routine_id));
    }

    // `started_at` is UTC; the comparison is against the user's local day, so
    // "since today" means the day the user is having, not UTC's.
    if let Some(since) = validate_optional_date("Start date", filter.since)? {
        clauses.push(format!(
            "date(s.started_at, 'localtime') >= date(?{})",
            args.len() + 1
        ));
        args.push(Value::Text(since));
    }

    if filter.only_ended {
        clauses.push("s.ended_at IS NOT NULL".to_owned());
    }

    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };

    let limit_clause = match filter.limit {
        Some(limit) if limit > 0 => {
            args.push(Value::Integer(limit));
            format!(" LIMIT ?{}", args.len())
        }
        _ => String::new(),
    };

    let sql = format!(
        "SELECT {SESSION_COLUMNS} FROM {SESSION_SOURCE}{where_clause} \
         ORDER BY s.started_at DESC, s.id DESC{limit_clause}"
    );

    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(args), FocusSession::from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(ServiceError::from)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/// Starts a session and returns it as stored, with `started_at` already
/// written — that write is the whole point of calling this the moment the
/// user presses Start rather than when they stop.
///
/// Any session still open is closed as interrupted first. Two clocks running
/// at once would double-count the same minutes, and a session left open by a
/// crash would otherwise sit there forever; either way the honest record is
/// "that one stopped, this one began".
pub fn start(conn: &Connection, new_session: NewFocusSession) -> ServiceResult<FocusSession> {
    let planned_seconds = planned_seconds_for(new_session.preset, new_session.planned_seconds)?;

    let transaction = conn.unchecked_transaction()?;

    validate_task(&transaction, new_session.task_id)?;
    validate_routine(&transaction, new_session.routine_id)?;

    if let Some(running) = active(&transaction)? {
        finish(&transaction, running.id, false, None)?;
    }

    transaction.execute(
        "INSERT INTO focus_sessions (task_id, routine_id, preset, planned_seconds, started_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        params![
            new_session.task_id,
            new_session.routine_id,
            new_session.preset,
            planned_seconds,
        ],
    )?;

    let id = transaction.last_insert_rowid();
    let session = require(get(&transaction, id)?, id)?;
    transaction.commit()?;
    Ok(session)
}

/// Ends a running session: stamps `ended_at`, stores the focused seconds, and
/// records whether it finished or was cut short (section 35).
pub fn end(conn: &Connection, id: i64, outcome: FocusSessionOutcome) -> ServiceResult<FocusSession> {
    if outcome.duration_seconds.is_some_and(|seconds| seconds < 0) {
        return Err(ServiceError::validation(
            "A focus session cannot have run for a negative time.",
        ));
    }

    let transaction = conn.unchecked_transaction()?;

    let session = require(get(&transaction, id)?, id)?;
    if session.ended_at.is_some() {
        return Err(ServiceError::validation(
            "That focus session has already ended.",
        ));
    }

    finish(&transaction, id, outcome.completed, outcome.duration_seconds)?;

    // Section 43's +25 XP for a completed session. Every way a session can
    // end goes through `finish`, but only the ones that come through *here*
    // are a user finishing one: the auto-close in `start` and the abandoned
    // session `close_abandoned` tidies up are both `completed: false` and
    // both earn nothing, which `award_focus_session` re-checks against the
    // row rather than trusting the argument.
    //
    // Inside the transaction, and behind `xp::note`, for the same reason the
    // task hook is: the session is recorded whether or not the XP row can be
    // written (section 50).
    if outcome.completed {
        xp::note(
            xp::award_focus_session(&transaction, id),
            &format!("completing focus session {id}"),
        );
    }

    let ended = require(get(&transaction, id)?, id)?;
    transaction.commit()?;
    Ok(ended)
}

/// Ends whatever session is running, if any, and reports it.
///
/// Called on startup when a previous run left a session open: nobody was
/// watching that clock, so the time it kept accumulating is not focus anyone
/// did. Returns `None` when there was nothing to close, so a caller can tell
/// "cleaned up an abandoned session" from "nothing was running".
pub fn end_active(
    conn: &Connection,
    outcome: FocusSessionOutcome,
) -> ServiceResult<Option<FocusSession>> {
    match active(conn)? {
        Some(session) => end(conn, session.id, outcome).map(Some),
        None => Ok(None),
    }
}

/// Records a session nobody is going to finish, as interrupted.
///
/// Called from the two places a clock stops being watched without anyone
/// pressing Finish (`src-tauri/src/lib.rs`): the window closing, and the next
/// launch finding a session a crash or a kill left open. Both are section
/// 76's abandoned session, and both are always interrupted, never completed —
/// a countdown that reached its target would have been ended by the UI that
/// was watching it.
///
/// Calling it at startup is also what makes resuming safe. It runs before any
/// window can ask what is running, so a session [`active`] reports afterwards
/// always belongs to *this* run — which is why the frontend is free to pick
/// its clock back up rather than having to wonder whether the time since
/// `started_at` was time anyone was there for.
///
/// The duration is the honest problem, and the reason this is not just
/// [`end_active`] with `completed: false`. Nobody was watching the clock
/// between the app closing and it opening again, so the wall clock since
/// `started_at` is not focus anyone did — an app closed on a Friday and
/// reopened on a Monday would otherwise record a weekend of it. The recorded
/// time is therefore capped at the length the session was *for*, and at
/// [`MAX_PLANNED_SECONDS`] for a stopwatch, which has no length of its own
/// and which this module already treats as past any believable stretch of
/// focus. [`finish`] clamps to the wall clock on top of that, so a session
/// closed two minutes in still records two minutes.
///
/// What it cannot subtract is time the session spent paused: that is measured
/// in the frontend and never stored, so a session paused and then closed on
/// records the length it was open for. The cap is what keeps that bounded,
/// and it is the reason the cap is applied here rather than only at startup.
pub fn close_abandoned(conn: &Connection) -> ServiceResult<Option<FocusSession>> {
    let Some(running) = active(conn)? else {
        return Ok(None);
    };

    let cap = running.planned_seconds.unwrap_or(MAX_PLANNED_SECONDS);
    end(
        conn,
        running.id,
        FocusSessionOutcome {
            completed: false,
            duration_seconds: Some(cap),
        },
    )
    .map(Some)
}

/// The shared write behind [`end`] and the auto-close in [`start`].
///
/// `duration_seconds` is clamped into `0..=wall_clock`: the recorded focus
/// can be shorter than the time the session was open (it was paused) but
/// never longer than the session existed for.
fn finish(
    conn: &Connection,
    id: i64,
    completed: bool,
    duration_seconds: Option<i64>,
) -> ServiceResult<()> {
    let wall_clock: i64 = conn.query_row(
        "SELECT MAX(0, CAST(strftime('%s', 'now') - strftime('%s', started_at) AS INTEGER))
         FROM focus_sessions WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )?;

    let duration = duration_seconds.map_or(wall_clock, |measured| measured.clamp(0, wall_clock));

    conn.execute(
        "UPDATE focus_sessions
            SET ended_at = datetime('now'),
                duration_seconds = ?2,
                completed = ?3,
                interrupted = ?4
          WHERE id = ?1",
        params![id, duration, completed, !completed],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Resolves the length a session should run for, and refuses the combinations
/// that cannot mean anything.
fn planned_seconds_for(preset: FocusPreset, requested: Option<i64>) -> ServiceResult<Option<i64>> {
    match preset {
        FocusPreset::Stopwatch => match requested {
            None => Ok(None),
            Some(_) => Err(ServiceError::validation(
                "A stopwatch counts up and has no set length. \
                 Use the Custom preset to focus for a fixed time.",
            )),
        },
        FocusPreset::Custom => match requested {
            Some(seconds) if (MIN_PLANNED_SECONDS..=MAX_PLANNED_SECONDS).contains(&seconds) => {
                Ok(Some(seconds))
            }
            Some(_) => Err(ServiceError::validation(
                "A custom focus session must be between 1 minute and 12 hours.",
            )),
            None => Err(ServiceError::validation(
                "A custom focus session needs a length.",
            )),
        },
        fixed => {
            let minutes = fixed
                .focus_minutes()
                .expect("the fixed presets always carry a focus length");
            let seconds = minutes * 60;
            match requested {
                None => Ok(Some(seconds)),
                Some(requested) if requested == seconds => Ok(Some(seconds)),
                Some(_) => Err(ServiceError::validation(format!(
                    "The {minutes}-minute preset always runs for {minutes} minutes. \
                     Use the Custom preset for a different length."
                ))),
            }
        }
    }
}

fn validate_task(conn: &Connection, task_id: Option<i64>) -> ServiceResult<()> {
    match task_id {
        Some(id) => {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )?;
            if exists {
                Ok(())
            } else {
                Err(ServiceError::validation(MISSING_TASK))
            }
        }
        None => Ok(()),
    }
}

fn validate_routine(conn: &Connection, routine_id: Option<i64>) -> ServiceResult<()> {
    match routine_id {
        Some(id) if routines::get(conn, id)?.is_none() => {
            Err(ServiceError::validation(MISSING_ROUTINE))
        }
        _ => Ok(()),
    }
}

fn require(session: Option<FocusSession>, id: i64) -> ServiceResult<FocusSession> {
    session.ok_or_else(|| ServiceError::not_found(format!("Focus session {id} was not found.")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;
    use crate::services::{routines, tasks};
    use serde_json::json;

    /// Builds payloads the way the frontend would — from JSON — so these
    /// tests also cover the serde contract the `invoke` boundary relies on.
    fn new_session(value: serde_json::Value) -> NewFocusSession {
        serde_json::from_value(value).expect("valid NewFocusSession payload")
    }

    fn outcome(value: serde_json::Value) -> FocusSessionOutcome {
        serde_json::from_value(value).expect("valid FocusSessionOutcome payload")
    }

    fn filter(value: serde_json::Value) -> FocusFilter {
        serde_json::from_value(value).expect("valid FocusFilter payload")
    }

    fn a_task(conn: &Connection) -> i64 {
        tasks::create(
            conn,
            serde_json::from_value(json!({ "title": "Finish React project" })).unwrap(),
        )
        .unwrap()
        .id
    }

    fn a_routine(conn: &Connection) -> i64 {
        routines::create(
            conn,
            serde_json::from_value(json!({ "name": "Deep Work" })).unwrap(),
        )
        .unwrap()
        .id
    }

    /// Backdates a session so the wall-clock arithmetic has something to
    /// measure without the test having to sleep.
    fn started_seconds_ago(conn: &Connection, id: i64, seconds: i64) {
        conn.execute(
            "UPDATE focus_sessions SET started_at = datetime('now', ?2) WHERE id = ?1",
            params![id, format!("-{seconds} seconds")],
        )
        .unwrap();
    }

    #[test]
    fn starting_a_preset_stores_its_length_and_leaves_the_session_open() {
        let conn = init_memory_db().unwrap();

        let session = start(&conn, new_session(json!({ "preset": "50-10" }))).unwrap();

        assert_eq!(session.preset, FocusPreset::Pomodoro50);
        assert_eq!(session.planned_seconds, Some(50 * 60));
        assert!(session.ended_at.is_none());
        assert!(session.duration_seconds.is_none());
        assert!(!session.completed);
        assert!(!session.interrupted);
        assert_eq!(active(&conn).unwrap().map(|s| s.id), Some(session.id));
    }

    #[test]
    fn a_stopwatch_has_no_target_and_a_custom_session_needs_one() {
        let conn = init_memory_db().unwrap();

        let stopwatch = start(&conn, new_session(json!({ "preset": "stopwatch" }))).unwrap();
        assert_eq!(stopwatch.planned_seconds, None);

        let custom = start(
            &conn,
            new_session(json!({ "preset": "custom", "planned_seconds": 15 * 60 })),
        )
        .unwrap();
        assert_eq!(custom.planned_seconds, Some(15 * 60));

        for rejected in [
            json!({ "preset": "custom" }),
            json!({ "preset": "custom", "planned_seconds": 30 }),
            json!({ "preset": "custom", "planned_seconds": 13 * 60 * 60 }),
            json!({ "preset": "stopwatch", "planned_seconds": 600 }),
            json!({ "preset": "25-5", "planned_seconds": 600 }),
        ] {
            assert!(
                start(&conn, new_session(rejected.clone())).is_err(),
                "{rejected} should be refused"
            );
        }
    }

    #[test]
    fn a_session_reports_the_time_that_has_passed_while_it_runs() {
        let conn = init_memory_db().unwrap();

        let session = start(&conn, new_session(json!({ "preset": "25-5" }))).unwrap();
        assert_eq!(session.elapsed_seconds, 0);

        started_seconds_ago(&conn, session.id, 90);

        // This is what a reloaded window reads back: the clock resumes at
        // 1:30, not at 0:00.
        let resumed = active(&conn).unwrap().unwrap();
        assert_eq!(resumed.id, session.id);
        assert_eq!(resumed.elapsed_seconds, 90);
    }

    #[test]
    fn ending_records_the_measured_duration_and_the_outcome() {
        let conn = init_memory_db().unwrap();

        let finished = start(&conn, new_session(json!({ "preset": "25-5" }))).unwrap();
        started_seconds_ago(&conn, finished.id, 25 * 60);
        let finished = end(
            &conn,
            finished.id,
            outcome(json!({ "completed": true, "duration_seconds": 25 * 60 })),
        )
        .unwrap();

        assert_eq!(finished.duration_seconds, Some(25 * 60));
        assert_eq!(finished.elapsed_seconds, 25 * 60);
        assert!(finished.completed);
        assert!(!finished.interrupted);
        assert!(finished.ended_at.is_some());

        let abandoned = start(&conn, new_session(json!({ "preset": "25-5" }))).unwrap();
        started_seconds_ago(&conn, abandoned.id, 120);
        let abandoned = end(&conn, abandoned.id, outcome(json!({ "completed": false }))).unwrap();

        assert_eq!(abandoned.duration_seconds, Some(120));
        assert!(!abandoned.completed);
        assert!(abandoned.interrupted);

        // Nothing is running once both have ended.
        assert!(active(&conn).unwrap().is_none());
    }

    #[test]
    fn a_paused_session_records_focused_time_and_cannot_record_more_than_it_ran_for() {
        let conn = init_memory_db().unwrap();

        // Open for 10 minutes, but 4 of them were spent paused.
        let paused = start(&conn, new_session(json!({ "preset": "stopwatch" }))).unwrap();
        started_seconds_ago(&conn, paused.id, 600);
        let paused = end(
            &conn,
            paused.id,
            outcome(json!({ "completed": true, "duration_seconds": 360 })),
        )
        .unwrap();
        assert_eq!(paused.duration_seconds, Some(360));

        // A figure larger than the session was ever open for is clamped down
        // rather than trusted.
        let inflated = start(&conn, new_session(json!({ "preset": "stopwatch" }))).unwrap();
        started_seconds_ago(&conn, inflated.id, 60);
        let inflated = end(
            &conn,
            inflated.id,
            outcome(json!({ "completed": true, "duration_seconds": 9_000 })),
        )
        .unwrap();
        assert_eq!(inflated.duration_seconds, Some(60));
    }

    #[test]
    fn starting_a_second_session_interrupts_the_one_still_running() {
        let conn = init_memory_db().unwrap();

        let first = start(&conn, new_session(json!({ "preset": "25-5" }))).unwrap();
        started_seconds_ago(&conn, first.id, 300);
        let second = start(&conn, new_session(json!({ "preset": "stopwatch" }))).unwrap();

        let first = get(&conn, first.id).unwrap().unwrap();
        assert!(first.ended_at.is_some());
        assert!(!first.completed);
        assert!(first.interrupted);
        assert_eq!(first.duration_seconds, Some(300));

        assert_eq!(active(&conn).unwrap().map(|s| s.id), Some(second.id));
    }

    #[test]
    fn a_session_can_only_be_ended_once() {
        let conn = init_memory_db().unwrap();

        let session = start(&conn, new_session(json!({ "preset": "stopwatch" }))).unwrap();
        end(&conn, session.id, outcome(json!({ "completed": true }))).unwrap();

        assert!(end(&conn, session.id, outcome(json!({ "completed": true }))).is_err());
        assert!(matches!(
            end(&conn, 9_999, outcome(json!({ "completed": true }))),
            Err(ServiceError::NotFound(_))
        ));
    }

    #[test]
    fn end_active_closes_a_session_left_open_by_the_previous_run() {
        let conn = init_memory_db().unwrap();

        assert!(end_active(&conn, outcome(json!({ "completed": false })))
            .unwrap()
            .is_none());

        let session = start(&conn, new_session(json!({ "preset": "90-15" }))).unwrap();
        started_seconds_ago(&conn, session.id, 45 * 60);

        let closed = end_active(&conn, outcome(json!({ "completed": false })))
            .unwrap()
            .expect("the running session is reported back");
        assert_eq!(closed.id, session.id);
        assert!(closed.interrupted);
        assert_eq!(closed.duration_seconds, Some(45 * 60));
    }

    #[test]
    fn a_session_the_app_was_closed_on_is_recorded_as_interrupted() {
        let conn = init_memory_db().unwrap();

        // Nothing was running, so there is nothing to close and nothing to
        // report — the ordinary case every launch takes.
        assert!(close_abandoned(&conn).unwrap().is_none());

        let session = start(&conn, new_session(json!({ "preset": "25-5" }))).unwrap();
        // The app was closed eight minutes in and reopened three days later.
        started_seconds_ago(&conn, session.id, 3 * 24 * 60 * 60);

        let closed = close_abandoned(&conn)
            .unwrap()
            .expect("the session the last run left open is reported back");

        assert_eq!(closed.id, session.id);
        assert!(closed.ended_at.is_some());
        assert!(!closed.completed);
        assert!(closed.interrupted, "an abandoned session is never complete");

        // Three days of "focus" is what the wall clock would have said. The
        // session was only ever *for* 25 minutes, so that is the most it can
        // have earned.
        assert_eq!(closed.duration_seconds, Some(25 * 60));

        // And with it closed, nothing is running: the next window to ask is
        // told there is no session to resume.
        assert!(active(&conn).unwrap().is_none());
    }

    #[test]
    fn an_abandoned_session_still_records_the_time_it_was_actually_open_for() {
        let conn = init_memory_db().unwrap();

        // Closed two minutes into a 90-minute session: the cap is the *most*
        // it can record, never the figure it is given.
        let short = start(&conn, new_session(json!({ "preset": "90-15" }))).unwrap();
        started_seconds_ago(&conn, short.id, 120);
        let short = close_abandoned(&conn).unwrap().unwrap();
        assert_eq!(short.duration_seconds, Some(120));
        assert!(short.interrupted);

        // A stopwatch has no length of its own, so the cap is the twelve hours
        // this module treats as past any believable stretch of focus — not the
        // week the app spent closed.
        let stopwatch = start(&conn, new_session(json!({ "preset": "stopwatch" }))).unwrap();
        started_seconds_ago(&conn, stopwatch.id, 7 * 24 * 60 * 60);
        let stopwatch = close_abandoned(&conn).unwrap().unwrap();
        assert_eq!(stopwatch.duration_seconds, Some(MAX_PLANNED_SECONDS));
        assert!(stopwatch.interrupted);
    }

    #[test]
    fn a_session_started_after_the_cleanup_is_the_one_a_reloaded_window_resumes() {
        let conn = init_memory_db().unwrap();

        // The order `lib.rs` and the frontend run in: the launch closes what
        // the last run left behind, and only then does a window ask what is
        // running. The two never fight over the same row.
        let stale = start(&conn, new_session(json!({ "preset": "50-10" }))).unwrap();
        started_seconds_ago(&conn, stale.id, 6 * 60 * 60);
        close_abandoned(&conn).unwrap();

        let live = start(&conn, new_session(json!({ "preset": "50-10" }))).unwrap();
        started_seconds_ago(&conn, live.id, 300);

        let resumed = active(&conn).unwrap().expect("this run's session");
        assert_eq!(resumed.id, live.id);
        assert_eq!(resumed.elapsed_seconds, 300);
        assert_ne!(resumed.id, stale.id);
    }

    #[test]
    fn a_session_can_be_attached_to_a_task_or_a_routine_but_not_to_a_missing_one() {
        let conn = init_memory_db().unwrap();
        let task_id = a_task(&conn);
        let routine_id = a_routine(&conn);

        let attached = start(
            &conn,
            new_session(json!({
                "preset": "50-10",
                "task_id": task_id,
                "routine_id": routine_id,
            })),
        )
        .unwrap();
        assert_eq!(attached.task_id, Some(task_id));
        assert_eq!(attached.routine_id, Some(routine_id));

        assert!(start(
            &conn,
            new_session(json!({ "preset": "stopwatch", "task_id": 9_999 }))
        )
        .is_err());
        assert!(start(
            &conn,
            new_session(json!({ "preset": "stopwatch", "routine_id": 9_999 }))
        )
        .is_err());

        // The failed starts must not have closed the session that is running.
        assert_eq!(active(&conn).unwrap().map(|s| s.id), Some(attached.id));
    }

    #[test]
    fn a_session_carries_the_names_of_what_it_was_attached_to() {
        let conn = init_memory_db().unwrap();
        let task_id = a_task(&conn);
        let routine_id = a_routine(&conn);

        let attached = start(
            &conn,
            new_session(json!({
                "preset": "50-10",
                "task_id": task_id,
                "routine_id": routine_id,
            })),
        )
        .unwrap();
        assert_eq!(attached.task_title.as_deref(), Some("Finish React project"));
        assert_eq!(attached.routine_name.as_deref(), Some("Deep Work"));

        end(&conn, attached.id, outcome(json!({ "completed": true }))).unwrap();
        let independent = start(&conn, new_session(json!({ "preset": "stopwatch" }))).unwrap();
        assert_eq!(independent.task_title, None);
        assert_eq!(independent.routine_name, None);
    }

    #[test]
    fn deleting_the_task_keeps_the_focused_time_on_record() {
        let conn = init_memory_db().unwrap();
        let task_id = a_task(&conn);

        let session = start(
            &conn,
            new_session(json!({ "preset": "25-5", "task_id": task_id })),
        )
        .unwrap();
        end(&conn, session.id, outcome(json!({ "completed": true }))).unwrap();
        tasks::delete(&conn, task_id).unwrap();

        let session = get(&conn, session.id).unwrap().unwrap();
        assert_eq!(session.task_id, None);
        assert_eq!(session.task_title, None);
        assert!(session.completed);
        assert_eq!(session.duration_seconds, Some(0));
    }

    #[test]
    fn history_lists_newest_first_and_filters_to_what_was_asked_for() {
        let conn = init_memory_db().unwrap();
        let task_id = a_task(&conn);

        let older = start(
            &conn,
            new_session(json!({ "preset": "25-5", "task_id": task_id })),
        )
        .unwrap();
        started_seconds_ago(&conn, older.id, 3 * 60 * 60);
        end(&conn, older.id, outcome(json!({ "completed": true }))).unwrap();

        let newer = start(&conn, new_session(json!({ "preset": "stopwatch" }))).unwrap();
        started_seconds_ago(&conn, newer.id, 60 * 60);
        end(&conn, newer.id, outcome(json!({ "completed": false }))).unwrap();

        let running = start(&conn, new_session(json!({ "preset": "50-10" }))).unwrap();

        let ids = |sessions: Vec<FocusSession>| -> Vec<i64> {
            sessions.into_iter().map(|s| s.id).collect()
        };

        assert_eq!(
            ids(list(&conn, filter(json!({}))).unwrap()),
            vec![running.id, newer.id, older.id]
        );
        assert_eq!(
            ids(list(&conn, filter(json!({ "only_ended": true }))).unwrap()),
            vec![newer.id, older.id]
        );
        assert_eq!(
            ids(list(&conn, filter(json!({ "task_id": task_id }))).unwrap()),
            vec![older.id]
        );
        assert_eq!(
            ids(list(&conn, filter(json!({ "limit": 1 }))).unwrap()),
            vec![running.id]
        );
    }

    #[test]
    fn history_can_start_from_a_local_date() {
        let conn = init_memory_db().unwrap();

        let today = start(&conn, new_session(json!({ "preset": "25-5" }))).unwrap();
        end(&conn, today.id, outcome(json!({ "completed": true }))).unwrap();

        let yesterday = start(&conn, new_session(json!({ "preset": "25-5" }))).unwrap();
        conn.execute(
            "UPDATE focus_sessions SET started_at = datetime('now', '-1 day') WHERE id = ?1",
            params![yesterday.id],
        )
        .unwrap();
        end(&conn, yesterday.id, outcome(json!({ "completed": true }))).unwrap();

        let local_today: String = conn
            .query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))
            .unwrap();
        let since_today = list(&conn, filter(json!({ "since": local_today }))).unwrap();

        assert_eq!(
            since_today.iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![today.id]
        );
        assert!(list(&conn, filter(json!({ "since": "not-a-date" }))).is_err());
    }

    /// The string the frontend sends and the string stored in the `preset`
    /// column have to be the same one, or a session would come back as a
    /// preset nobody picked.
    #[test]
    fn every_preset_has_one_spelling_on_the_wire_and_in_the_database() {
        for preset in [
            FocusPreset::Pomodoro25,
            FocusPreset::Pomodoro50,
            FocusPreset::Pomodoro90,
            FocusPreset::Custom,
            FocusPreset::Stopwatch,
        ] {
            assert_eq!(json!(preset), json!(preset.as_str()));
            assert_eq!(
                serde_json::from_value::<FocusPreset>(json!(preset.as_str())).unwrap(),
                preset
            );
        }
    }

    #[test]
    fn the_fixed_presets_carry_the_lengths_from_section_34() {
        assert_eq!(FocusPreset::Pomodoro25.focus_minutes(), Some(25));
        assert_eq!(FocusPreset::Pomodoro50.focus_minutes(), Some(50));
        assert_eq!(FocusPreset::Pomodoro90.focus_minutes(), Some(90));
        assert_eq!(FocusPreset::Custom.focus_minutes(), None);
        assert_eq!(FocusPreset::Stopwatch.focus_minutes(), None);
    }
}
