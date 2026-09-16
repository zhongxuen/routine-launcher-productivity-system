//! Development-plan.md section 55's rule-based suggestions: "normal software
//! rules, not AI".
//!
//! Two of the section's three rules, both read from the task history the app
//! already keeps:
//!
//! - **Make it recurring?** A one-off task title completed on at least
//!   [`REPEAT_MIN_DAYS`] distinct local days in the last [`REPEAT_WINDOW_DAYS`].
//!   The suggestion carries the schedule those days imply — Weekdays when all
//!   five were seen, Daily when all seven were, otherwise Weekly on the
//!   weekdays seen — for the repeat picker to open on.
//! - **Update the estimate?** A title whose last [`DRIFT_COMPLETIONS`]
//!   completions each had focus time more than [`DRIFT_MIN_FRACTION`] *and*
//!   more than [`DRIFT_MIN_MINUTES`] away from its estimate. The suggested
//!   estimate is the median of those three.
//!
//! - **You often open these together.** Programs each in use for at least
//!   [`TOGETHER_MIN_SECONDS`] in the same local hour, on at least
//!   [`TOGETHER_MIN_DAYS`] distinct days of the last [`REPEAT_WINDOW_DAYS`].
//!   It reads the opt-in usage history (`services::app_usage`, section 37), so
//!   it never fires for someone who has not turned tracking on. A group that
//!   one routine already launches in full is not suggested.
//!
//! Titles are compared trimmed and case-insensitively, so "Check email" and
//! "check email " are one task to these rules. Nothing in this module writes
//! a task: it describes a change, and the frontend makes it through the
//! ordinary task commands only when the user clicks. The one thing it does
//! write is a dismissal, one `settings` key per suggestion, so a declined
//! suggestion never comes back for that title.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection};
use serde::Serialize;

use super::app_usage;
use super::error::{ServiceError, ServiceResult};
use super::settings;
use super::task_recurrence::{self, RecurrenceFrequency};
use super::tasks::{TaskPriority, FOCUS_SECONDS_COLUMN, LATEST_IN_SERIES_PREDICATE};

/// "At least 3 distinct days …"
pub const REPEAT_MIN_DAYS: usize = 3;
/// "… in the last 14", today included.
pub const REPEAT_WINDOW_DAYS: i64 = 14;
/// How many of a title's most recent completions have to agree on the drift.
pub const DRIFT_COMPLETIONS: usize = 3;
/// A completion drifts when it is more than this far from the estimate …
pub const DRIFT_MIN_MINUTES: i64 = 10;
/// … and also more than this fraction of it, so a long task is not nagged
/// about a few minutes and a short one is not nagged about a few percent.
pub const DRIFT_MIN_FRACTION: f64 = 0.2;

/// "… each used for at least two minutes in the same hour …"
pub const TOGETHER_MIN_SECONDS: i64 = 2 * 60;
/// "… on at least 5 days of the fortnight."
pub const TOGETHER_MIN_DAYS: usize = 5;
/// The most programs one suggested routine opens.
pub const TOGETHER_MAX_APPS: usize = 5;

/// Programs that are in the background of nearly every working hour, so
/// pairing them with anything says nothing: the file manager, and the host
/// that UWP apps run inside, which cannot be launched by path.
const NOT_WORKSPACE_APPS: &[&str] = &["explorer.exe", "applicationframehost.exe"];

/// Prefix of the `settings` keys that remember a dismissal.
const DISMISSED_PREFIX: &str = "suggestions.dismissed.";

const MAKE_RECURRING: &str = "make_recurring";
const UPDATE_ESTIMATE: &str = "update_estimate";
const OPEN_TOGETHER: &str = "open_together";

/// Weekday tokens as `task_recurrence` stores them, indexed by
/// `strftime('%w')` (0 = Sunday).
const WEEKDAY_TOKENS: [&str; 7] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// The schedule a Make-it-recurring suggestion opens the repeat picker on.
/// The same shape as the picker's draft, with only the fields it sets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SuggestedRecurrence {
    pub frequency: RecurrenceFrequency,
    /// Weekday tokens for `weekly`; empty otherwise.
    pub days_of_week: Vec<String>,
}

/// What a new repeating task is made from when no open task has the title:
/// the most recently completed one's details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskTemplate {
    pub title: String,
    pub priority: TaskPriority,
    pub category_id: Option<i64>,
    pub estimated_minutes: Option<i64>,
    pub routine_id: Option<i64>,
}

