//! Task reminders: what the user configured, and when it is next owed.
//!
//! Section 24 gives a reminder two forms — "10 minutes before" and "At 5:00
//! PM" — and three buttons on the notification it produces: Start Task,
//! Snooze, Dismiss. This module owns the storage and the arithmetic behind
//! both halves; `services/notifications.rs` owns turning the result into an
//! actual desktop notification, and `commands/notification.rs` is the thin
//! `invoke` boundary over the two (section 86).
//!
//! ## Where the columns live
//!
//! The five `reminder_*` columns are on `tasks` (see
//! `database/migrations/0004_task_reminders.sql`), which makes this module
//! the one deliberate exception to `services/tasks.rs` owning every statement
//! that touches that table: it owns the task, this owns the reminder on it.
//! The seam is kept narrow on purpose — every query here names only the
//! reminder columns plus the few task fields a reminder is *about* (title,
//! status, due date and time), and `tasks.rs` renders the reminder back onto
//! a `Task` through [`TASK_COLUMNS`] and [`TaskReminder::from_row`] rather
//! than reading those columns itself.
//!
//! ## When a reminder fires
//!
//! Everything is derived from the task, never scheduled ahead:
//!
//! ```text
//! fire_at   = due_date + due_time      - N minutes   (minutes_before)
//!           = due_date + reminder_time               (at_time)
//! effective = snoozed_until, if snoozed, else fire_at
//! owed      = effective <= now  AND  (fired_at IS NULL OR fired_at < effective)
//! ```
//!
//! Storing the *rule* and computing the moment on every poll is what keeps
//! the reminder honest when the task moves: pushing a task to tomorrow gives
//! it a later `fire_at`, which is by definition after the `fired_at` of the
//! notification already sent, so the reminder arms itself again with nothing
//! having to reach in and reset it. The same comparison is what makes Snooze
//! and Dismiss two writes of the same two columns rather than a scheduler
//! that has to remember anything — see [`snooze`] and [`dismiss`].
//!
//! Times are stored the way the rest of the app stores them: `YYYY-MM-DD`
//! dates and 24-hour `HH:MM` times are the user's *local* wall clock, and the
//! two delivery-state timestamps are UTC `YYYY-MM-DD HH:MM:SS` strings from
//! SQLite's `datetime('now')`. The `'utc'` modifier is what joins them, so a
//! reminder set for 5:00 PM means 5:00 PM where the user is.

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, Connection, OptionalExtension, Row, ToSql};
use serde::{Deserialize, Serialize};

use super::error::{ServiceError, ServiceResult};
use super::validate::{normalize_text, validate_time};

/// How long after its moment a reminder may still be delivered.
///
/// A desktop app is not always running, and a reminder that fires the instant
/// the app reopens is worse than one that stays quiet: nobody needs to be
/// told at 4pm to start something that was due at 9am, and a machine opened
/// after a week away would otherwise unleash one toast per missed reminder.
/// Inside the window a late notification is still useful — the app was
/// starting up, or the laptop was asleep for a few minutes — so the grace
/// period is generous rather than exact.
///
/// A reminder that misses this window is never marked as delivered; it simply
/// stays pending and silent. The task is overdue by then and says so in every
/// view, which is the reminder that is actually still worth something.
const MAX_MINUTES_LATE: i64 = 60;

/// How long Snooze puts a reminder away for when the caller does not say.
///
/// Ten minutes matches the "10 minutes before" the section 24 mockup is
/// configured with: the snooze is the same size as the warning, so pressing
/// it once is "give me that warning again".
pub const DEFAULT_SNOOZE_MINUTES: i64 = 10;

/// The longest lead time a reminder may be given: one week.
///
/// Anything longer is a different task, not a reminder about this one, and
/// the number is almost certainly a typo (`10080` where `100` was meant).
const MAX_MINUTES_BEFORE: i64 = 7 * 24 * 60;

/// The reminder columns, in the order [`TaskReminder::from_row`] reads them.
///
/// `tasks.rs` splices this into its own `SELECT` list so a `Task` carries its
/// reminder without a second query — see the module docs on why the reminder
/// columns are read through here rather than there.
pub const TASK_COLUMNS: &str = "reminder_kind, reminder_minutes_before, reminder_time, \
     reminder_snoozed_until, reminder_fired_at";

/// The moment a task's reminder is for, as a UTC timestamp, or NULL when the
/// task is not configured for one — or is configured in a way that cannot be
/// resolved to a moment.
///
/// The second case is the interesting one and is why this is expression-shaped
/// rather than a stored column: a "10 minutes before" reminder on a task whose
/// due *time* has since been cleared has nothing to count back from, so the
/// concatenation is NULL, `datetime()` of NULL is NULL, and the reminder drops
/// out of every query below instead of firing at some invented hour. It starts
/// working again by itself the moment a due time is put back.
const FIRE_AT: &str = "CASE reminder_kind \
        WHEN 'minutes_before' \
            THEN datetime(due_date || ' ' || due_time, 'utc', \
                          '-' || reminder_minutes_before || ' minutes') \
        WHEN 'at_time' \
            THEN datetime(due_date || ' ' || reminder_time, 'utc') \
     END";

