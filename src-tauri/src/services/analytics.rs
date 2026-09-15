//! Productivity analytics — the daily and weekly figures of
//! development-plan.md sections 36 and 82, and the per-routine figures of
//! section 33.
//!
//! This is the one service that owns no table. Every number here is read
//! *across* the tables the other services own — `tasks`, `focus_sessions`,
//! `routine_launches`, `routines`, `streaks` — and nothing in this file
//! writes. That is deliberate: an aggregate that is stored is an aggregate
//! that can drift from the rows it was made of, and the app is local-first
//! with a few thousand rows, so re-reading is cheaper than keeping a cache
//! honest. Delete a task, end a session, and the next read simply answers
//! differently.
//!
//! # What a figure is allowed to mean
//!
//! Section 88 asks the app not to flatter, and three decisions here follow
//! from it.
//!
//! * **Focus time counts completed sessions only.** An interrupted session
//!   records real seconds, but so does one the app was killed during, and a
//!   total a crash can inflate is not a total. This matches what section 47's
//!   Deep Work achievement already counts (`services/xp.rs::facts`), so the
//!   hours on the Statistics tab and the hours on the achievement tile are
//!   the same hours.
//! * **A launch is a row, not a counter.** `routines.launch_count` is a
//!   lifetime total and cannot be asked "how many today"; the dated
//!   `routine_launches` log can. See `0007_routine_launches.sql`.
//! * **The denominator is work that was owed, not work that exists.** "6 / 8"
//!   counts what was on the plate for the window — see [`PeriodStats`].
//!
//! # Days are local days
//!
//! Every timestamp in the database is UTC (`datetime('now')`), and every
//! bucket here is a local calendar day, so every date expression converts
//! with `'localtime'` first — the same rule the streak walk in
//! `services/xp.rs` follows. A session finished at 11pm on Friday belongs to
//! the Friday the user was living in.
//!
//! Application usage (section 37) is **not** built here. It is listed in the
//! plan as a "potential future feature", it needs a table `0001_init.sql`
//! deliberately deferred, and section 37 is emphatic that time an application
//! is open is not productive time. Rather than ship a figure the page would
//! have to disclaim, this pass leaves it out; see the note at the end of
//! `src/components/progress/ProgressStatistics.tsx`.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use super::error::ServiceResult;
use super::settings::{self, WeekStart};
use super::tasks::owed_by_predicate;
use super::xp::{self, StreakProgress};

/// How many days of streak history [`productivity_stats`] reads back.
///
/// Four weeks, so the calendar renders as four rows of seven with today in
/// the last one. Long enough to show a streak taking hold and short enough
/// that the grid stays readable at the size a tab panel gives it.
const HISTORY_DAYS: i64 = 28;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One local day's totals, and whether it counted towards the streak.
///
/// The day is carried as a `YYYY-MM-DD` key rather than as a weekday name so
/// the backend holds no opinion about wording or locale — "Wednesday" is the
/// frontend's rendering of it (`src/lib/analytics-utils.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayStats {
    /// Local `YYYY-MM-DD`.
    pub date: String,
    /// Seconds of *completed* focus that ended on this day.
    pub focus_seconds: i64,
    /// How many completed sessions those seconds came from.
    pub focus_sessions: i64,
    pub tasks_completed: i64,
    pub routine_launches: i64,
    /// Whether the day met section 46's rule — one task, one completed focus
    /// session, or one routine launch. The same condition the streak is
    /// counted from, so a filled square here is a day the flame kept.
    pub productive: bool,
}

/// The totals for a window of days — section 36's TODAY and THIS WEEK panels.
///
/// # `tasks_total`
///
/// The denominator is the work that was *owed* for the window, which is not
/// the same as the tasks that exist:
///
/// * every task completed inside the window, whenever it was due; plus
/// * every still-open task due by the end of the window, including ones
///   carried over from before it.
///
/// That is the same population the Today view lists (section 15) and the same
/// "3 / 7 completed" section 14 puts above it, so the Statistics tab and the
/// task list cannot report different fractions of the same day. Tasks with no
/// due date are counted only if they were finished in the window: an idea
/// sitting in the Inbox was never owed today, and letting it into the
/// denominator would make the percentage fall every time the user wrote
/// something down.
///
/// Cancelled tasks are in neither half. A task that was called off is not
/// work outstanding and not work done.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodStats {
    /// First local day of the window, `YYYY-MM-DD`.
    pub start: String,
    /// Last local day of the window, inclusive. Equal to `start` for TODAY,
    /// and the week's last day for THIS WEEK — which may be in the future.
    pub end: String,
    pub focus_seconds: i64,
    pub focus_sessions: i64,
    pub tasks_completed: i64,
    pub tasks_total: i64,
    pub routine_launches: i64,
}