/// One program a "you often open these together" routine would launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SuggestedApp {
    /// The executable's file name as last recorded, e.g. `Code.exe`.
    pub app_name: String,
    /// The full path last recorded for it: the routine action's target.
    pub exe_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Suggestion {
    /// "You complete this often. Make it recurring?"
    MakeRecurring {
        /// Pass to [`dismiss`]. Stable for the title.
        key: String,
        /// The title as last written, for the sentence on screen.
        title: String,
        /// The open task to give the schedule to, newest first. When null,
        /// no copy is open and the frontend creates one from `template`.
        task_id: Option<i64>,
        template: TaskTemplate,
        /// Distinct local days it was completed on in the window.
        days_completed: usize,
        recurrence: SuggestedRecurrence,
    },
    /// "This usually takes longer. Update the estimate?"
    UpdateEstimate {
        key: String,
        title: String,
        /// The tasks whose estimate would change: every open copy of the
        /// title, and the template of a repeating series.
        task_ids: Vec<i64>,
        current_minutes: i64,
        suggested_minutes: i64,
    },
    /// "You often open these together. Create a routine?"
    OpenTogether {
        key: String,
        /// In name order, which is also the order the routine opens them in.
        apps: Vec<SuggestedApp>,
        /// Distinct local days they were all in use in the same hour.
        days_together: usize,
    },
}