/// When the task itself falls due, as a UTC timestamp, or NULL for a task
/// dated but not timed. NULL here is "some time today", which is exactly how
/// [`PendingReminder::minutes_until_due`] reports it.
const DUE_AT: &str = "datetime(due_date || ' ' || due_time, 'utc')";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Section 24's two forms of reminder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReminderKind {
    /// "10 minutes before" — counted back from the task's due date *and*
    /// time, so the task needs both.
    MinutesBefore,
    /// "At 5:00 PM" — a wall-clock time on the task's due date, which is the
    /// form to use for a task that is due on a day rather than at an hour.
    AtTime,
}

impl ReminderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MinutesBefore => "minutes_before",
            Self::AtTime => "at_time",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "minutes_before" => Some(Self::MinutesBefore),
            "at_time" => Some(Self::AtTime),
            _ => None,
        }
    }
}

impl ToSql for ReminderKind {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.as_str()))
    }
}

impl FromSql for ReminderKind {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let raw = value.as_str()?;
        Self::parse(raw)
            .ok_or_else(|| FromSqlError::Other(format!("unknown reminder kind {raw:?}").into()))
    }
}

/// A task's reminder as stored: what the user asked for, plus where its
/// delivery has got to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskReminder {
    pub kind: ReminderKind,
    /// Set for `minutes_before`, null for `at_time`.
    pub minutes_before: Option<i64>,
    /// Local 24-hour `HH:MM`. Set for `at_time`, null for `minutes_before`.
    pub at_time: Option<String>,
    /// UTC timestamp a snoozed reminder is due back at, or null when it is
    /// not snoozed. Set by [`snooze`] and cleared by [`dismiss`] and by any
    /// re-configuration.
    pub snoozed_until: Option<String>,
    /// UTC timestamp of the last notification sent for this reminder, or null
    /// if it has never been delivered. Also what Dismiss writes — a dismissed
    /// reminder is one that counts as already delivered.
    pub fired_at: Option<String>,
}

impl TaskReminder {
    /// Reads the reminder columns off a row that selected [`TASK_COLUMNS`],
    /// answering `None` for a task with no reminder configured.
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Option<Self>> {
        let Some(kind) = row.get::<_, Option<ReminderKind>>("reminder_kind")? else {
            return Ok(None);
        };

        Ok(Some(Self {
            kind,
            minutes_before: row.get("reminder_minutes_before")?,
            at_time: row.get("reminder_time")?,
            snoozed_until: row.get("reminder_snoozed_until")?,
            fired_at: row.get("reminder_fired_at")?,
        }))
    }
}

/// One task's reminder, for the frontend's "which tasks have reminders?"
/// read. Listing them in one call is what lets a task list draw a bell on
/// every row it needs to without a query per row.
#[derive(Debug, Clone, Serialize)]
pub struct TaskReminderEntry {
    pub task_id: i64,
    pub task_title: String,
    pub reminder: TaskReminder,
}

/// What the caller sends to configure a reminder.
///
/// `minutes_before` and `at_time` are both optional here and the one that
/// matters is decided by `kind`; the other is ignored and stored as NULL, so
/// switching a reminder from one form to the other can never leave the
/// abandoned form's value behind to be read back later.
#[derive(Debug, Clone, Deserialize)]
pub struct ReminderInput {
    pub kind: ReminderKind,
    #[serde(default)]
    pub minutes_before: Option<i64>,
    #[serde(default)]
    pub at_time: Option<String>,
}