/// How often one routine was launched inside a window (section 82's "routine
/// usage", and the "Most used routine" line of section 36).
///
/// The name and icon are copied in rather than left to a lookup, so the panel
/// can render the line from this alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineUsage {
    pub routine_id: i64,
    pub name: String,
    pub icon: Option<String>,
    pub launches: i64,
}

/// Everything the Statistics tab draws, in one read.
///
/// One command rather than seven, because the panels are read together and
/// every one of them needs the same local "today" — split across calls,
/// a load that straddled midnight could show a Today panel and a This Week
/// panel that disagreed about which day it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductivityStats {
    /// Local `YYYY-MM-DD` the whole payload was computed for.
    pub today_date: String,
    pub today: PeriodStats,
    pub week: PeriodStats,
    /// The seven days of the current week, from the week start in section
    /// 52's Daily Settings (Monday unless the user chose Sunday), including
    /// days still to come — which read as zeroes rather than being left out,
    /// so the week's bars keep their shape as it fills in.
    pub week_days: Vec<DayStats>,
    /// Every routine launched this week, most-launched first. Empty if none
    /// were. `[0]` is section 36's "Most used routine".
    pub routine_usage: Vec<RoutineUsage>,
    /// The day of this week with the most focus time, or `None` while the
    /// week is still empty — see [`most_productive_day`].
    pub most_productive_day: Option<DayStats>,
    /// Section 46's streak, recomputed on the way through.
    pub streak: StreakProgress,
    /// The last [`HISTORY_DAYS`] days ending today, oldest first — section
    /// 82's "streak history" as a calendar of days that counted.
    pub streak_history: Vec<DayStats>,
}

/// Section 33's five figures for one routine, all of them measured.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineStatistics {
    pub routine_id: i64,
    /// Lifetime launches — `routines.launch_count`, which predates the dated
    /// log and so counts launches the log never saw.
    pub launches: i64,
    /// Seconds of completed focus recorded against this routine.
    pub focus_seconds: i64,
    /// Mean length of one of those sessions, or `None` when there are none —
    /// a dash, not a zero, because no sessions is not a session of no length.
    pub average_session_seconds: Option<i64>,
    /// Tasks completed that name this routine (`tasks.routine_id`).
    pub tasks_completed: i64,
    /// UTC timestamp of the last launch, or `None` if never launched.
    pub last_used: Option<String>,
}

// ---------------------------------------------------------------------------
// The Statistics tab
// ---------------------------------------------------------------------------

/// Sections 36 and 82 in one read.
///
/// Recomputes the streak on the way through (`xp::streak`), for the same
/// reason the Progress widget does: opening the app the morning after a
/// productive day should show that day already counted rather than waiting
/// for the first completion of the new one.
pub fn productivity_stats(conn: &Connection) -> ServiceResult<ProductivityStats> {
    let window = Window::current(conn, settings::week_start(conn)?)?;
    stats_for(conn, &window)
}

/// [`productivity_stats`] for a given window, which is what lets the tests
/// pin the date.
fn stats_for(conn: &Connection, window: &Window) -> ServiceResult<ProductivityStats> {
    // One pass over the widest range anyone here asks about — the history
    // starts before the week does, and the week can end after today — then
    // sliced. The alternative is three date-bucketed queries that could each
    // land on a different side of midnight.
    let days = days_between(conn, &window.history_start, &window.week_end)?;
    let slice = |start: &str, end: &str| -> Vec<DayStats> {
        days.iter()
            .filter(|day| day.date.as_str() >= start && day.date.as_str() <= end)
            .cloned()
            .collect()
    };

    let week_days = slice(&window.week_start, &window.week_end);
    let streak_history = slice(&window.history_start, &window.today);

    let today = period(
        conn,
        &window.today,
        &window.today,
        &slice(&window.today, &window.today),
    )?;
    let week = period(conn, &window.week_start, &window.week_end, &week_days)?;

    Ok(ProductivityStats {
        today_date: window.today.clone(),
        today,
        week,
        most_productive_day: most_productive_day(&week_days),
        week_days,
        routine_usage: routine_usage(conn, &window.week_start, &window.week_end)?,
        streak: xp::streak(conn)?,
        streak_history,
    })
}