impl Suggestion {
    pub fn key(&self) -> &str {
        match self {
            Self::MakeRecurring { key, .. }
            | Self::UpdateEstimate { key, .. }
            | Self::OpenTogether { key, .. } => key,
        }
    }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/// Every suggestion that applies now and has not been dismissed. Make it
/// recurring first, then estimates, each in title order, so the line on
/// screen does not shuffle between reads.
pub fn list(conn: &Connection) -> ServiceResult<Vec<Suggestion>> {
    let today = task_recurrence::local_today(conn)?;
    list_on(conn, &today)
}

/// [`list`] as of the local date `today`, which is what the tests pin.
fn list_on(conn: &Connection, today: &str) -> ServiceResult<Vec<Suggestion>> {
    let window_start: String = conn.query_row(
        "SELECT date(?1, ?2)",
        params![today, format!("-{} days", REPEAT_WINDOW_DAYS - 1)],
        |row| row.get(0),
    )?;

    let mut groups: BTreeMap<String, Vec<TaskRow>> = BTreeMap::new();
    for row in task_rows(conn)? {
        let normalized = normalize_title(&row.title);
        if !normalized.is_empty() {
            groups.entry(normalized).or_default().push(row);
        }
    }

    let mut recurring = Vec::new();
    let mut estimates = Vec::new();
    for (normalized, rows) in &groups {
        if let Some(suggestion) = make_recurring(normalized, rows, &window_start, today) {
            recurring.push(suggestion);
        }
        if let Some(suggestion) = update_estimate(normalized, rows) {
            estimates.push(suggestion);
        }
    }

    let together = open_together(conn, &window_start, today)?;

    let mut suggestions = Vec::new();
    for suggestion in recurring.into_iter().chain(estimates).chain(together) {
        if !is_dismissed(conn, suggestion.key())? {
            suggestions.push(suggestion);
        }
    }
    Ok(suggestions)
}

fn make_recurring(
    normalized: &str,
    rows: &[TaskRow],
    window_start: &str,
    today: &str,
) -> Option<Suggestion> {
    // A title that already repeats has nothing to suggest.
    if rows.iter().any(|row| row.recurrence_id.is_some()) {
        return None;
    }

    let recent: Vec<&TaskRow> = rows
        .iter()
        .filter(|row| {
            row.is_completed()
                && row
                    .completed_on
                    .as_deref()
                    .is_some_and(|day| day >= window_start && day <= today)
        })
        .collect();

    let days: BTreeSet<&str> = recent.iter().filter_map(|row| row.completed_on.as_deref()).collect();
    if days.len() < REPEAT_MIN_DAYS {
        return None;
    }

    let weekdays: BTreeSet<usize> = recent.iter().filter_map(|row| row.completed_weekday).collect();
    let latest = recent.iter().max_by(|a, b| a.completion_order().cmp(&b.completion_order()))?;
    let open = rows.iter().filter(|row| row.is_open()).map(|row| row.id).max();

    Some(Suggestion::MakeRecurring {
        key: key_for(MAKE_RECURRING, normalized),
        title: latest.title.trim().to_owned(),
        task_id: open,
        template: TaskTemplate {
            title: latest.title.trim().to_owned(),
            priority: latest.priority,
            category_id: latest.category_id,
            estimated_minutes: latest.estimated_minutes,
            routine_id: latest.routine_id,
        },
        days_completed: days.len(),
        recurrence: implied_recurrence(&weekdays),
    })
}

/// The schedule a set of weekdays (0 = Sunday) implies.
fn implied_recurrence(weekdays: &BTreeSet<usize>) -> SuggestedRecurrence {
    let monday_to_friday: BTreeSet<usize> = (1..=5).collect();

    if *weekdays == monday_to_friday {
        SuggestedRecurrence { frequency: RecurrenceFrequency::Weekdays, days_of_week: Vec::new() }
    } else if weekdays.len() == WEEKDAY_TOKENS.len() {
        SuggestedRecurrence { frequency: RecurrenceFrequency::Daily, days_of_week: Vec::new() }
    } else {
        SuggestedRecurrence {
            frequency: RecurrenceFrequency::Weekly,
            days_of_week: weekdays.iter().map(|&day| WEEKDAY_TOKENS[day].to_owned()).collect(),
        }
    }
}

fn update_estimate(normalized: &str, rows: &[TaskRow]) -> Option<Suggestion> {
    // What an update would change: the open copies, and a series' template
    // (usually today's instance, but possibly one already ticked off).
    let targets: Vec<&TaskRow> =
        rows.iter().filter(|row| row.is_open() || row.latest_in_series).collect();
    let current = targets
        .iter()
        .filter(|row| row.estimated_minutes.is_some())
        .max_by_key(|row| row.id)?
        .estimated_minutes?;
    if current <= 0 {
        return None;
    }

    let mut completions: Vec<&TaskRow> = rows.iter().filter(|row| row.is_completed()).collect();
    completions.sort_by(|a, b| b.completion_order().cmp(&a.completion_order()));
    let last: Vec<&TaskRow> = completions.into_iter().take(DRIFT_COMPLETIONS).collect();
    if last.len() < DRIFT_COMPLETIONS {
        return None;
    }

    // Measured against the estimate the title has now rather than each
    // completion's own, so taking the suggestion ends it: the median is one
    // of the three, and that one no longer drifts.
    if !last.iter().all(|row| drifts(row.focus_seconds, current)) {
        return None;
    }

    let mut actual: Vec<i64> = last.iter().map(|row| row.focus_seconds).collect();
    actual.sort_unstable();
    let suggested = ((actual[actual.len() / 2] as f64 / 60.0).round() as i64).max(1);
    if suggested == current {
        return None;
    }

    let mut task_ids: Vec<i64> = targets
        .iter()
        .filter(|row| row.estimated_minutes.is_some_and(|minutes| minutes != suggested))
        .map(|row| row.id)
        .collect();
    task_ids.sort_unstable();

    Some(Suggestion::UpdateEstimate {
        key: key_for(UPDATE_ESTIMATE, normalized),
        title: last[0].title.trim().to_owned(),
        task_ids,
        current_minutes: current,
        suggested_minutes: suggested,
    })
}

/// Whether `focus_seconds` of real focus is far enough from an estimate of
/// `estimate_minutes` to count. A completion with no focus time says nothing
/// about how long the task takes, so it never drifts.
fn drifts(focus_seconds: i64, estimate_minutes: i64) -> bool {
    if focus_seconds <= 0 {
        return false;
    }
    let estimate_seconds = estimate_minutes * 60;
    let gap = (focus_seconds - estimate_seconds).abs();
    gap > DRIFT_MIN_MINUTES * 60 && gap as f64 > estimate_seconds as f64 * DRIFT_MIN_FRACTION
}

/// Section 55's third rule, over the usage history. One suggestion per
/// distinct group, strongest first; the line on screen shows the first that
/// has not been dismissed.
fn open_together(
    conn: &Connection,
    window_start: &str,
    today: &str,
) -> ServiceResult<Vec<Suggestion>> {
    // (date, hour) -> the programs in real use that hour, lowercased.
    let mut buckets: BTreeMap<(String, i64), BTreeSet<String>> = BTreeMap::new();
    // lowercase name -> (name as recorded, latest path).
    let mut names: BTreeMap<String, (String, String)> = BTreeMap::new();

    let mut statement = conn.prepare(
        "SELECT date, hour, app_name, exe_path
           FROM app_usage
          WHERE date BETWEEN ?1 AND ?2 AND seconds >= ?3 AND exe_path IS NOT NULL
          ORDER BY date, hour",
    )?;
    let rows = statement.query_map(params![window_start, today, TOGETHER_MIN_SECONDS], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (date, hour, app_name, exe_path) = row?;
        let lower = app_name.to_lowercase();
        if app_usage::is_shell_process(&lower) || NOT_WORKSPACE_APPS.contains(&lower.as_str()) {
            continue;
        }
        buckets.entry((date, hour)).or_default().insert(lower.clone());
        // Rows arrive oldest first, so the last write is the latest path.
        names.insert(lower, (app_name, exe_path));
    }

    let days_with = |group: &BTreeSet<String>| -> usize {
        buckets
            .iter()
            .filter(|(_, apps)| group.is_subset(apps))
            .map(|((date, _), _)| date.as_str())
            .collect::<BTreeSet<_>>()
            .len()
    };

    // Every pair seen together on enough days, strongest first.
    let all: Vec<&String> = names.keys().collect();
    let mut seeds: Vec<(usize, BTreeSet<String>)> = Vec::new();
    for (index, a) in all.iter().enumerate() {
        for b in &all[index + 1..] {
            let pair: BTreeSet<String> = [(*a).clone(), (*b).clone()].into();
            let days = days_with(&pair);
            if days >= TOGETHER_MIN_DAYS {
                seeds.push((days, pair));
            }
        }
    }
    seeds.sort_by(|x, y| y.0.cmp(&x.0).then_with(|| x.1.cmp(&y.1)));

    let covered = routine_app_sets(conn)?;
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut suggestions = Vec::new();

    for (_, mut group) in seeds {
        // Grow the pair while one more program keeps the group above the bar,
        // taking whichever keeps the most days each time.
        while group.len() < TOGETHER_MAX_APPS {
            let best = all
                .iter()
                .filter(|name| !group.contains(**name))
                .map(|name| {
                    let mut grown = group.clone();
                    grown.insert((*name).clone());
                    (days_with(&grown), grown)
                })
                .filter(|(days, _)| *days >= TOGETHER_MIN_DAYS)
                .max_by(|x, y| x.0.cmp(&y.0).then_with(|| y.1.cmp(&x.1)));
            match best {
                Some((_, grown)) => group = grown,
                None => break,
            }
        }

        let joined = group.iter().cloned().collect::<Vec<_>>().join("+");
        let key = key_for(OPEN_TOGETHER, &joined);
        if !seen.insert(key.clone()) {
            continue;
        }
        if covered.iter().any(|routine| group.is_subset(routine)) {
            continue;
        }

        suggestions.push(Suggestion::OpenTogether {
            key,
            days_together: days_with(&group),
            apps: group
                .iter()
                .map(|lower| {
                    let (app_name, exe_path) = &names[lower];
                    SuggestedApp { app_name: app_name.clone(), exe_path: exe_path.clone() }
                })
                .collect(),
        });
    }

    Ok(suggestions)
}

/// Per routine, the lowercase executable names its application actions
/// launch, so a group one routine already opens is not suggested again. A
/// bare target (`code`) counts as `code.exe`.
fn routine_app_sets(conn: &Connection) -> ServiceResult<Vec<BTreeSet<String>>> {
    let mut statement = conn.prepare(
        "SELECT routine_id, target FROM routine_actions
          WHERE type = 'application'
          ORDER BY routine_id",
    )?;
    let mut sets: BTreeMap<i64, BTreeSet<String>> = BTreeMap::new();
    let rows = statement.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?;
    for row in rows {
        let (routine_id, target) = row?;
        let file = target
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&target)
            .trim()
            .to_lowercase();
        let file = if file.contains('.') { file } else { format!("{file}.exe") };
        sets.entry(routine_id).or_default().insert(file);
    }
    Ok(sets.into_values().collect())
}

// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------

/// Remembers that the suggestion `key` was declined, for good.
pub fn dismiss(conn: &Connection, key: &str) -> ServiceResult<()> {
    let valid = [MAKE_RECURRING, UPDATE_ESTIMATE, OPEN_TOGETHER].iter().any(|kind| {
        key.strip_prefix(kind)
            .and_then(|rest| rest.strip_prefix(':'))
            .is_some_and(|title| !title.is_empty() && title == normalize_title(title))
    });
    if !valid {
        return Err(ServiceError::validation(format!("{key:?} is not a suggestion.")));
    }
    settings::set_bool(conn, &format!("{DISMISSED_PREFIX}{key}"), true)
}

fn is_dismissed(conn: &Connection, key: &str) -> ServiceResult<bool> {
    settings::get_bool(conn, &format!("{DISMISSED_PREFIX}{key}"), false)
}

fn key_for(kind: &str, normalized_title: &str) -> String {
    format!("{kind}:{normalized_title}")
}

fn normalize_title(title: &str) -> String {
    title.trim().to_lowercase()
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// The columns of one task these rules look at.
struct TaskRow {
    id: i64,
    title: String,
    status: String,
    priority: TaskPriority,
    category_id: Option<i64>,
    estimated_minutes: Option<i64>,
    routine_id: Option<i64>,
    recurrence_id: Option<i64>,
    completed_at: Option<String>,
    /// The local date `completed_at` falls on.
    completed_on: Option<String>,
    /// `strftime('%w')` of that local date: 0 = Sunday.
    completed_weekday: Option<usize>,
    latest_in_series: bool,
    focus_seconds: i64,
}

impl TaskRow {
    fn is_completed(&self) -> bool {
        self.status == "completed" && self.completed_at.is_some()
    }

    fn is_open(&self) -> bool {
        matches!(self.status.as_str(), "todo" | "in_progress")
    }

    /// Orders completions oldest to newest. `completed_at` has one-second
    /// resolution, so the id breaks a tie.
    fn completion_order(&self) -> (Option<&str>, i64) {
        (self.completed_at.as_deref(), self.id)
    }
}

fn task_rows(conn: &Connection) -> ServiceResult<Vec<TaskRow>> {
    let sql = format!(
        "SELECT id, title, status, priority, category_id, estimated_minutes, routine_id, \
                recurrence_id, completed_at, \
                date(completed_at, 'localtime') AS completed_on, \
                CAST(strftime('%w', completed_at, 'localtime') AS INTEGER) AS completed_weekday, \
                COALESCE({LATEST_IN_SERIES_PREDICATE}, 0) AS latest_in_series, \
                {FOCUS_SECONDS_COLUMN} \
           FROM tasks"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement
        .query_map([], |row| {
            let weekday: Option<i64> = row.get("completed_weekday")?;
            Ok(TaskRow {
                id: row.get("id")?,
                title: row.get("title")?,
                status: row.get("status")?,
                priority: row.get("priority")?,
                category_id: row.get("category_id")?,
                estimated_minutes: row.get("estimated_minutes")?,
                routine_id: row.get("routine_id")?,
                recurrence_id: row.get("recurrence_id")?,
                completed_at: row.get("completed_at")?,
                completed_on: row.get("completed_on")?,
                completed_weekday: weekday.and_then(|day| usize::try_from(day).ok()),
                latest_in_series: row.get("latest_in_series")?,
                focus_seconds: row.get("focus_seconds")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;
    use crate::services::tasks::{self, NewTask};
    use serde_json::json;

    /// A Wednesday. The fortnight before it runs from Thursday 2026-09-03.
    const TODAY: &str = "2026-09-16";

    /// A task completed at local noon on `day`, returning its id.
    fn completed(conn: &Connection, title: &str, day: &str) -> i64 {
        conn.execute(
            "INSERT INTO tasks (title, status, due_date, completed_at)
             VALUES (?1, 'completed', ?2, datetime(?2 || ' 12:00:00', 'utc'))",
            params![title, day],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    /// A completed task with an estimate and `focus_minutes` of ended focus.
    fn completed_with_focus(
        conn: &Connection,
        title: &str,
        day: &str,
        estimate: i64,
        focus_minutes: i64,
    ) -> i64 {
        let id = completed(conn, title, day);
        conn.execute("UPDATE tasks SET estimated_minutes = ?1 WHERE id = ?2", params![estimate, id])
            .unwrap();
        if focus_minutes > 0 {
            conn.execute(
                "INSERT INTO focus_sessions (task_id, started_at, ended_at, duration_seconds, completed)
                 VALUES (?1, datetime('now'), datetime('now'), ?2, 1)",
                params![id, focus_minutes * 60],
            )
            .unwrap();
        }
        id
    }

    fn open_task(conn: &Connection, title: &str, estimate: Option<i64>) -> i64 {
        conn.execute(
            "INSERT INTO tasks (title, estimated_minutes, due_date) VALUES (?1, ?2, ?3)",
            params![title, estimate, TODAY],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn suggestions(conn: &Connection) -> Vec<Suggestion> {
        list_on(conn, TODAY).unwrap()
    }

    fn recurrence_of(suggestion: &Suggestion) -> &SuggestedRecurrence {
        match suggestion {
            Suggestion::MakeRecurring { recurrence, .. } => recurrence,
            other => panic!("expected MakeRecurring, got {other:?}"),
        }
    }

    // --- Make it recurring ------------------------------------------------

    #[test]
    fn three_distinct_days_in_the_fortnight_suggest_a_repeat() {
        let conn = init_memory_db().unwrap();
        completed(&conn, "Check email", "2026-09-14");
        completed(&conn, "check email ", "2026-09-15");
        completed(&conn, "  CHECK EMAIL", TODAY);

        let found = suggestions(&conn);
        assert_eq!(found.len(), 1, "{found:?}");
        match &found[0] {
            Suggestion::MakeRecurring { key, title, task_id, days_completed, template, .. } => {
                assert_eq!(key, "make_recurring:check email");
                assert_eq!(title, "CHECK EMAIL", "the newest spelling");
                assert_eq!(*task_id, None);
                assert_eq!(*days_completed, 3);
                assert_eq!(template.priority, TaskPriority::Normal);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn two_days_or_one_busy_day_is_not_enough() {
        let conn = init_memory_db().unwrap();
        completed(&conn, "Stretch", "2026-09-15");
        completed(&conn, "Stretch", TODAY);
        for _ in 0..3 {
            completed(&conn, "Inbox zero", TODAY);
        }
        assert!(suggestions(&conn).is_empty());
    }

    #[test]
    fn only_the_last_fourteen_days_count() {
        let conn = init_memory_db().unwrap();
        // 2026-09-02 is the fifteenth day back, so it is outside the window.
        completed(&conn, "Water plants", "2026-09-02");
        completed(&conn, "Water plants", "2026-09-10");
        completed(&conn, "Water plants", TODAY);
        assert!(suggestions(&conn).is_empty());

        // The fourteenth day back is inside it.
        completed(&conn, "Water plants", "2026-09-03");
        assert_eq!(suggestions(&conn).len(), 1);
    }

    #[test]
    fn a_title_that_already_repeats_is_left_alone() {
        let conn = init_memory_db().unwrap();
        for day in ["2026-09-14", "2026-09-15", TODAY] {
            completed(&conn, "Standup", day);
        }
        tasks::create(
            &conn,
            serde_json::from_value::<NewTask>(json!({
                "title": "standup",
                "recurrence": { "frequency": "weekdays" },
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(suggestions(&conn).is_empty());
    }

    #[test]
    fn cancelled_and_open_copies_are_not_completions() {
        let conn = init_memory_db().unwrap();
        completed(&conn, "Review PRs", "2026-09-14");
        completed(&conn, "Review PRs", "2026-09-15");
        let open = open_task(&conn, "Review PRs", None);
        conn.execute(
            "INSERT INTO tasks (title, status, due_date) VALUES ('Review PRs', 'cancelled', ?1)",
            params![TODAY],
        )
        .unwrap();
        assert!(suggestions(&conn).is_empty());

        completed(&conn, "Review PRs", "2026-09-11");
        match &suggestions(&conn)[0] {
            Suggestion::MakeRecurring { task_id, .. } => {
                assert_eq!(*task_id, Some(open), "the open copy is the one to schedule")
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn five_weekdays_imply_weekdays() {
        let conn = init_memory_db().unwrap();
        // Mon 7 .. Fri 11 September, plus a second Monday.
        for day in ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14"]
        {
            completed(&conn, "Timesheet", day);
        }
        let found = suggestions(&conn);
        assert_eq!(
            recurrence_of(&found[0]),
            &SuggestedRecurrence { frequency: RecurrenceFrequency::Weekdays, days_of_week: vec![] }
        );
    }

    #[test]
    fn some_weekdays_imply_weekly_on_those_days() {
        let conn = init_memory_db().unwrap();
        // Monday, Wednesday, Monday, Wednesday, Saturday.
        for day in ["2026-09-07", "2026-09-09", "2026-09-14", TODAY, "2026-09-12"] {
            completed(&conn, "Gym", day);
        }
        let found = suggestions(&conn);
        assert_eq!(
            recurrence_of(&found[0]),
            &SuggestedRecurrence {
                frequency: RecurrenceFrequency::Weekly,
                days_of_week: vec!["MON".into(), "WED".into(), "SAT".into()],
            }
        );
    }

    #[test]
    fn every_day_of_the_week_implies_daily() {
        let conn = init_memory_db().unwrap();
        for day in 10..=16 {
            completed(&conn, "Journal", &format!("2026-09-{day}"));
        }
        assert_eq!(recurrence_of(&suggestions(&conn)[0]).frequency, RecurrenceFrequency::Daily);
    }

    // --- Estimate drift ---------------------------------------------------

    #[test]
    fn three_drifting_completions_suggest_the_median() {
        let conn = init_memory_db().unwrap();
        completed_with_focus(&conn, "Write report", "2026-08-01", 30, 45);
        completed_with_focus(&conn, "Write report", "2026-08-08", 30, 50);
        completed_with_focus(&conn, "write report", "2026-08-15", 30, 48);
        let open = open_task(&conn, "Write report", Some(30));

        let found = suggestions(&conn);
        assert_eq!(
            found,
            vec![Suggestion::UpdateEstimate {
                key: "update_estimate:write report".into(),
                title: "write report".into(),
                task_ids: vec![open],
                current_minutes: 30,
                suggested_minutes: 48,
            }]
        );
    }

    #[test]
    fn a_small_or_proportionally_small_gap_is_not_drift() {
        // 60 → 71 is 11 minutes but under 20%; 30 → 39 is 30% but 9 minutes.
        assert!(!drifts(71 * 60, 60));
        assert!(!drifts(39 * 60, 30));
        assert!(drifts(41 * 60, 30));
        assert!(drifts(15 * 60, 30), "shorter than estimated drifts too");
        assert!(!drifts(0, 30), "no focus time says nothing");
    }

    #[test]
    fn every_one_of_the_last_three_has_to_drift() {
        let conn = init_memory_db().unwrap();
        completed_with_focus(&conn, "Study", "2026-08-01", 30, 60);
        completed_with_focus(&conn, "Study", "2026-08-02", 30, 60);
        completed_with_focus(&conn, "Study", "2026-08-03", 30, 32);
        open_task(&conn, "Study", Some(30));
        assert!(suggestions(&conn).is_empty(), "the newest was on estimate");

        // Three more that drift push the on-estimate one out of the last three.
        completed_with_focus(&conn, "Study", "2026-08-04", 30, 55);
        completed_with_focus(&conn, "Study", "2026-08-05", 30, 55);
        assert!(suggestions(&conn).is_empty(), "the third most recent still agrees");
        completed_with_focus(&conn, "Study", "2026-08-06", 30, 55);
        assert_eq!(suggestions(&conn).len(), 1);
    }

    #[test]
    fn a_completion_without_focus_time_breaks_the_run() {
        let conn = init_memory_db().unwrap();
        completed_with_focus(&conn, "Plan week", "2026-08-01", 20, 45);
        completed_with_focus(&conn, "Plan week", "2026-08-08", 20, 45);
        completed_with_focus(&conn, "Plan week", "2026-08-15", 20, 0);
        open_task(&conn, "Plan week", Some(20));
        assert!(suggestions(&conn).is_empty());
    }

    #[test]
    fn nothing_to_update_means_nothing_to_suggest() {
        let conn = init_memory_db().unwrap();
        for day in ["2026-08-01", "2026-08-08", "2026-08-15"] {
            completed_with_focus(&conn, "Mow lawn", day, 30, 60);
        }
        assert!(suggestions(&conn).is_empty(), "no open copy");

        open_task(&conn, "Mow lawn", None);
        assert!(suggestions(&conn).is_empty(), "an open copy with no estimate");
    }

    #[test]
    fn taking_the_suggestion_ends_it() {
        let conn = init_memory_db().unwrap();
        completed_with_focus(&conn, "Deep work", "2026-08-01", 25, 90);
        completed_with_focus(&conn, "Deep work", "2026-08-02", 25, 50);
        completed_with_focus(&conn, "Deep work", "2026-08-03", 25, 60);
        let open = open_task(&conn, "Deep work", Some(25));

        let Suggestion::UpdateEstimate { task_ids, suggested_minutes, .. } =
            suggestions(&conn).remove(0)
        else {
            panic!("expected UpdateEstimate");
        };
        assert_eq!(suggested_minutes, 60);
        assert_eq!(task_ids, vec![open]);

        conn.execute(
            "UPDATE tasks SET estimated_minutes = ?1 WHERE id = ?2",
            params![suggested_minutes, open],
        )
        .unwrap();
        assert!(suggestions(&conn).is_empty());
    }

    #[test]
    fn a_series_template_is_updated_even_when_already_done() {
        let conn = init_memory_db().unwrap();
        let series = tasks::create(
            &conn,
            serde_json::from_value::<NewTask>(json!({
                "title": "Daily review",
                "estimated_minutes": 15,
                "recurrence": { "frequency": "daily" },
            }))
            .unwrap(),
        )
        .unwrap();
        for day in ["2026-08-01", "2026-08-02"] {
            completed_with_focus(&conn, "Daily review", day, 15, 40);
        }
        conn.execute(
            "UPDATE tasks SET status = 'completed', completed_at = datetime('now') WHERE id = ?1",
            params![series.id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO focus_sessions (task_id, started_at, ended_at, duration_seconds, completed)
             VALUES (?1, datetime('now'), datetime('now'), 2400, 1)",
            params![series.id],
        )
        .unwrap();

        match &suggestions(&conn)[..] {
            [Suggestion::UpdateEstimate { task_ids, suggested_minutes, .. }] => {
                assert_eq!(task_ids, &vec![series.id]);
                assert_eq!(*suggested_minutes, 40);
            }
            other => panic!("{other:?}"),
        }
    }

    // --- Dismissal --------------------------------------------------------

    #[test]
    fn a_dismissed_suggestion_stays_gone_for_that_title() {
        let conn = init_memory_db().unwrap();
        for day in ["2026-09-14", "2026-09-15", TODAY] {
            completed(&conn, "Read news", day);
            completed(&conn, "Walk dog", day);
        }
        assert_eq!(suggestions(&conn).len(), 2);

        dismiss(&conn, "make_recurring:read news").unwrap();
        let left = suggestions(&conn);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].key(), "make_recurring:walk dog");

        // More completions, differently spelled, do not bring it back.
        completed(&conn, "READ NEWS", "2026-09-13");
        assert_eq!(suggestions(&conn).len(), 1);
    }

    #[test]
    fn dismissing_one_kind_leaves_the_other() {
        let conn = init_memory_db().unwrap();
        for day in ["2026-09-14", "2026-09-15", TODAY] {
            completed_with_focus(&conn, "Emails", day, 10, 30);
        }
        open_task(&conn, "Emails", Some(10));
        assert_eq!(suggestions(&conn).len(), 2);

        dismiss(&conn, "update_estimate:emails").unwrap();
        let left = suggestions(&conn);
        assert_eq!(left.len(), 1);
        assert!(matches!(left[0], Suggestion::MakeRecurring { .. }));
    }

    #[test]
    fn only_a_suggestion_key_can_be_dismissed() {
        let conn = init_memory_db().unwrap();
        for bad in ["", "make_recurring", "make_recurring:", "other:title", "make_recurring:Title"] {
            assert!(dismiss(&conn, bad).is_err(), "{bad:?}");
        }
        dismiss(&conn, "make_recurring:title").unwrap();
    }

    // --- You often open these together ------------------------------------

    /// `app` in real use at `hour` on each of `days` (dates in September 2026).
    fn used(conn: &Connection, app: &str, days: &[u32], hour: i64) {
        for day in days {
            app_usage::record(
                conn,
                &format!("2026-09-{day:02}"),
                hour,
                app,
                Some(&format!(r"C:\Apps\{app}")),
                600,
            )
            .unwrap();
        }
    }

    fn together(conn: &Connection) -> Vec<(Vec<String>, usize)> {
        suggestions(conn)
            .into_iter()
            .filter_map(|suggestion| match suggestion {
                Suggestion::OpenTogether { apps, days_together, .. } => {
                    Some((apps.into_iter().map(|app| app.app_name).collect(), days_together))
                }
                _ => None,
            })
            .collect()
    }

    const FIVE_DAYS: [u32; 5] = [8, 9, 10, 11, 14];

    #[test]
    fn programs_used_in_the_same_hour_on_five_days_suggest_a_routine() {
        let conn = init_memory_db().unwrap();
        used(&conn, "Code.exe", &FIVE_DAYS, 9);
        used(&conn, "chrome.exe", &FIVE_DAYS, 9);
        used(&conn, "WindowsTerminal.exe", &FIVE_DAYS, 9);
        // Used on the same days, but never in the same hour.
        used(&conn, "Spotify.exe", &FIVE_DAYS, 20);
        // Always around, so never part of a workspace.
        used(&conn, "explorer.exe", &FIVE_DAYS, 9);

        assert_eq!(
            together(&conn),
            vec![(
                vec![
                    "chrome.exe".to_string(),
                    "Code.exe".to_string(),
                    "WindowsTerminal.exe".to_string()
                ],
                5
            )]
        );
    }

    #[test]
    fn four_days_or_brief_use_is_not_enough() {
        let conn = init_memory_db().unwrap();
        used(&conn, "Code.exe", &[8, 9, 10, 11], 9);
        used(&conn, "chrome.exe", &[8, 9, 10, 11], 9);
        assert!(together(&conn).is_empty());

        // A fifth day where one of them was only glanced at.
        used(&conn, "Code.exe", &[14], 9);
        app_usage::record(&conn, "2026-09-14", 9, "chrome.exe", Some(r"C:\chrome.exe"), 30).unwrap();
        assert!(together(&conn).is_empty());
    }

    #[test]
    fn a_group_a_routine_already_opens_is_not_suggested() {
        let conn = init_memory_db().unwrap();
        used(&conn, "Code.exe", &FIVE_DAYS, 9);
        used(&conn, "chrome.exe", &FIVE_DAYS, 9);
        assert_eq!(together(&conn).len(), 1);

        conn.execute("INSERT INTO routines (id, name) VALUES (1, 'Coding')", []).unwrap();
        conn.execute(
            r"INSERT INTO routine_actions (routine_id, type, target, sort_order)
              VALUES (1, 'application', 'C:\Program Files\Google\chrome.exe', 0),
                     (1, 'application', 'code', 1)",
            [],
        )
        .unwrap();
        assert!(together(&conn).is_empty());
    }

    #[test]
    fn a_dismissed_group_stays_gone() {
        let conn = init_memory_db().unwrap();
        used(&conn, "Code.exe", &FIVE_DAYS, 9);
        used(&conn, "chrome.exe", &FIVE_DAYS, 9);

        let key = suggestions(&conn)[0].key().to_owned();
        assert_eq!(key, "open_together:chrome.exe+code.exe");
        dismiss(&conn, &key).unwrap();
        assert!(together(&conn).is_empty());
    }

    #[test]
    fn serializes_the_shape_the_frontend_reads() {
        let suggestion = Suggestion::MakeRecurring {
            key: "make_recurring:gym".into(),
            title: "Gym".into(),
            task_id: None,
            template: TaskTemplate {
                title: "Gym".into(),
                priority: TaskPriority::High,
                category_id: None,
                estimated_minutes: Some(60),
                routine_id: None,
            },
            days_completed: 3,
            recurrence: SuggestedRecurrence {
                frequency: RecurrenceFrequency::Weekly,
                days_of_week: vec!["MON".into()],
            },
        };
        let value = serde_json::to_value(&suggestion).unwrap();
        assert_eq!(value["kind"], "make_recurring");
        assert_eq!(value["recurrence"]["frequency"], "weekly");
        assert_eq!(value["template"]["priority"], "high");
    }
}