/// A reminder that is owed right now, with everything the notification needs
/// to be written without a second query.
#[derive(Debug, Clone, Serialize)]
pub struct PendingReminder {
    pub task_id: i64,
    pub task_title: String,
    pub kind: ReminderKind,
    /// The lead time, for a `minutes_before` reminder.
    pub minutes_before: Option<i64>,
    pub due_date: String,
    /// Null for a task due on a day rather than at an hour.
    pub due_time: Option<String>,
    /// Minutes from now until the task is due: positive before it is due,
    /// zero or negative once it is late, and null when the task has no due
    /// time so there is no hour to count to.
    ///
    /// Read at poll time rather than taken from `minutes_before`, so a
    /// notification delayed by a sleeping laptop says how long is *actually*
    /// left rather than repeating the lead time it was configured with.
    pub minutes_until_due: Option<i64>,
    /// True when this delivery is a snooze coming back rather than the
    /// reminder's original moment.
    pub snoozed: bool,
    /// The routine this task starts with (section 18), or null — carried so
    /// that acting on the notification can launch the workspace, not just
    /// open the task.
    pub routine_id: Option<i64>,
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Reads one task's reminder, or `None` when it has none — including when the
/// task itself is gone, which the caller can treat as the same thing.
pub fn get(conn: &Connection, task_id: i64) -> ServiceResult<Option<TaskReminder>> {
    let sql = format!("SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?1");
    Ok(conn
        .query_row(&sql, params![task_id], TaskReminder::from_row)
        .optional()?
        .flatten())
}

/// Every configured reminder, on open tasks only.
///
/// Completed and cancelled tasks are left out for the same reason they never
/// fire: their reminder is still stored — reopening the task brings it back —
/// but it is not something the user is currently being reminded about, so it
/// does not belong in a list of what is set.
pub fn list(conn: &Connection) -> ServiceResult<Vec<TaskReminderEntry>> {
    let sql = format!(
        "SELECT id, title, {TASK_COLUMNS} FROM tasks \
          WHERE reminder_kind IS NOT NULL AND status IN ('todo', 'in_progress') \
          ORDER BY due_date, due_time, id"
    );

    let mut statement = conn.prepare(&sql)?;
    let entries = statement
        .query_map([], |row| {
            let task_id = row.get("id")?;
            let task_title = row.get("title")?;
            Ok(TaskReminder::from_row(row)?.map(|reminder| TaskReminderEntry {
                task_id,
                task_title,
                reminder,
            }))
        })?
        .collect::<rusqlite::Result<Vec<Option<TaskReminderEntry>>>>()?;

    Ok(entries.into_iter().flatten().collect())
}

/// Sets, replaces or (with `None`) removes a task's reminder, and answers
/// with what is stored afterwards.
///
/// Configuring a reminder always clears its delivery state, so a reminder
/// that has already fired once starts pending again the moment it is changed
/// — which is what the user means by changing it. Removing one clears every
/// column, so nothing is left behind to be read as a half-configured
/// reminder.
///
/// Rejects a reminder the task cannot support: both forms need a due date to
/// hang off, and "N minutes before" additionally needs a due *time* to count
/// back from. Saying so here is much better than storing it and letting the
/// scheduler silently never fire it.
pub fn set(
    conn: &Connection,
    task_id: i64,
    input: Option<ReminderInput>,
) -> ServiceResult<Option<TaskReminder>> {
    let (due_date, due_time) = task_schedule(conn, task_id)?;

    let Some(input) = input else {
        conn.execute(
            "UPDATE tasks SET reminder_kind = NULL, reminder_minutes_before = NULL, \
                    reminder_time = NULL, reminder_snoozed_until = NULL, \
                    reminder_fired_at = NULL \
              WHERE id = ?1",
            params![task_id],
        )?;
        return Ok(None);
    };

    if due_date.is_none() {
        return Err(ServiceError::validation(
            "A task needs a due date before it can have a reminder.",
        ));
    }

    let (minutes_before, at_time) = match input.kind {
        ReminderKind::MinutesBefore => {
            if due_time.is_none() {
                return Err(ServiceError::validation(
                    "A reminder set for a number of minutes before needs the task to have a due time.",
                ));
            }
            (Some(validate_minutes_before(input.minutes_before)?), None)
        }
        ReminderKind::AtTime => (None, Some(validate_at_time(input.at_time)?)),
    };

    conn.execute(
        "UPDATE tasks SET reminder_kind = ?2, reminder_minutes_before = ?3, \
                reminder_time = ?4, reminder_snoozed_until = NULL, reminder_fired_at = NULL \
          WHERE id = ?1",
        params![task_id, input.kind, minutes_before, at_time],
    )?;

    get(conn, task_id)
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/// The reminders owed right now, oldest moment first.
///
/// This is the whole of the scheduler's decision, expressed once as SQL so
/// there is no second copy of the rule to disagree with it:
///
/// * the task is still open — finishing or cancelling a task silences its
///   reminder without the user having to go and turn it off;
/// * the reminder resolves to a moment at all (see [`FIRE_AT`]);
/// * that moment — or the snooze standing in for it — has arrived, and is not
///   older than [`MAX_MINUTES_LATE`];
/// * nothing has already been delivered *for that moment*.
///
/// Nothing is written here. [`mark_fired`] is a separate call the caller
/// makes once the notification is actually on screen, so a reminder is never
/// recorded as delivered because a query ran.
pub fn due(conn: &Connection) -> ServiceResult<Vec<PendingReminder>> {
    let sql = format!(
        "SELECT id, title, reminder_kind, reminder_minutes_before, due_date, due_time, \
                routine_id, \
                reminder_snoozed_until IS NOT NULL AS snoozed, \
                CAST(ROUND((julianday({DUE_AT}) - julianday('now')) * 1440) AS INTEGER) \
                    AS minutes_until_due, \
                COALESCE(reminder_snoozed_until, {FIRE_AT}) AS effective_at \
           FROM tasks \
          WHERE reminder_kind IS NOT NULL \
            AND status IN ('todo', 'in_progress') \
            AND effective_at IS NOT NULL \
            AND effective_at <= datetime('now') \
            AND effective_at > datetime('now', '-{MAX_MINUTES_LATE} minutes') \
            AND (reminder_fired_at IS NULL OR reminder_fired_at < effective_at) \
          ORDER BY effective_at, id"
    );

    let mut statement = conn.prepare(&sql)?;
    let pending = statement
        .query_map([], |row| {
            Ok(PendingReminder {
                task_id: row.get("id")?,
                task_title: row.get("title")?,
                kind: row.get("reminder_kind")?,
                minutes_before: row.get("reminder_minutes_before")?,
                due_date: row.get("due_date")?,
                due_time: row.get("due_time")?,
                minutes_until_due: row.get("minutes_until_due")?,
                snoozed: row.get("snoozed")?,
                routine_id: row.get("routine_id")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<PendingReminder>>>()?;

    Ok(pending)
}

/// Records that the notification for this reminder has been shown.
///
/// `updated_at` is deliberately left alone: delivering a reminder is
/// something that happened *to* the task, not an edit of it, and touching the
/// timestamp would make every reminder look like the user had just changed
/// the task.
pub fn mark_fired(conn: &Connection, task_id: i64) -> ServiceResult<()> {
    conn.execute(
        "UPDATE tasks SET reminder_fired_at = datetime('now') WHERE id = ?1",
        params![task_id],
    )?;
    Ok(())
}

/// Section 24's Snooze: put the reminder back for `minutes` (default
/// [`DEFAULT_SNOOZE_MINUTES`]) and let it come round again.
///
/// Both columns are written. The snooze is the new moment the reminder is
/// for, and stamping `fired_at` at the same time is what stops the reminder
/// firing again in the seconds between now and then. Because the snooze is in
/// the future it is by definition after that stamp, so [`due`] will pick the
/// reminder up exactly once more when it arrives.
///
/// The task is not touched, and neither is the configuration: a snoozed
/// "10 minutes before" reminder is still a "10 minutes before" reminder.
pub fn snooze(
    conn: &Connection,
    task_id: i64,
    minutes: Option<i64>,
) -> ServiceResult<Option<TaskReminder>> {
    let minutes = validate_snooze_minutes(minutes.unwrap_or(DEFAULT_SNOOZE_MINUTES))?;
    require_reminder(conn, task_id)?;

    conn.execute(
        "UPDATE tasks \
            SET reminder_snoozed_until = datetime('now', ?2), \
                reminder_fired_at = datetime('now') \
          WHERE id = ?1 AND reminder_kind IS NOT NULL",
        params![task_id, format!("+{minutes} minutes")],
    )?;

    get(conn, task_id)
}

/// Section 24's Dismiss: silence this reminder without deleting anything.
///
/// The reminder stays configured and the task is untouched — dismissing a
/// notification is not finishing the work. All it does is drop any snooze and
/// count the reminder as delivered, which leaves `fired_at` later than the
/// moment the reminder is for and so keeps it quiet.
///
/// It is quiet, not gone: moving the task's due date forward puts the
/// reminder's moment after this stamp, so a rescheduled task is reminded
/// about again — which is the right answer for work that has been put off
/// rather than dealt with.
pub fn dismiss(conn: &Connection, task_id: i64) -> ServiceResult<Option<TaskReminder>> {
    require_reminder(conn, task_id)?;

    conn.execute(
        "UPDATE tasks \
            SET reminder_snoozed_until = NULL, reminder_fired_at = datetime('now') \
          WHERE id = ?1 AND reminder_kind IS NOT NULL",
        params![task_id],
    )?;

    get(conn, task_id)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// The due date and time of the task a reminder is being set on, rejecting a
/// task id that is not there.
fn task_schedule(conn: &Connection, task_id: i64) -> ServiceResult<(Option<String>, Option<String>)> {
    conn.query_row(
        "SELECT due_date, due_time FROM tasks WHERE id = ?1",
        params![task_id],
        |row| Ok((row.get("due_date")?, row.get("due_time")?)),
    )
    .optional()?
    .ok_or_else(|| ServiceError::not_found(format!("Task {task_id} was not found.")))
}

/// Refuses Snooze and Dismiss on a task with no reminder to act on, so a
/// stale notification acted on after the reminder was removed says so rather
/// than silently doing nothing.
fn require_reminder(conn: &Connection, task_id: i64) -> ServiceResult<()> {
    match get(conn, task_id)? {
        Some(_) => Ok(()),
        None => Err(ServiceError::not_found(format!(
            "Task {task_id} no longer has a reminder."
        ))),
    }
}

fn validate_minutes_before(minutes: Option<i64>) -> ServiceResult<i64> {
    match minutes {
        None => Err(ServiceError::validation(
            "A reminder set before the due time needs to say how many minutes before.",
        )),
        Some(minutes) if minutes < 1 => Err(ServiceError::validation(
            "A reminder must be at least 1 minute before the task is due.",
        )),
        Some(minutes) if minutes > MAX_MINUTES_BEFORE => Err(ServiceError::validation(
            "A reminder cannot be set more than a week before the task is due.",
        )),
        Some(minutes) => Ok(minutes),
    }
}

fn validate_at_time(at_time: Option<String>) -> ServiceResult<String> {
    match normalize_text(at_time) {
        None => Err(ServiceError::validation(
            "A reminder set for a specific time needs that time.",
        )),
        Some(time) => validate_time("Reminder time", &time),
    }
}

fn validate_snooze_minutes(minutes: i64) -> ServiceResult<i64> {
    if !(1..=MAX_MINUTES_BEFORE).contains(&minutes) {
        return Err(ServiceError::validation(
            "A reminder can be snoozed for between a minute and a week.",
        ));
    }
    Ok(minutes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    /// Re-dates a task to `minutes` from now on the user's local clock.
    ///
    /// Date and time always move together, which is not fussiness: a test run
    /// at 23:58 that set only the *time* to "ten minutes from now" would
    /// write tomorrow's 00:08 onto today's date and send the reminder
    /// twenty-four hours into the past.
    fn set_due_in(conn: &Connection, task_id: i64, minutes: i64) {
        conn.execute(
            "UPDATE tasks SET due_date = date('now', 'localtime', ?2), \
                    due_time = strftime('%H:%M', 'now', 'localtime', ?2) \
              WHERE id = ?1",
            params![task_id, format!("{minutes:+} minutes")],
        )
        .unwrap();
    }

    /// A task due `minutes` from now, returned as its id.
    fn task_due_in(conn: &Connection, title: &str, minutes: i64) -> i64 {
        conn.execute("INSERT INTO tasks (title) VALUES (?1)", params![title])
            .unwrap();
        let id = conn.last_insert_rowid();
        set_due_in(conn, id, minutes);
        id
    }

    /// A task due today with no time of day — the shape an `at_time` reminder
    /// exists for.
    fn task_due_today(conn: &Connection, title: &str) -> i64 {
        conn.execute(
            "INSERT INTO tasks (title, due_date) VALUES (?1, date('now', 'localtime'))",
            params![title],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn minutes_before(minutes: i64) -> ReminderInput {
        ReminderInput {
            kind: ReminderKind::MinutesBefore,
            minutes_before: Some(minutes),
            at_time: None,
        }
    }

    fn at_time(time: &str) -> ReminderInput {
        ReminderInput {
            kind: ReminderKind::AtTime,
            minutes_before: None,
            at_time: Some(time.to_owned()),
        }
    }

    /// The local `HH:MM` `minutes` from now, for an `at_time` reminder that
    /// should (or should not) already be owed.
    fn local_time_in(conn: &Connection, minutes: i64) -> String {
        conn.query_row(
            "SELECT strftime('%H:%M', 'now', 'localtime', ?1)",
            params![format!("{minutes:+} minutes")],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// Everything about a task that Snooze and Dismiss must not touch, as one
    /// comparable tuple: the row still being there is half the claim, and it
    /// still saying the same things is the other half.
    fn task_snapshot(
        conn: &Connection,
        task_id: i64,
    ) -> (String, String, Option<String>, Option<String>, Option<i64>, Option<String>, String) {
        conn.query_row(
            "SELECT title, status, due_date, due_time, routine_id, completed_at, updated_at                FROM tasks WHERE id = ?1",
            params![task_id],
            |row| {
                Ok((
                    row.get("title")?,
                    row.get("status")?,
                    row.get("due_date")?,
                    row.get("due_time")?,
                    row.get("routine_id")?,
                    row.get("completed_at")?,
                    row.get("updated_at")?,
                ))
            },
        )
        .unwrap()
    }

    /// How far ahead a snooze was set, in whole minutes from now.
    fn snooze_minutes_ahead(conn: &Connection, task_id: i64) -> i64 {
        conn.query_row(
            "SELECT CAST(ROUND((julianday(reminder_snoozed_until) - julianday('now')) * 1440)                     AS INTEGER) FROM tasks WHERE id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn due_ids(conn: &Connection) -> Vec<i64> {
        due(conn)
            .unwrap()
            .into_iter()
            .map(|reminder| reminder.task_id)
            .collect()
    }

    #[test]
    fn stores_and_clears_a_reminder() {
        let conn = init_memory_db().unwrap();
        let id = task_due_in(&conn, "Finish report", 60);

        assert_eq!(get(&conn, id).unwrap(), None);

        let stored = set(&conn, id, Some(minutes_before(10))).unwrap().unwrap();
        assert_eq!(stored.kind, ReminderKind::MinutesBefore);
        assert_eq!(stored.minutes_before, Some(10));
        assert_eq!(stored.at_time, None);
        assert_eq!(stored.fired_at, None);

        // Switching form leaves nothing of the old one behind.
        let stored = set(&conn, id, Some(at_time("17:00"))).unwrap().unwrap();
        assert_eq!(stored.kind, ReminderKind::AtTime);
        assert_eq!(stored.minutes_before, None);
        assert_eq!(stored.at_time.as_deref(), Some("17:00"));

        assert_eq!(set(&conn, id, None).unwrap(), None);
        assert_eq!(get(&conn, id).unwrap(), None);
    }

    #[test]
    fn refuses_a_reminder_the_task_cannot_support() {
        let conn = init_memory_db().unwrap();

        conn.execute("INSERT INTO tasks (title) VALUES ('Undated')", [])
            .unwrap();
        let undated = conn.last_insert_rowid();
        assert!(set(&conn, undated, Some(at_time("17:00"))).is_err());

        // Dated but not timed: "at 5pm" works, "10 minutes before" has
        // nothing to count back from.
        let dated = task_due_today(&conn, "Dated only");
        assert!(set(&conn, dated, Some(at_time("17:00"))).is_ok());
        assert!(set(&conn, dated, Some(minutes_before(10))).is_err());

        let timed = task_due_in(&conn, "Timed", 60);
        for bad in [
            ReminderInput {
                kind: ReminderKind::MinutesBefore,
                minutes_before: None,
                at_time: None,
            },
            minutes_before(0),
            minutes_before(MAX_MINUTES_BEFORE + 1),
            at_time("25:00"),
            ReminderInput {
                kind: ReminderKind::AtTime,
                minutes_before: Some(10),
                at_time: None,
            },
        ] {
            assert!(set(&conn, timed, Some(bad)).is_err());
        }

        assert!(set(&conn, 9999, Some(at_time("17:00"))).is_err());
    }

    #[test]
    fn fires_once_the_moment_has_arrived_and_only_once() {
        let conn = init_memory_db().unwrap();
        let soon = task_due_in(&conn, "Due in five", 5);
        let later = task_due_in(&conn, "Due in an hour", 60);

        set(&conn, soon, Some(minutes_before(10))).unwrap();
        set(&conn, later, Some(minutes_before(10))).unwrap();

        // Only the first task's moment (five minutes ago) has passed.
        assert_eq!(due_ids(&conn), vec![soon]);

        let pending = due(&conn).unwrap().remove(0);
        assert_eq!(pending.task_title, "Due in five");
        assert_eq!(pending.minutes_before, Some(10));
        // Four or five: the due time is stored to the minute, so how far off
        // it is depends on where in the current minute the test is running.
        assert!(
            matches!(pending.minutes_until_due, Some(4..=5)),
            "unexpected countdown: {:?}",
            pending.minutes_until_due
        );
        assert!(!pending.snoozed);

        mark_fired(&conn, soon).unwrap();
        assert!(due_ids(&conn).is_empty());
    }

    #[test]
    fn fires_an_at_time_reminder_on_its_own_clock() {
        let conn = init_memory_db().unwrap();
        let task = task_due_today(&conn, "Dated only");

        set(&conn, task, Some(at_time(&local_time_in(&conn, 30)))).unwrap();
        assert!(due_ids(&conn).is_empty());

        set(&conn, task, Some(at_time(&local_time_in(&conn, -2)))).unwrap();
        let pending = due(&conn).unwrap().remove(0);
        assert_eq!(pending.task_id, task);
        // No due time on the task, so there is no hour to count towards.
        assert_eq!(pending.minutes_until_due, None);
    }

    #[test]
    fn stays_quiet_for_reminders_that_are_far_too_late() {
        let conn = init_memory_db().unwrap();
        let stale = task_due_in(&conn, "Yesterday's problem", -(MAX_MINUTES_LATE + 30));

        set(&conn, stale, Some(minutes_before(1))).unwrap();
        assert!(due_ids(&conn).is_empty());
        // And it is left pending rather than quietly marked as delivered.
        assert_eq!(get(&conn, stale).unwrap().unwrap().fired_at, None);
    }

    #[test]
    fn stays_quiet_for_tasks_that_are_no_longer_open() {
        let conn = init_memory_db().unwrap();
        let task = task_due_in(&conn, "Already done", 5);
        set(&conn, task, Some(minutes_before(10))).unwrap();
        assert_eq!(due_ids(&conn), vec![task]);

        for status in ["completed", "cancelled"] {
            conn.execute(
                "UPDATE tasks SET status = ?2 WHERE id = ?1",
                params![task, status],
            )
            .unwrap();
            assert!(due_ids(&conn).is_empty(), "{status} tasks must not remind");
        }

        // Reopening the task brings the reminder back — it was never deleted.
        conn.execute("UPDATE tasks SET status = 'todo' WHERE id = ?1", params![task])
            .unwrap();
        assert_eq!(due_ids(&conn), vec![task]);
    }

    #[test]
    fn stays_quiet_when_the_due_time_it_counted_back_from_is_gone() {
        let conn = init_memory_db().unwrap();
        let task = task_due_in(&conn, "Timed, then not", 5);
        set(&conn, task, Some(minutes_before(10))).unwrap();

        conn.execute("UPDATE tasks SET due_time = NULL WHERE id = ?1", params![task])
            .unwrap();
        assert!(due_ids(&conn).is_empty());

        // The reminder itself survives, and works again once there is a time.
        assert!(get(&conn, task).unwrap().is_some());
        set_due_in(&conn, task, 5);
        assert_eq!(due_ids(&conn), vec![task]);
    }

    #[test]
    fn snoozing_brings_the_reminder_back_and_dismissing_does_not() {
        let conn = init_memory_db().unwrap();
        let task = task_due_in(&conn, "Finish report", 5);
        set(&conn, task, Some(minutes_before(10))).unwrap();
        mark_fired(&conn, task).unwrap();

        let snoozed = snooze(&conn, task, Some(5)).unwrap().unwrap();
        assert!(snoozed.snoozed_until.is_some());
        // The configuration is untouched by a snooze.
        assert_eq!(snoozed.minutes_before, Some(10));
        assert!(due_ids(&conn).is_empty(), "a snooze must be quiet until it is up");

        // Once the snooze is up the reminder is owed again, and says so.
        // Standing in for five minutes passing: the snooze was pressed six
        // minutes ago and came due a minute ago.
        conn.execute(
            "UPDATE tasks SET reminder_snoozed_until = datetime('now', '-1 minute'), \
                    reminder_fired_at = datetime('now', '-6 minutes') \
              WHERE id = ?1",
            params![task],
        )
        .unwrap();
        let pending = due(&conn).unwrap().remove(0);
        assert!(pending.snoozed);

        // Dismissing drops the snooze and keeps the reminder — and the task.
        let dismissed = dismiss(&conn, task).unwrap().unwrap();
        assert_eq!(dismissed.snoozed_until, None);
        assert!(dismissed.fired_at.is_some());
        assert!(due_ids(&conn).is_empty());
        assert_eq!(get(&conn, task).unwrap().unwrap().minutes_before, Some(10));
    }

    #[test]
    fn rescheduling_the_task_arms_the_reminder_again() {
        let conn = init_memory_db().unwrap();
        let task = task_due_in(&conn, "Moved on", 5);
        set(&conn, task, Some(minutes_before(30))).unwrap();

        // Reminded twenty minutes ago, for a moment twenty-five minutes ago:
        // that one is delivered and done with.
        conn.execute(
            "UPDATE tasks SET reminder_fired_at = datetime('now', '-20 minutes') WHERE id = ?1",
            params![task],
        )
        .unwrap();
        assert!(due_ids(&conn).is_empty());

        // Pushed back a quarter of an hour. The reminder's moment moves with
        // the task, and now falls *after* the notification that was already
        // sent — so it is owed again, with nothing having reset it.
        set_due_in(&conn, task, 20);
        assert_eq!(due_ids(&conn), vec![task]);

        // Pushed into next week instead: still armed, but silent until it
        // comes round.
        conn.execute(
            "UPDATE tasks SET due_date = date('now', 'localtime', '+7 days') WHERE id = ?1",
            params![task],
        )
        .unwrap();
        assert!(due_ids(&conn).is_empty());
        assert!(get(&conn, task).unwrap().is_some());
    }

    #[test]
    fn reconfiguring_a_reminder_clears_what_was_delivered() {
        let conn = init_memory_db().unwrap();
        let task = task_due_in(&conn, "Changed my mind", 5);
        set(&conn, task, Some(minutes_before(10))).unwrap();
        snooze(&conn, task, Some(30)).unwrap();

        let stored = set(&conn, task, Some(minutes_before(15))).unwrap().unwrap();
        assert_eq!(stored.snoozed_until, None);
        assert_eq!(stored.fired_at, None);
        assert_eq!(due_ids(&conn), vec![task]);
    }

    #[test]
    fn lists_reminders_on_open_tasks_only() {
        let conn = init_memory_db().unwrap();
        let first = task_due_in(&conn, "Finish report", 30);
        let second = task_due_in(&conn, "Study JavaScript", 90);
        let done = task_due_in(&conn, "Check emails", 45);

        set(&conn, first, Some(minutes_before(10))).unwrap();
        set(&conn, second, Some(minutes_before(10))).unwrap();
        set(&conn, done, Some(minutes_before(10))).unwrap();
        conn.execute(
            "UPDATE tasks SET status = 'completed' WHERE id = ?1",
            params![done],
        )
        .unwrap();

        let listed = list(&conn).unwrap();
        assert_eq!(
            listed.iter().map(|entry| entry.task_id).collect::<Vec<_>>(),
            vec![first, second]
        );
        assert_eq!(listed[0].task_title, "Finish report");
    }

    #[test]
    fn refuses_to_snooze_or_dismiss_what_has_no_reminder() {
        let conn = init_memory_db().unwrap();
        let task = task_due_in(&conn, "No reminder here", 30);

        assert!(snooze(&conn, task, None).is_err());
        assert!(dismiss(&conn, task).is_err());

        set(&conn, task, Some(minutes_before(10))).unwrap();
        assert!(snooze(&conn, task, Some(0)).is_err());
        assert!(snooze(&conn, task, Some(MAX_MINUTES_BEFORE + 1)).is_err());
        assert!(snooze(&conn, task, None).is_ok());
    }

    /// Section 24's Snooze, end to end: the reminder comes back later, by the
    /// length that was asked for, and nothing about the task moves.
    #[test]
    fn snoozing_reschedules_the_reminder_and_leaves_the_task_alone() {
        let conn = init_memory_db().unwrap();
        let task = task_due_in(&conn, "Finish project documentation", 5);
        set(&conn, task, Some(minutes_before(10))).unwrap();
        mark_fired(&conn, task).unwrap();

        let before = task_snapshot(&conn, task);

        // No length given, so the default the notification offers.
        snooze(&conn, task, None).unwrap();
        let ahead = snooze_minutes_ahead(&conn, task);
        assert!(
            (DEFAULT_SNOOZE_MINUTES - 1..=DEFAULT_SNOOZE_MINUTES).contains(&ahead),
            "a default snooze should land about {DEFAULT_SNOOZE_MINUTES} minutes out, not {ahead}"
        );

        // An explicit one replaces it rather than stacking on it.
        snooze(&conn, task, Some(25)).unwrap();
        let ahead = snooze_minutes_ahead(&conn, task);
        assert!((24..=25).contains(&ahead), "a 25-minute snooze landed {ahead} out");

        // The rule it was configured with is the rule it comes back as.
        let reminder = get(&conn, task).unwrap().unwrap();
        assert_eq!(reminder.kind, ReminderKind::MinutesBefore);
        assert_eq!(reminder.minutes_before, Some(10));

        // And the task itself is exactly as it was — a snooze is a decision
        // about the notification, not about the work.
        assert_eq!(task_snapshot(&conn, task), before);
    }

    /// Section 24's Dismiss: the reminder goes quiet, and everything else —
    /// the reminder's configuration and the whole task — stays.
    #[test]
    fn dismissing_silences_the_reminder_without_deleting_anything() {
        let conn = init_memory_db().unwrap();
        let task = task_due_in(&conn, "Finish project documentation", 5);
        set(&conn, task, Some(minutes_before(10))).unwrap();

        assert_eq!(due_ids(&conn), vec![task], "the reminder should be owed first");
        let before = task_snapshot(&conn, task);

        dismiss(&conn, task).unwrap();

        // Quiet.
        assert!(due_ids(&conn).is_empty());

        // Still configured: dismissing one delivery is not removing the
        // reminder, which is what `set(.., None)` is for.
        let reminder = get(&conn, task).unwrap().unwrap();
        assert_eq!(reminder.kind, ReminderKind::MinutesBefore);
        assert_eq!(reminder.minutes_before, Some(10));
        assert_eq!(reminder.snoozed_until, None);
        assert!(reminder.fired_at.is_some());

        // And the task is untouched: not completed, not cancelled, not gone.
        assert_eq!(task_snapshot(&conn, task), before);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM tasks WHERE id = ?1", params![task], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    /// Dismissing a *snoozed* reminder drops the snooze too, so the thing the
    /// user silenced does not come back in ten minutes anyway.
    #[test]
    fn dismissing_a_snoozed_reminder_cancels_the_snooze() {
        let conn = init_memory_db().unwrap();
        // A 30-minute lead on a task due in five puts the reminder's own
        // moment 25 minutes back — comfortably inside the grace window, and
        // far enough back that winding the clock forward below cannot walk
        // past it and arm the reminder for a second time.
        let task = task_due_in(&conn, "Finish report", 5);
        set(&conn, task, Some(minutes_before(30))).unwrap();
        snooze(&conn, task, Some(5)).unwrap();

        dismiss(&conn, task).unwrap();

        assert_eq!(get(&conn, task).unwrap().unwrap().snoozed_until, None);

        // Standing in for the five minutes the snooze had left: had it
        // survived the dismissal it would be a minute overdue by now, and
        // `due` would hand it back. Nothing is owed.
        conn.execute(
            "UPDATE tasks SET reminder_fired_at = datetime('now', '-6 minutes') WHERE id = ?1",
            params![task],
        )
        .unwrap();
        assert!(due_ids(&conn).is_empty());
    }
}