/// The local dates every panel is measured against.
///
/// The clock is read once, for today's date, and every other date is worked
/// out from that string rather than from `'now'` again — so the panels cannot
/// disagree about which day it is, even on a read that straddles midnight.
#[derive(Debug, Clone)]
struct Window {
    today: String,
    week_start: String,
    week_end: String,
    history_start: String,
}

impl Window {
    fn current(conn: &Connection, week_start: WeekStart) -> ServiceResult<Self> {
        let today: String =
            conn.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))?;
        Self::on(conn, &today, week_start)
    }

    /// The window around the local date `today`.
    ///
    /// The week is the seven days starting on the most recent `week_start`
    /// day, today included. `'-6 days'` then `'weekday N'` is the SQLite idiom
    /// for that: stepping back six days lands somewhere in the previous seven,
    /// and `weekday N` then moves forward to the first such day at or after it
    /// — which is this week's. Asking for `weekday N` on its own would answer
    /// with *next* week's whenever today is not that day.
    fn on(conn: &Connection, today: &str, week_start: WeekStart) -> ServiceResult<Self> {
        let back = format!("-{} days", HISTORY_DAYS - 1);

        Ok(conn.query_row(
            "SELECT date(?1, '-6 days', ?2) AS week_start,
                    date(?1, '-6 days', ?2, '+6 days') AS week_end,
                    date(?1, ?3) AS history_start",
            params![today, week_start.sqlite_modifier(), back],
            |row| {
                Ok(Self {
                    today: today.to_owned(),
                    week_start: row.get("week_start")?,
                    week_end: row.get("week_end")?,
                    history_start: row.get("history_start")?,
                })
            },
        )?)
    }
}

/// Every day from `start` to `end` inclusive, oldest first, with the three
/// counts each carries. Days with nothing on them are present as zeroes.
///
/// The calendar is generated in SQL rather than walked in Rust because the
/// crate has no date library and SQLite already has one that knows about
/// month ends, leap years and the user's timezone. The three aggregates are
/// grouped independently and joined onto it, so a day that only had a focus
/// session and a day that only had a task both come back as one row.
fn days_between(conn: &Connection, start: &str, end: &str) -> ServiceResult<Vec<DayStats>> {
    let mut statement = conn.prepare(
        "WITH RECURSIVE calendar(day) AS (
             SELECT ?1
             UNION ALL
             SELECT date(day, '+1 day') FROM calendar WHERE day < ?2
         ),
         focus AS (
             SELECT DATE(ended_at, 'localtime') AS day,
                    COALESCE(SUM(duration_seconds), 0) AS seconds,
                    COUNT(*) AS sessions
               FROM focus_sessions
              WHERE completed = 1 AND ended_at IS NOT NULL
              GROUP BY day
         ),
         done AS (
             SELECT DATE(completed_at, 'localtime') AS day, COUNT(*) AS tasks
               FROM tasks
              WHERE status = 'completed' AND completed_at IS NOT NULL
              GROUP BY day
         ),
         launched AS (
             SELECT DATE(launched_at, 'localtime') AS day, COUNT(*) AS launches
               FROM routine_launches
              GROUP BY day
         )
         SELECT calendar.day AS date,
                COALESCE(focus.seconds, 0) AS focus_seconds,
                COALESCE(focus.sessions, 0) AS focus_sessions,
                COALESCE(done.tasks, 0) AS tasks_completed,
                COALESCE(launched.launches, 0) AS routine_launches
           FROM calendar
           LEFT JOIN focus ON focus.day = calendar.day
           LEFT JOIN done ON done.day = calendar.day
           LEFT JOIN launched ON launched.day = calendar.day
          ORDER BY calendar.day",
    )?;

    let rows = statement.query_map(params![start, end], |row| {
        let focus_sessions: i64 = row.get("focus_sessions")?;
        let tasks_completed: i64 = row.get("tasks_completed")?;
        let routine_launches: i64 = row.get("routine_launches")?;

        Ok(DayStats {
            date: row.get("date")?,
            focus_seconds: row.get("focus_seconds")?,
            focus_sessions,
            tasks_completed,
            routine_launches,
            // Section 46's three ways, evaluated on the counts already read
            // rather than asked of the database again.
            productive: focus_sessions > 0 || tasks_completed > 0 || routine_launches > 0,
        })
    })?;

    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Totals a window's days and adds the one figure a day cannot carry: how
/// much was owed. See [`PeriodStats`] for what that means.
fn period(
    conn: &Connection,
    start: &str,
    end: &str,
    days: &[DayStats],
) -> ServiceResult<PeriodStats> {
    let tasks_completed = days.iter().map(|day| day.tasks_completed).sum();

    let outstanding: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM tasks WHERE {}",
            owed_by_predicate("?1")
        ),
        params![end],
        |row| row.get(0),
    )?;

    Ok(PeriodStats {
        start: start.to_owned(),
        end: end.to_owned(),
        focus_seconds: days.iter().map(|day| day.focus_seconds).sum(),
        focus_sessions: days.iter().map(|day| day.focus_sessions).sum(),
        tasks_completed,
        tasks_total: tasks_completed + outstanding,
        routine_launches: days.iter().map(|day| day.routine_launches).sum(),
    })
}

/// The week's best day, by focus time (section 36's "Most productive day").
///
/// Focus time decides it, with tasks completed and then routines launched
/// breaking ties, because "productive" in section 36 sits directly under a
/// focus figure and hours of work is the thing the user is being shown. A
/// week with nothing in it has no best day rather than a Monday with zero of
/// everything — naming a winner out of seven empty days would be the app
/// flattering (section 88).
///
/// Ties that survive all three tie-breaks resolve to the earliest day, since
/// the scan only replaces on a strict improvement.
fn most_productive_day(week: &[DayStats]) -> Option<DayStats> {
    week.iter()
        .filter(|day| day.productive)
        .max_by_key(|day| {
            // Negated date so that, among days that are otherwise equal,
            // `max_by_key` keeps the earliest rather than the last seen.
            (
                day.focus_seconds,
                day.tasks_completed,
                day.routine_launches,
                std::cmp::Reverse(day.date.clone()),
            )
        })
        .cloned()
}

/// Every routine launched between `start` and `end`, most-launched first.
fn routine_usage(conn: &Connection, start: &str, end: &str) -> ServiceResult<Vec<RoutineUsage>> {
    let mut statement = conn.prepare(
        "SELECT r.id AS routine_id, r.name AS name, r.icon AS icon,
                COUNT(*) AS launches
           FROM routine_launches AS l
           JOIN routines AS r ON r.id = l.routine_id
          WHERE DATE(l.launched_at, 'localtime') BETWEEN ?1 AND ?2
          GROUP BY r.id
          ORDER BY launches DESC, r.name COLLATE NOCASE, r.id",
    )?;

    let rows = statement.query_map(params![start, end], |row| {
        Ok(RoutineUsage {
            routine_id: row.get("routine_id")?,
            name: row.get("name")?,
            icon: row.get("icon")?,
            launches: row.get("launches")?,
        })
    })?;

    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

// ---------------------------------------------------------------------------
// Routine statistics (section 33)
// ---------------------------------------------------------------------------

/// Section 33's figures for every routine, in one read.
///
/// A list rather than a lookup per routine because the Routines page draws a
/// card for each: asking once per card would be one query per routine on
/// every load, and the whole answer is a single grouped join.
pub fn routine_statistics(conn: &Connection) -> ServiceResult<Vec<RoutineStatistics>> {
    let mut statement = conn.prepare(ROUTINE_STATISTICS_SQL)?;
    let rows = statement.query_map([], routine_statistics_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// One routine's figures, or `None` if there is no such routine.
pub fn routine_statistics_for(
    conn: &Connection,
    routine_id: i64,
) -> ServiceResult<Option<RoutineStatistics>> {
    let sql = format!("{ROUTINE_STATISTICS_SQL} HAVING r.id = ?1");
    Ok(conn
        .query_row(&sql, params![routine_id], routine_statistics_row)
        .optional()?)
}

/// Both readers share this, so a card and the panel it opens can never show
/// different numbers.
///
/// The two aggregates are sub-selects joined onto `routines` rather than
/// joins onto the raw tables, because joining both directly would multiply a
/// routine's sessions by its tasks and inflate every figure. `GROUP BY r.id`
/// closes the statement so [`routine_statistics_for`] can bolt a `HAVING` on
/// the end to pick one row.
const ROUTINE_STATISTICS_SQL: &str = "SELECT r.id AS routine_id,
            r.launch_count AS launches,
            r.last_launched_at AS last_used,
            COALESCE(f.seconds, 0) AS focus_seconds,
            COALESCE(f.sessions, 0) AS focus_sessions,
            COALESCE(t.tasks, 0) AS tasks_completed
       FROM routines AS r
       LEFT JOIN (
            SELECT routine_id,
                   COALESCE(SUM(duration_seconds), 0) AS seconds,
                   COUNT(*) AS sessions
              FROM focus_sessions
             WHERE completed = 1 AND routine_id IS NOT NULL
             GROUP BY routine_id
       ) AS f ON f.routine_id = r.id
       LEFT JOIN (
            SELECT routine_id, COUNT(*) AS tasks
              FROM tasks
             WHERE status = 'completed' AND routine_id IS NOT NULL
             GROUP BY routine_id
       ) AS t ON t.routine_id = r.id
      GROUP BY r.id";

fn routine_statistics_row(row: &Row<'_>) -> rusqlite::Result<RoutineStatistics> {
    let focus_seconds: i64 = row.get("focus_seconds")?;
    let sessions: i64 = row.get("focus_sessions")?;

    Ok(RoutineStatistics {
        routine_id: row.get("routine_id")?,
        launches: row.get("launches")?,
        focus_seconds,
        // Integer division: an average is rendered as "51m", so seconds of
        // precision below the rounding the UI does anyway would be noise.
        average_session_seconds: (sessions > 0).then(|| focus_seconds / sessions),
        tasks_completed: row.get("tasks_completed")?,
        last_used: row.get("last_used")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    fn conn() -> Connection {
        init_memory_db().expect("in-memory database")
    }

    /// A routine, returning its id.
    fn a_routine(conn: &Connection, name: &str) -> i64 {
        conn.execute("INSERT INTO routines (name) VALUES (?1)", params![name])
            .unwrap();
        conn.last_insert_rowid()
    }

    /// A UTC timestamp whose *local* date is `days` from today.
    ///
    /// Every read here buckets by `DATE(column, 'localtime')`, so a fixture
    /// written as a UTC "now" lands on the intended day everywhere except
    /// within one offset of midnight — where the test would pass in London
    /// and fail in Auckland. Pinning it to local noon and converting *back*
    /// to UTC makes the round trip exact: no real offset is twelve hours
    /// wide enough to move noon onto a neighbouring date.
    fn local_noon(days: i64) -> String {
        format!("datetime(date('now', 'localtime', '{days} days') || ' 12:00:00', 'utc')")
    }

    /// A launch of `routine_id`, `days` from today.
    fn launched(conn: &Connection, routine_id: i64, days: i64) {
        conn.execute(
            &format!(
                "INSERT INTO routine_launches (routine_id, launched_at) VALUES (?1, {})",
                local_noon(days)
            ),
            params![routine_id],
        )
        .unwrap();
    }

    /// A completed focus session of `seconds`, ended `days` from today.
    fn a_session(conn: &Connection, seconds: i64, days: i64, routine_id: Option<i64>) {
        let at = local_noon(days);
        conn.execute(
            &format!(
                "INSERT INTO focus_sessions
                     (routine_id, started_at, ended_at, duration_seconds, completed)
                 VALUES (?1, {at}, {at}, ?2, 1)"
            ),
            params![routine_id, seconds],
        )
        .unwrap();
    }

    /// A task completed `days` from today.
    fn a_completed_task(conn: &Connection, title: &str, days: i64, routine_id: Option<i64>) {
        conn.execute(
            &format!(
                "INSERT INTO tasks (title, status, routine_id, completed_at)
                 VALUES (?1, 'completed', ?2, {})",
                local_noon(days)
            ),
            params![title, routine_id],
        )
        .unwrap();
    }

    /// An open task due `days` from today. Due dates are already local
    /// `YYYY-MM-DD`, so this one needs no conversion.
    fn an_open_task(conn: &Connection, title: &str, days: i64) {
        conn.execute(
            "INSERT INTO tasks (title, status, due_date)
             VALUES (?1, 'todo', date('now', 'localtime', ?2))",
            params![title, format!("{days} days")],
        )
        .unwrap();
    }

    #[test]
    fn an_empty_database_reports_zeroes_rather_than_nothing() {
        let stats = productivity_stats(&conn()).unwrap();

        assert_eq!(stats.today.focus_seconds, 0);
        assert_eq!(stats.today.tasks_completed, 0);
        assert_eq!(stats.today.tasks_total, 0);
        assert_eq!(stats.today.routine_launches, 0);
        assert_eq!(stats.week_days.len(), 7, "the week is always seven days");
        assert!(stats.routine_usage.is_empty());
        assert_eq!(stats.most_productive_day, None, "no day wins an empty week");
    }

    #[test]
    fn today_counts_focus_tasks_and_launches() {
        let conn = conn();
        let routine = a_routine(&conn, "Coding");

        a_session(&conn, 25 * 60, 0, None);
        a_session(&conn, 50 * 60, 0, None);
        a_completed_task(&conn, "Ship it", 0, None);
        launched(&conn, routine, 0);
        launched(&conn, routine, 0);

        let stats = productivity_stats(&conn).unwrap();

        assert_eq!(stats.today.focus_seconds, 75 * 60);
        assert_eq!(stats.today.focus_sessions, 2);
        assert_eq!(stats.today.tasks_completed, 1);
        assert_eq!(stats.today.routine_launches, 2);
    }

    #[test]
    fn yesterdays_work_stays_out_of_today_but_inside_the_week() {
        let conn = conn();
        a_session(&conn, 30 * 60, -1, None);

        let stats = productivity_stats(&conn).unwrap();
        assert_eq!(stats.today.focus_seconds, 0);

        // Only true when yesterday is in the same week, which is every day
        // but the week's first — so the assertion is conditional on the week
        // having room for it rather than on the day of the run.
        if stats.week.start < stats.today_date {
            assert_eq!(stats.week.focus_seconds, 30 * 60);
        }
    }

    #[test]
    fn an_interrupted_session_is_not_focus_time() {
        let conn = conn();
        conn.execute(
            "INSERT INTO focus_sessions
                 (started_at, ended_at, duration_seconds, completed, interrupted)
             VALUES (datetime('now'), datetime('now'), 1800, 0, 1)",
            [],
        )
        .unwrap();

        let stats = productivity_stats(&conn).unwrap();
        assert_eq!(stats.today.focus_seconds, 0);
        assert_eq!(stats.today.focus_sessions, 0);
    }

    #[test]
    fn the_denominator_is_work_owed_not_work_that_exists() {
        let conn = conn();

        a_completed_task(&conn, "Done today", 0, None);
        an_open_task(&conn, "Due today", 0);
        an_open_task(&conn, "Overdue", -3);
        an_open_task(&conn, "Due next week", 30);
        // No due date and not finished: never owed today.
        conn.execute("INSERT INTO tasks (title) VALUES ('Someday')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO tasks (title, status, due_date)
             VALUES ('Called off', 'cancelled', date('now', 'localtime'))",
            [],
        )
        .unwrap();

        let stats = productivity_stats(&conn).unwrap();

        assert_eq!(stats.today.tasks_completed, 1);
        assert_eq!(
            stats.today.tasks_total, 3,
            "one done, plus the one due today and the overdue one"
        );
    }

    #[test]
    fn a_superseded_recurring_instance_is_not_still_owed() {
        let conn = conn();
        conn.execute(
            "INSERT INTO task_recurrence (frequency, start_date)
             VALUES ('daily', date('now', 'localtime', '-5 days'))",
            [],
        )
        .unwrap();
        let recurrence = conn.last_insert_rowid();

        for offset in [-2, -1, 0] {
            conn.execute(
                "INSERT INTO tasks (title, status, due_date, recurrence_id)
                 VALUES ('Check email', 'todo', date('now', 'localtime', ?1), ?2)",
                params![format!("{offset} days"), recurrence],
            )
            .unwrap();
        }

        let stats = productivity_stats(&conn).unwrap();
        assert_eq!(
            stats.today.tasks_total, 1,
            "only the live instance is owed; the two it replaced are not"
        );
    }

    #[test]
    fn the_most_used_routine_of_the_week_leads_the_usage_list() {
        let conn = conn();
        let coding = a_routine(&conn, "Coding");
        let writing = a_routine(&conn, "Writing");

        launched(&conn, coding, 0);
        launched(&conn, coding, 0);
        launched(&conn, writing, 0);

        let usage = productivity_stats(&conn).unwrap().routine_usage;

        assert_eq!(usage.len(), 2);
        assert_eq!(usage[0].name, "Coding");
        assert_eq!(usage[0].launches, 2);
        assert_eq!(usage[1].name, "Writing");
    }

    #[test]
    fn the_most_productive_day_is_the_one_with_the_most_focus() {
        let conn = conn();
        a_session(&conn, 90 * 60, 0, None);

        let stats = productivity_stats(&conn).unwrap();
        let best = stats.most_productive_day.expect("a day with focus wins it");

        assert_eq!(best.date, stats.today_date);
        assert_eq!(best.focus_seconds, 90 * 60);
    }

    #[test]
    fn a_day_with_only_a_task_still_counts_as_productive() {
        let conn = conn();
        a_completed_task(&conn, "One thing", 0, None);

        let stats = productivity_stats(&conn).unwrap();
        let today = stats
            .streak_history
            .last()
            .expect("history ends with today");

        assert_eq!(today.date, stats.today_date);
        assert!(today.productive);
        assert_eq!(stats.streak.current_streak, 1);
    }

    #[test]
    fn the_history_is_four_weeks_ending_today() {
        let stats = productivity_stats(&conn()).unwrap();

        assert_eq!(stats.streak_history.len(), HISTORY_DAYS as usize);
        assert_eq!(stats.streak_history.last().unwrap().date, stats.today_date);
    }

    #[test]
    fn the_week_runs_monday_to_sunday_and_contains_today() {
        let conn = conn();
        let stats = productivity_stats(&conn).unwrap();

        let weekday: String = conn
            .query_row(
                "SELECT strftime('%w', ?1)",
                params![stats.week.start],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(weekday, "1", "the week starts on a Monday");

        assert!(stats.week.start <= stats.today_date);
        assert!(stats.today_date <= stats.week.end);
        assert_eq!(stats.week_days.first().unwrap().date, stats.week.start);
        assert_eq!(stats.week_days.last().unwrap().date, stats.week.end);
    }

    /// The weekday SQLite gives a `YYYY-MM-DD`: `"0"` is Sunday.
    fn weekday_of(conn: &Connection, date: &str) -> String {
        conn.query_row("SELECT strftime('%w', ?1)", params![date], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn a_sunday_start_week_runs_sunday_to_saturday_and_contains_today() {
        let conn = conn();
        settings::set_daily_settings(
            &conn,
            settings::DailySettings {
                week_start: WeekStart::Sunday,
                ..Default::default()
            },
        )
        .unwrap();

        let stats = productivity_stats(&conn).unwrap();

        assert_eq!(weekday_of(&conn, &stats.week.start), "0", "starts on a Sunday");
        assert_eq!(weekday_of(&conn, &stats.week.end), "6", "ends on a Saturday");
        assert!(stats.week.start <= stats.today_date);
        assert!(stats.today_date <= stats.week.end);
        assert_eq!(stats.week_days.len(), 7);
        assert_eq!(stats.week_days.first().unwrap().date, stats.week.start);
        assert_eq!(stats.week_days.last().unwrap().date, stats.week.end);
    }

    #[test]
    fn the_week_is_found_from_either_start_day_on_any_day() {
        let conn = conn();
        let week = |today: &str, start: WeekStart| {
            let window = Window::on(&conn, today, start).unwrap();
            (window.week_start, window.week_end)
        };
        let dates = |start: &str, end: &str| (start.to_owned(), end.to_owned());

        // 2026-09-13 is a Sunday, 2026-09-14 a Monday, 2026-09-19 a Saturday.
        // Mid-week, a Sunday week starts the day before the Monday one.
        assert_eq!(week("2026-09-16", WeekStart::Monday), dates("2026-09-14", "2026-09-20"));
        assert_eq!(week("2026-09-16", WeekStart::Sunday), dates("2026-09-13", "2026-09-19"));

        // On a Sunday: the last day of a Monday week, the first of a Sunday one.
        assert_eq!(week("2026-09-13", WeekStart::Monday), dates("2026-09-07", "2026-09-13"));
        assert_eq!(week("2026-09-13", WeekStart::Sunday), dates("2026-09-13", "2026-09-19"));

        // On a Monday: the first day of a Monday week, the second of a Sunday one.
        assert_eq!(week("2026-09-14", WeekStart::Monday), dates("2026-09-14", "2026-09-20"));
        assert_eq!(week("2026-09-14", WeekStart::Sunday), dates("2026-09-13", "2026-09-19"));

        // On a Saturday: the last day of a Sunday week.
        assert_eq!(week("2026-09-19", WeekStart::Sunday), dates("2026-09-13", "2026-09-19"));

        // Across a month and a year end.
        assert_eq!(week("2026-10-01", WeekStart::Sunday), dates("2026-09-27", "2026-10-03"));
        assert_eq!(week("2027-01-01", WeekStart::Monday), dates("2026-12-28", "2027-01-03"));
    }

    #[test]
    fn work_on_the_sunday_counts_in_a_sunday_week_and_not_a_monday_one() {
        let conn = conn();
        let coding = a_routine(&conn, "Coding");

        // Local noon on Sunday 2026-09-13, as the UTC the database stores.
        let sunday_noon = "datetime('2026-09-13 12:00:00', 'utc')";
        conn.execute(
            &format!(
                "INSERT INTO focus_sessions (started_at, ended_at, duration_seconds, completed)
                 VALUES ({sunday_noon}, {sunday_noon}, 1800, 1)"
            ),
            [],
        )
        .unwrap();
        conn.execute(
            &format!(
                "INSERT INTO routine_launches (routine_id, launched_at) VALUES (?1, {sunday_noon})"
            ),
            params![coding],
        )
        .unwrap();

        let on_wednesday = |start| {
            let window = Window::on(&conn, "2026-09-16", start).unwrap();
            stats_for(&conn, &window).unwrap()
        };
        let monday_week = on_wednesday(WeekStart::Monday);
        let sunday_week = on_wednesday(WeekStart::Sunday);

        assert_eq!(monday_week.week.focus_seconds, 0);
        assert_eq!(monday_week.week.routine_launches, 0);
        assert!(monday_week.routine_usage.is_empty());
        assert_eq!(monday_week.most_productive_day, None);

        assert_eq!(sunday_week.week.focus_seconds, 1800);
        assert_eq!(sunday_week.week.routine_launches, 1);
        assert_eq!(sunday_week.routine_usage[0].name, "Coding");
        assert_eq!(sunday_week.week_days[0].date, "2026-09-13");
        assert_eq!(
            sunday_week.most_productive_day.map(|day| day.date).as_deref(),
            Some("2026-09-13")
        );

        // The streak calendar is the last four weeks either way.
        assert_eq!(monday_week.streak_history, sunday_week.streak_history);
    }

    // -----------------------------------------------------------------------
    // Section 33
    // -----------------------------------------------------------------------

    #[test]
    fn routine_statistics_start_empty_but_measured() {
        let conn = conn();
        a_routine(&conn, "Coding");

        let stats = routine_statistics(&conn).unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].launches, 0);
        assert_eq!(stats[0].focus_seconds, 0);
        assert_eq!(stats[0].tasks_completed, 0);
        assert_eq!(
            stats[0].average_session_seconds, None,
            "no sessions is not a session of no length"
        );
        assert_eq!(stats[0].last_used, None);
    }

    #[test]
    fn a_routines_focus_time_is_summed_from_its_sessions() {
        let conn = conn();
        let coding = a_routine(&conn, "Coding");
        let writing = a_routine(&conn, "Writing");

        a_session(&conn, 40 * 60, 0, Some(coding));
        a_session(&conn, 62 * 60, 0, Some(coding));
        a_session(&conn, 10 * 60, 0, Some(writing));
        a_session(&conn, 99 * 60, 0, None);

        let stats = routine_statistics_for(&conn, coding).unwrap().unwrap();

        assert_eq!(stats.focus_seconds, 102 * 60);
        assert_eq!(stats.average_session_seconds, Some(51 * 60));
    }

    #[test]
    fn a_routines_tasks_are_the_completed_ones_that_name_it() {
        let conn = conn();
        let coding = a_routine(&conn, "Coding");

        a_completed_task(&conn, "Refactor", 0, Some(coding));
        a_completed_task(&conn, "Review", 0, Some(coding));
        a_completed_task(&conn, "Unrelated", 0, None);
        conn.execute(
            "INSERT INTO tasks (title, status, routine_id) VALUES ('Not yet', 'todo', ?1)",
            params![coding],
        )
        .unwrap();

        let stats = routine_statistics_for(&conn, coding).unwrap().unwrap();
        assert_eq!(stats.tasks_completed, 2);
    }

    #[test]
    fn sessions_and_tasks_do_not_multiply_each_other() {
        let conn = conn();
        let coding = a_routine(&conn, "Coding");

        a_session(&conn, 30 * 60, 0, Some(coding));
        a_session(&conn, 30 * 60, 0, Some(coding));
        a_completed_task(&conn, "One", 0, Some(coding));
        a_completed_task(&conn, "Two", 0, Some(coding));
        a_completed_task(&conn, "Three", 0, Some(coding));

        let stats = routine_statistics_for(&conn, coding).unwrap().unwrap();

        assert_eq!(stats.focus_seconds, 60 * 60, "not 3x for the three tasks");
        assert_eq!(stats.tasks_completed, 3, "not 2x for the two sessions");
    }

    #[test]
    fn statistics_for_a_missing_routine_are_none() {
        assert_eq!(routine_statistics_for(&conn(), 9_999).unwrap(), None);
    }
}
