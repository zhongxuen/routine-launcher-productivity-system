//! Task persistence and the business rules around it.
//!
//! Owns every SQL statement that touches the `tasks` table (see
//! development-plan.md section 58 for the schema and sections 8-17 for the
//! behaviour). Commands in `src-tauri/src/commands/tasks.rs` stay thin and
//! only forward to the functions here.
//!
//! Dates are stored as `YYYY-MM-DD` and times as 24-hour `HH:MM`, both as
//! TEXT, which is what SQLite's date functions expect. `created_at`,
//! `updated_at` and `completed_at` are UTC `YYYY-MM-DD HH:MM:SS` strings
//! produced by SQLite's `datetime('now')`, while the Today/Upcoming views
//! compare against `date('now', 'localtime')` — "today" means the user's
//! today, not UTC's.

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, Value, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row, ToSql};
use serde::{Deserialize, Serialize};

use super::error::{ServiceError, ServiceResult};
use super::reminders::{self, TaskReminder};
use super::routines;
use super::serde_util::double_option;
use super::task_recurrence::{self, NewRecurrence};
use super::xp;
use super::validate::{
    normalize_text, optional_integer, optional_text, validate_date, validate_optional_date,
    validate_optional_time,
};

/// A past instance of a repeating series that a later one has taken over
/// from. You do not owe Monday's "check email" once Tuesday's has arrived —
/// the series moved on, so the old row stops nagging instead of stacking up a
/// row per missed day.
///
/// Non-recurring tasks are untouched: `tasks.recurrence_id` is NULL for them,
/// and comparing anything to NULL never matches, so nothing is superseded.
const SUPERSEDED_PREDICATE: &str = "EXISTS (SELECT 1 FROM tasks AS newer \
      WHERE newer.recurrence_id = tasks.recurrence_id \
        AND newer.due_date > tasks.due_date)";

/// What counts as overdue: a due date in the past on a task nobody has
/// finished or cancelled, and which no later instance has replaced.
/// Completed and cancelled tasks are never overdue no matter how late they
/// were, so a task that was simply cancelled does not keep nagging.
///
/// `due_date < ...` is false when `due_date` is NULL, so an Inbox task is
/// never overdue either.
///
/// Shared by the `days_overdue` column and the Today/Overdue views, so the
/// flag a task carries and the view it appears in can never disagree.
fn overdue_predicate() -> String {
    format!(
        "due_date < date('now', 'localtime') AND status IN ('todo', 'in_progress') \
         AND NOT {SUPERSEDED_PREDICATE}"
    )
}

/// The work still owed by the end of `bound` (a SQL expression yielding a
/// `YYYY-MM-DD` date): open, due by then, and not replaced by a later
/// instance of its series.
///
/// The same idea as [`overdue_predicate`] with the day it is asked about left
/// open, which is what the statistics of development-plan.md section 36 need:
/// the denominator of "Tasks: 6 / 8" is the work that was on the plate for
/// the window, and a window can end today or on Sunday. Both spellings share
/// [`SUPERSEDED_PREDICATE`], so a superseded Monday instance is left out of
/// the Today view and out of the week's total by the same rule rather than by
/// two rules that happen to agree.
///
/// Assumes the outer query reads the table as `tasks` — the superseded check
/// is a correlated subquery against that name.
pub(super) fn owed_by_predicate(bound: &str) -> String {
    format!(
        "due_date <= {bound} AND status IN ('todo', 'in_progress') \
         AND NOT {SUPERSEDED_PREDICATE}"
    )
}

/// Picks out the one task per recurrence rule that stands for the series: its
/// most recent instance. That is both the row the Recurring view should list
/// — the live one, usually today's — and the template the next day is cloned
/// from (see [`ensure_recurring_instances`]), which is what makes editing a
/// repeating task carry forward instead of only fixing a single day.
pub(super) const LATEST_IN_SERIES_PREDICATE: &str = "recurrence_id IS NOT NULL AND id = \
     (SELECT MAX(latest.id) FROM tasks AS latest \
       WHERE latest.recurrence_id = tasks.recurrence_id)";

/// The focus time a task has actually had (development-plan.md section 17's
/// "Actual focus time", section 19's "Focus: 43 minutes"), summed from the
/// `focus_sessions` rows that name it.
///
/// Only *ended* sessions count. A session still on the clock has no
/// `duration_seconds` yet, and section 88 would rather a task's figure be a
/// session behind than count minutes nobody has finished focusing.
///
/// Derived on every read rather than stored on the task, for the same reason
/// `days_overdue` is: there is then only one place the number can come from,
/// so it cannot drift from the sessions it is made of. Deleting a task's
/// session, or ending one, changes what the next read answers with nothing to
/// keep in step. Deleting the *task* clears `focus_sessions.task_id`
/// (`ON DELETE SET NULL`), so the focused time survives in the record even
/// though the task it was against does not.
pub(super) const FOCUS_SECONDS_COLUMN: &str = "COALESCE((SELECT SUM(f.duration_seconds) \
           FROM focus_sessions AS f \
          WHERE f.task_id = tasks.id AND f.ended_at IS NOT NULL), 0) AS focus_seconds";

/// Every column of `tasks` plus the computed `days_overdue` and
/// `focus_seconds`, in the order `Task::from_row` reads them. Built from
/// [`overdue_predicate`] so the derived flag cannot drift from the views that
/// use the same rule.
fn task_columns() -> String {
    format!(
        "id, title, description, status, priority, category_id, due_date, \
         due_time, estimated_minutes, routine_id, recurrence_id, created_at, updated_at, \
         completed_at, \
         CASE WHEN {} \
              THEN CAST(julianday(date('now', 'localtime')) - julianday(due_date) AS INTEGER) \
              ELSE 0 END AS days_overdue, \
         {FOCUS_SECONDS_COLUMN}, \
         {}",
        overdue_predicate(),
        reminders::TASK_COLUMNS
    )
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/// The four statuses from development-plan.md section 11. Deliberately not a
/// project-management workflow — nothing else is accepted by the database's
/// CHECK constraint either.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    InProgress,
    Completed,
    Cancelled,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "todo" => Some(Self::Todo),
            "in_progress" => Some(Self::InProgress),
            "completed" => Some(Self::Completed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

/// The four priority levels from development-plan.md section 12.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskPriority {
    Low,
    Normal,
    High,
    Urgent,
}

impl TaskPriority {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Normal => "normal",
            Self::High => "high",
            Self::Urgent => "urgent",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "low" => Some(Self::Low),
            "normal" => Some(Self::Normal),
            "high" => Some(Self::High),
            "urgent" => Some(Self::Urgent),
            _ => None,
        }
    }
}

/// The task views from development-plan.md section 15, plus `Overdue`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskView {
    /// No date constraint at all.
    #[default]
    All,
    /// Due on the user's local today, **plus** anything still unfinished from
    /// an earlier day. A task you forgot to do — or forgot to tick off —
    /// should not quietly vanish the moment the date rolls over, so it keeps
    /// being carried into today (sorted to the top, and flagged with
    /// `is_overdue`/`days_overdue`) until it is completed or cancelled.
    ///
    /// The exception is a repeating task: once the series has produced a
    /// later instance, the missed one drops out rather than adding a row per
    /// day the habit was skipped.
    Today,
    /// Due on any date after today.
    Upcoming,
    /// No due date — the unscheduled pile.
    Inbox,
    /// Completed history, newest first.
    Completed,
    /// Only the tasks that are past due and still unfinished — the carried-
    /// over subset of Today, for a count or a badge on its own.
    Overdue,
    /// One row per repeating series (section 23) rather than every instance
    /// it has produced: each rule's most recent task, which is also the one
    /// the next day is cloned from.
    Recurring,
}

/// Stores each enum as the lowercase string the table's CHECK constraint
/// allows, and rejects anything else on the way back out.
macro_rules! sql_enum {
    ($ty:ty, $label:literal) => {
        impl ToSql for $ty {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(ToSqlOutput::from(self.as_str()))
            }
        }

        impl FromSql for $ty {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                let raw = value.as_str()?;
                Self::parse(raw).ok_or_else(|| {
                    FromSqlError::Other(format!("unknown {} {raw:?} in database", $label).into())
                })
            }
        }
    };
}

sql_enum!(TaskStatus, "task status");
sql_enum!(TaskPriority, "task priority");

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// A task as stored, returned to the frontend verbatim, plus the derived
/// `is_overdue`/`days_overdue`/`focus_seconds` fields.
///
/// The first two are computed by the query against the user's local today
/// rather than stored, so every read is current and no caller has to do date
/// arithmetic to find out a task is late. The third is summed from the task's
/// focus sessions on the same terms (section 19's Task -> Focus Session ->
/// Completion chain, read back at the Completion end). All three are a
/// snapshot taken when the row was read: a list held on screen across
/// midnight — or across a focus session ending — needs re-fetching for them to
/// stay accurate.
#[derive(Debug, Clone, Serialize)]
pub struct Task {
    pub id: i64,
    pub title: String,
    pub description: Option<String>,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    pub category_id: Option<i64>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub estimated_minutes: Option<i64>,
    /// The routine this task starts with (section 18), or null. Cleared by
    /// `ON DELETE SET NULL` if the routine is deleted, so a task never points
    /// at a workspace that is no longer there.
    pub routine_id: Option<i64>,
    /// The repeating series this task belongs to, or null for a one-off.
    pub recurrence_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    /// Derived: the due date has passed and the task is still open.
    pub is_overdue: bool,
    /// Derived: how many days past its due date the task is, or 0 when it is
    /// not overdue. 1 means "was due yesterday".
    pub days_overdue: i64,
    /// Derived: seconds of focus recorded against this task (section 17's
    /// "Actual focus time"), summed over the focus sessions that named it.
    ///
    /// `0` means nobody has focused on this task yet — a measured zero, not a
    /// missing figure, which is why it is not an `Option`. Sessions still
    /// running are not counted; see [`FOCUS_SECONDS_COLUMN`].
    pub focus_seconds: i64,
    /// The reminder set on this task (development-plan.md section 24), or
    /// null for a task nobody has asked to be reminded about.
    ///
    /// Read here, but written through `services/reminders.rs`, which owns
    /// these columns and the rules about them — a reminder is not settable
    /// through [`TaskUpdate`], because whether one is *valid* depends on the
    /// due date and time the same edit might be changing. It comes back on
    /// the task so a list can draw a bell on the rows that have one without a
    /// query per row.
    pub reminder: Option<TaskReminder>,
}

impl Task {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let days_overdue: i64 = row.get("days_overdue")?;

        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            description: row.get("description")?,
            status: row.get("status")?,
            priority: row.get("priority")?,
            category_id: row.get("category_id")?,
            due_date: row.get("due_date")?,
            due_time: row.get("due_time")?,
            estimated_minutes: row.get("estimated_minutes")?,
            routine_id: row.get("routine_id")?,
            recurrence_id: row.get("recurrence_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            completed_at: row.get("completed_at")?,
            is_overdue: days_overdue > 0,
            days_overdue,
            focus_seconds: row.get("focus_seconds")?,
            reminder: TaskReminder::from_row(row)?,
        })
    }
}

/// Fields accepted when creating a task. Everything except `title` is
/// optional so quick-add (section 16) can post just a title.
///
/// `recurrence_id` is not settable — pass `recurrence` instead and the rule
/// is created and linked here, so the UI can never point a task at a rule
/// that is not really there. `routine_id`, by contrast, names a routine that
/// already exists, so it is taken as given and checked.
#[derive(Debug, Deserialize)]
pub struct NewTask {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub status: Option<TaskStatus>,
    #[serde(default)]
    pub priority: Option<TaskPriority>,
    #[serde(default)]
    pub category_id: Option<i64>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub due_time: Option<String>,
    #[serde(default)]
    pub estimated_minutes: Option<i64>,
    /// The routine this task starts with (section 18). Checked against the
    /// `routines` table, so a task can only point at one that exists.
    #[serde(default)]
    pub routine_id: Option<i64>,
    /// Makes this a repeating task (section 23). The rule is stored first and
    /// the task's `due_date` is snapped to the schedule's first occurrence, so
    /// "every weekday", created on a Saturday, starts on Monday.
    #[serde(default)]
    pub recurrence: Option<NewRecurrence>,
}

/// A partial update: omitted fields are left alone, and nullable fields can
/// be cleared by passing null (see `double_option`).
#[derive(Debug, Default, Deserialize)]
pub struct TaskUpdate {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub status: Option<TaskStatus>,
    #[serde(default)]
    pub priority: Option<TaskPriority>,
    #[serde(default, deserialize_with = "double_option")]
    pub category_id: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub due_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub due_time: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub estimated_minutes: Option<Option<i64>>,
    /// Three-state: omitted leaves the assignment alone, an id assigns that
    /// routine, and `null` unassigns without touching the routine itself.
    #[serde(default, deserialize_with = "double_option")]
    pub routine_id: Option<Option<i64>>,
    /// Three-state like the rest: omitted leaves the schedule alone, a rule
    /// sets or re-times it, and `null` stops the task repeating. Stopping a
    /// repeat drops the rule, which — via `ON DELETE SET NULL` — turns every
    /// instance already generated into an ordinary task rather than deleting
    /// the work.
    #[serde(default, deserialize_with = "double_option")]
    pub recurrence: Option<Option<NewRecurrence>>,
}

/// Filters for `list`. All fields combine with AND; leaving everything unset
/// returns every task.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct TaskFilter {
    /// Which date-based view to restrict to. Defaults to `All`.
    pub view: Option<TaskView>,
    /// Keep only tasks whose status is in this list. An empty list is
    /// treated as "no status filter".
    pub statuses: Option<Vec<TaskStatus>>,
    /// Keep only tasks with this priority.
    pub priority: Option<TaskPriority>,
    /// `Some(Some(id))` filters to one category, `Some(None)` filters to
    /// uncategorised tasks, `None` does not filter by category at all.
    #[serde(deserialize_with = "double_option")]
    pub category_id: Option<Option<i64>>,
    /// Cap the number of rows returned (useful for dashboard summaries and
    /// completed-task history).
    pub limit: Option<i64>,
}

/// A repeating task that a future day will get but does not have yet: one row
/// of the read-only Repeats group on a dated Today view (development-plan.md
/// section 53's Tomorrow).
///
/// Not a [`Task`], because there is no task yet: [`ensure_recurring_instances`]
/// only makes today's, so tomorrow's is created on the day. The fields are
/// those the instance will be cloned with, read from the series' most recent
/// task, so an edit made today shows up in tomorrow's preview.
#[derive(Debug, Clone, Serialize)]
pub struct RepeatPreview {
    pub recurrence_id: i64,
    pub title: String,
    pub priority: TaskPriority,
    pub category_id: Option<i64>,
    pub due_time: Option<String>,
    pub estimated_minutes: Option<i64>,
    pub routine_id: Option<i64>,
}

impl RepeatPreview {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            recurrence_id: row.get("recurrence_id")?,
            title: row.get("title")?,
            priority: row.get("priority")?,
            category_id: row.get("category_id")?,
            due_time: row.get("due_time")?,
            estimated_minutes: row.get("estimated_minutes")?,
            routine_id: row.get("routine_id")?,
        })
    }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

pub fn create(conn: &Connection, new_task: NewTask) -> ServiceResult<Task> {
    let title = validate_title(&new_task.title)?;
    let description = normalize_text(new_task.description);
    let status = new_task.status.unwrap_or(TaskStatus::Todo);
    let priority = new_task.priority.unwrap_or(TaskPriority::Normal);
    let mut due_date = validate_optional_date(DUE_DATE, new_task.due_date)?;
    let due_time = validate_optional_time(DUE_TIME, new_task.due_time)?;
    let estimated_minutes = validate_optional_minutes(new_task.estimated_minutes)?;
    require_date_for_time(due_date.as_deref(), due_time.as_deref())?;

    // The rule and the task it belongs to have to appear together: a rule
    // with no task would generate nothing, and a task pointing at a rule that
    // failed to store would be a dangling reference.
    let transaction = conn.unchecked_transaction()?;

    let routine_id = validate_routine(&transaction, new_task.routine_id)?;

    let recurrence_id = match new_task.recurrence {
        Some(rule) => {
            let anchor = match &due_date {
                Some(date) => date.clone(),
                None => task_recurrence::local_today(&transaction)?,
            };
            let rule = task_recurrence::create(&transaction, rule, &anchor)?;
            // `create` anchors start_date on the schedule's first real
            // occurrence, so this is where the first instance belongs — even
            // if the user picked a date the schedule skips.
            due_date = Some(rule.start_date.clone());
            Some(rule.id)
        }
        None => None,
    };

    // A task created as already-completed still deserves a completion
    // timestamp — section 17 reports "completed at".
    let completed_at = match status {
        TaskStatus::Completed => Some(db_now(&transaction)?),
        _ => None,
    };

    transaction
        .execute(
            "INSERT INTO tasks (
            title, description, status, priority, category_id,
            due_date, due_time, estimated_minutes, routine_id, recurrence_id,
            completed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                title,
                description,
                status,
                priority,
                new_task.category_id,
                due_date,
                due_time,
                estimated_minutes,
                routine_id,
                recurrence_id,
                completed_at,
            ],
        )
        .map_err(|err| ServiceError::from_constraint(err, MISSING_CATEGORY))?;

    let id = transaction.last_insert_rowid();
    // Re-read so the caller gets the database's own defaults and timestamps
    // rather than a struct we assembled by hand.
    let task = get(&transaction, id)?.ok_or_else(|| task_not_found(id))?;
    transaction.commit()?;

    Ok(task)
}

pub fn get(conn: &Connection, id: i64) -> ServiceResult<Option<Task>> {
    let sql = format!("SELECT {} FROM tasks WHERE id = ?1", task_columns());
    conn.query_row(&sql, params![id], Task::from_row)
        .optional()
        .map_err(ServiceError::from)
}

pub fn update(conn: &Connection, id: i64, update: TaskUpdate) -> ServiceResult<Task> {
    // Editing a schedule touches two tables, and a half-applied edit would
    // leave the series pointing at a rule that no longer describes it.
    let transaction = conn.unchecked_transaction()?;
    let conn: &Connection = &transaction;
    let existing = get(conn, id)?.ok_or_else(|| task_not_found(id))?;

    let mut assignments: Vec<&str> = Vec::new();
    let mut values: Vec<Value> = Vec::new();

    if let Some(title) = update.title {
        assignments.push("title = ?");
        values.push(Value::Text(validate_title(&title)?));
    }

    if let Some(description) = update.description {
        assignments.push("description = ?");
        values.push(optional_text(normalize_text(description)));
    }

    if let Some(priority) = update.priority {
        assignments.push("priority = ?");
        values.push(Value::Text(priority.as_str().to_owned()));
    }

    if let Some(category_id) = update.category_id {
        assignments.push("category_id = ?");
        values.push(optional_integer(category_id));
    }

    // due_date/due_time are validated against the *resulting* task, so
    // clearing the date while leaving a time behind is rejected.
    let mut next_due_date = match &update.due_date {
        Some(value) => validate_optional_date(DUE_DATE, value.clone())?,
        None => existing.due_date.clone(),
    };
    let next_due_time = match &update.due_time {
        Some(value) => validate_optional_time(DUE_TIME, value.clone())?,
        None => existing.due_time.clone(),
    };
    require_date_for_time(next_due_date.as_deref(), next_due_time.as_deref())?;

    // The schedule is settled before the due date is written, because setting
    // one re-dates the task onto the schedule's next occurrence.
    let mut due_date_changed = update.due_date.is_some();

    if let Some(recurrence) = update.recurrence {
        match recurrence {
            // Stop repeating. Dropping the rule clears `recurrence_id` on
            // every instance it produced (ON DELETE SET NULL), leaving them
            // as ordinary tasks.
            None => {
                if let Some(rule_id) = existing.recurrence_id {
                    task_recurrence::delete(conn, rule_id)?;
                }
            }
            Some(new_rule) => {
                let anchor = match &next_due_date {
                    Some(date) => date.clone(),
                    None => task_recurrence::local_today(conn)?,
                };

                let rule = match existing.recurrence_id {
                    Some(rule_id) => task_recurrence::replace(conn, rule_id, new_rule, &anchor)?,
                    None => {
                        let rule = task_recurrence::create(conn, new_rule, &anchor)?;
                        assignments.push("recurrence_id = ?");
                        values.push(Value::Integer(rule.id));
                        rule
                    }
                };

                if next_due_date.as_deref() != Some(rule.start_date.as_str()) {
                    next_due_date = Some(rule.start_date.clone());
                    due_date_changed = true;
                }
            }
        }
    }

    if due_date_changed {
        assignments.push("due_date = ?");
        values.push(optional_text(next_due_date));
    }
    if update.due_time.is_some() {
        assignments.push("due_time = ?");
        values.push(optional_text(next_due_time));
    }

    if let Some(estimated_minutes) = update.estimated_minutes {
        assignments.push("estimated_minutes = ?");
        values.push(optional_integer(validate_optional_minutes(
            estimated_minutes,
        )?));
    }

    if let Some(routine_id) = update.routine_id {
        assignments.push("routine_id = ?");
        values.push(optional_integer(validate_routine(conn, routine_id)?));
    }

    // Set when this save is the moment the task becomes done, so the XP for
    // it is awarded once the row is actually written — see below.
    let mut newly_completed = false;

    if let Some(status) = update.status {
        assignments.push("status = ?");
        values.push(Value::Text(status.as_str().to_owned()));

        // completed_at is derived from the status transition, never set by
        // the caller: entering Completed stamps it, leaving Completed clears
        // it, and re-saving an already-completed task keeps its original
        // completion time.
        match (existing.status, status) {
            (TaskStatus::Completed, TaskStatus::Completed) => {}
            (_, TaskStatus::Completed) => {
                assignments.push("completed_at = ?");
                values.push(Value::Text(db_now(conn)?));
                newly_completed = true;
            }
            (TaskStatus::Completed, _) => {
                assignments.push("completed_at = ?");
                values.push(Value::Null);
            }
            _ => {}
        }
    }

    // Dropping a recurrence rule is a change even when no column on this row
    // is assigned, so the task is always re-read rather than trusting
    // `existing` — the FK may have nulled `recurrence_id` underneath us.
    if !assignments.is_empty() {
        assignments.push("updated_at = datetime('now')");
        values.push(Value::Integer(id));

        let sql = format!("UPDATE tasks SET {} WHERE id = ?", assignments.join(", "));
        conn.execute(&sql, params_from_iter(values))
            .map_err(|err| ServiceError::from_constraint(err, MISSING_CATEGORY))?;
    }

    // Section 43's +10 XP, awarded here because this transition is the one
    // place a task becomes done — the Tasks list, the popup, the tray's
    // "Complete" and Stage 5's focus finish all arrive through this function.
    // Inside the transaction so the grant and the completion land together,
    // and behind `xp::note` so a progression failure can never undo the
    // completion that earned it (section 50).
    //
    // `award_task_completion` is itself once-per-task, which is what makes
    // un-ticking and re-ticking a checkbox worth nothing the second time
    // (section 88).
    if newly_completed {
        xp::note(
            xp::award_task_completion(conn, id),
            &format!("completing task {id}"),
        );
    }

    let task = get(conn, id)?.ok_or_else(|| task_not_found(id))?;
    transaction.commit()?;

    Ok(task)
}

pub fn delete(conn: &Connection, id: i64) -> ServiceResult<()> {
    let deleted = conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
    if deleted == 0 {
        return Err(task_not_found(id));
    }
    Ok(())
}

pub fn list(conn: &Connection, filter: TaskFilter) -> ServiceResult<Vec<Task>> {
    let view = filter.view.unwrap_or_default();

    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();

    match view {
        TaskView::All => {}
        // Today is "due today, or still owed from before" — see TaskView::Today.
        TaskView::Today => clauses.push(format!(
            "(due_date = date('now', 'localtime') OR ({}))",
            overdue_predicate()
        )),
        TaskView::Upcoming => clauses.push("due_date > date('now', 'localtime')".to_owned()),
        TaskView::Inbox => clauses.push("due_date IS NULL".to_owned()),
        TaskView::Completed => clauses.push("status = 'completed'".to_owned()),
        TaskView::Overdue => clauses.push(overdue_predicate()),
        TaskView::Recurring => clauses.push(LATEST_IN_SERIES_PREDICATE.to_owned()),
    }

    push_status_clause(&mut clauses, &mut values, filter.statuses);

    if let Some(priority) = filter.priority {
        clauses.push("priority = ?".to_owned());
        values.push(Value::Text(priority.as_str().to_owned()));
    }

    match filter.category_id {
        Some(Some(category_id)) => {
            clauses.push("category_id = ?".to_owned());
            values.push(Value::Integer(category_id));
        }
        Some(None) => clauses.push("category_id IS NULL".to_owned()),
        None => {}
    }

    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };

    let limit_clause = match filter.limit {
        Some(limit) if limit > 0 => {
            values.push(Value::Integer(limit));
            " LIMIT ?"
        }
        _ => "",
    };

    let sql = format!(
        "SELECT {} FROM tasks{where_clause} ORDER BY {}{limit_clause}",
        task_columns(),
        order_by(view)
    );

    let mut statement = conn.prepare(&sql)?;
    let tasks = statement
        .query_map(params_from_iter(values), Task::from_row)?
        .collect::<rusqlite::Result<Vec<Task>>>()?;

    Ok(tasks)
}

/// One day's tasks: those due on `date` (`YYYY-MM-DD`), in the order the day
/// is worked through. This backs the dated Today view, i.e. section 53's
/// Yesterday and Tomorrow.
///
/// Unlike [`TaskView::Today`] it carries nothing over from earlier days. On
/// Tuesday's page the question is "what was due on Tuesday", not "what do I
/// still owe", and a task left open from Monday already appears on today's
/// page.
///
/// It is a separate function rather than a date field on [`TaskFilter`]: the
/// Today view's carry-over applies to today only, and a date field would
/// combine with it, and with every other view, in ways no screen asks for.
/// `statuses` narrows the list the same way `TaskFilter::statuses` does.
pub fn list_for_date(
    conn: &Connection,
    date: &str,
    statuses: Option<Vec<TaskStatus>>,
) -> ServiceResult<Vec<Task>> {
    let date = validate_date(DATE, date)?;

    let mut clauses = vec!["due_date = ?".to_owned()];
    let mut values = vec![Value::Text(date)];
    push_status_clause(&mut clauses, &mut values, statuses);

    let sql = format!(
        "SELECT {} FROM tasks WHERE {} ORDER BY {}",
        task_columns(),
        clauses.join(" AND "),
        order_by(TaskView::Today)
    );

    let mut statement = conn.prepare(&sql)?;
    let tasks = statement
        .query_map(params_from_iter(values), Task::from_row)?
        .collect::<rusqlite::Result<Vec<Task>>>()?;

    Ok(tasks)
}

/// Adds `status IN (...)` for a non-empty status list. A missing or empty list
/// adds nothing, which is how "no status filter" is spelled on the wire.
fn push_status_clause(
    clauses: &mut Vec<String>,
    values: &mut Vec<Value>,
    statuses: Option<Vec<TaskStatus>>,
) {
    let Some(statuses) = statuses.filter(|statuses| !statuses.is_empty()) else {
        return;
    };

    let placeholders = vec!["?"; statuses.len()].join(", ");
    clauses.push(format!("status IN ({placeholders})"));
    values.extend(
        statuses
            .into_iter()
            .map(|status| Value::Text(status.as_str().to_owned())),
    );
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

/// The repeating series that owe a task on `date` and do not have one yet.
///
/// [`ensure_recurring_instances`] fills these in for today, and
/// [`list_repeats_for_date`] previews them for a day still to come. Both use
/// this function, so the preview cannot show a task the generator would not
/// create, or miss one it would.
///
/// A rule whose series has no tasks left (the user deleted all of them) is
/// still returned here. Both callers read the series' latest task next, and
/// both do nothing when there isn't one.
fn series_owed_on(conn: &Connection, date: &str) -> ServiceResult<Vec<i64>> {
    let mut owed = Vec::new();

    for rule in task_recurrence::list(conn)? {
        if !task_recurrence::occurs_on(conn, &rule, date)? {
            continue;
        }

        let already_scheduled: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE recurrence_id = ?1 AND due_date = ?2)",
            params![rule.id, date],
            |row| row.get(0),
        )?;
        if !already_scheduled {
            owed.push(rule.id);
        }
    }

    Ok(owed)
}

/// The repeating tasks `date` will get that do not exist yet, for the
/// read-only Repeats group (development-plan.md section 53's Tomorrow).
///
/// Reads only. Section 23's generator makes today's instance and nothing
/// further ahead (see [`ensure_recurring_instances`]), and that stays true:
/// this answers "what will be there" without writing anything.
///
/// Empty for today and every earlier day. Today's instances are created
/// before any view is read, and past days are never back-filled, so only a
/// future day can have repeats that are due but not yet created.
pub fn list_repeats_for_date(conn: &Connection, date: &str) -> ServiceResult<Vec<RepeatPreview>> {
    let date = validate_date(DATE, date)?;
    if date <= task_recurrence::local_today(conn)? {
        return Ok(Vec::new());
    }

    let owed = series_owed_on(conn, &date)?;
    if owed.is_empty() {
        return Ok(Vec::new());
    }

    // The latest task in each series is the row the day's instance will be
    // cloned from, by the same `MAX(id)` rule the generator uses.
    let placeholders = vec!["?"; owed.len()].join(", ");
    let sql = format!(
        "SELECT recurrence_id, title, priority, category_id, due_time, estimated_minutes, \
                routine_id \
           FROM tasks \
          WHERE {LATEST_IN_SERIES_PREDICATE} AND recurrence_id IN ({placeholders}) \
          ORDER BY CASE WHEN due_time IS NULL THEN 1 ELSE 0 END, \
                   due_time, \
                   CASE priority \
                      WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, \
                   id"
    );

    let mut statement = conn.prepare(&sql)?;
    let previews = statement
        .query_map(params_from_iter(owed), RepeatPreview::from_row)?
        .collect::<rusqlite::Result<Vec<RepeatPreview>>>()?;

    Ok(previews)
}

/// Makes sure every repeating series has today's task in it, and returns the
/// ones it had to create — section 23's "the system automatically
/// creates/activates the appropriate task for the day".
///
/// Called on load rather than on a timer, which is what makes it safe to run
/// repeatedly: a series that already has a task dated today is left alone, so
/// opening the app five times in a day produces one task, not five.
///
/// Only *today* is materialised. Generating a backlog for days the app was
/// closed would bury the Today view under work nobody can do any more, and
/// generating the future would fill Upcoming with rows the user would have to
/// maintain by hand.
///
/// Each new instance is cloned from the series' most recent task, so it
/// carries the same title, description, priority, category, due time and
/// estimate — and picks up any edit made since — while starting fresh as
/// `todo`.
pub fn ensure_recurring_instances(conn: &Connection) -> ServiceResult<Vec<Task>> {
    let today = task_recurrence::local_today(conn)?;
    let transaction = conn.unchecked_transaction()?;
    let conn: &Connection = &transaction;

    let mut created = Vec::new();

    for rule_id in series_owed_on(conn, &today)? {
        // A rule with no tasks left (the user deleted the whole series) has
        // nothing to copy, so it simply stops producing.
        // The reminder's *configuration* is copied and its delivery state is
        // not: a repeating task that reminds you ten minutes before should go
        // on doing that every day, and today's instance has plainly not been
        // reminded about yet. Leaving `reminder_snoozed_until` and
        // `reminder_fired_at` unset is what makes yesterday's snooze — or
        // yesterday's Dismiss — end with yesterday.
        let inserted = conn.execute(
            "INSERT INTO tasks (
                title, description, status, priority, category_id,
                due_date, due_time, estimated_minutes, routine_id, recurrence_id,
                reminder_kind, reminder_minutes_before, reminder_time
             )
             SELECT title, description, 'todo', priority, category_id,
                    ?2, due_time, estimated_minutes, routine_id, recurrence_id,
                    reminder_kind, reminder_minutes_before, reminder_time
               FROM tasks
              WHERE recurrence_id = ?1
              ORDER BY id DESC
              LIMIT 1",
            params![rule_id, today],
        )?;

        if inserted == 0 {
            continue;
        }

        let id = conn.last_insert_rowid();
        created.push(get(conn, id)?.ok_or_else(|| task_not_found(id))?);
    }

    transaction.commit()?;
    Ok(created)
}

/// Completed history reads newest-first; every other view reads in the order
/// the day should be worked through — soonest due date, then time of day,
/// then priority, with undated tasks last (section 14).
///
/// Sorting by due date ascending is also what floats overdue tasks to the top
/// of the Today view: their dates are older, so the longest-overdue task
/// leads the list rather than being buried among today's.
fn order_by(view: TaskView) -> &'static str {
    match view {
        TaskView::Completed => "completed_at DESC, id DESC",
        _ => {
            "CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, \
             due_date, \
             CASE WHEN due_time IS NULL THEN 1 ELSE 0 END, \
             due_time, \
             CASE priority \
                WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, \
             created_at, \
             id"
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MISSING_CATEGORY: &str = "That task category no longer exists.";
const MISSING_ROUTINE: &str = "That routine no longer exists.";

/// Field labels for the shared date/time validators, so a rejection names the
/// input the user actually filled in.
const DUE_DATE: &str = "Due date";
const DUE_TIME: &str = "Due time";
/// The day a dated view is asking about, not a field on the task.
const DATE: &str = "Date";

fn task_not_found(id: i64) -> ServiceError {
    ServiceError::not_found(format!("Task {id} was not found."))
}

/// Reads the current UTC timestamp from SQLite rather than the system clock,
/// so values written by Rust match the `datetime('now')` column defaults.
fn db_now(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row("SELECT datetime('now')", [], |row| row.get(0))
}

fn validate_title(title: &str) -> ServiceResult<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(ServiceError::validation("A task needs a title."));
    }
    Ok(title.to_owned())
}

fn validate_optional_minutes(value: Option<i64>) -> ServiceResult<Option<i64>> {
    match value {
        Some(minutes) if minutes < 1 => Err(ServiceError::validation(
            "Estimated duration must be at least 1 minute.",
        )),
        other => Ok(other),
    }
}

/// Refuses a `routine_id` naming a routine that is not there.
///
/// Checked here rather than left to the foreign key, because the `tasks`
/// insert carries two of them — `category_id` and `routine_id` — and a
/// constraint failure cannot say which one broke. Section 18 is about
/// pointing a task at a workspace, so the message names the workspace.
fn validate_routine(conn: &Connection, routine_id: Option<i64>) -> ServiceResult<Option<i64>> {
    match routine_id {
        Some(id) if routines::get(conn, id)?.is_none() => {
            Err(ServiceError::validation(MISSING_ROUTINE))
        }
        other => Ok(other),
    }
}

/// A due time on its own cannot be scheduled or sorted, so it is rejected
/// rather than silently dropped.
fn require_date_for_time(due_date: Option<&str>, due_time: Option<&str>) -> ServiceResult<()> {
    if due_time.is_some() && due_date.is_none() {
        return Err(ServiceError::validation(
            "A task with a due time also needs a due date.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;
    use crate::services::focus;
    use crate::services::task_recurrence::RecurrenceFrequency;
    use serde_json::json;

    /// Builds a `NewTask` the way the frontend would — from JSON — so these
    /// tests also cover the serde contract the `invoke` boundary relies on.
    fn new_task(value: serde_json::Value) -> NewTask {
        serde_json::from_value(value).expect("valid NewTask payload")
    }

    fn task_update(value: serde_json::Value) -> TaskUpdate {
        serde_json::from_value(value).expect("valid TaskUpdate payload")
    }

    fn task_filter(value: serde_json::Value) -> TaskFilter {
        serde_json::from_value(value).expect("valid TaskFilter payload")
    }

    fn local_today(conn: &Connection) -> String {
        conn.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))
            .unwrap()
    }

    /// The local date `days` days before today, as `YYYY-MM-DD`. A negative
    /// `days` looks forward instead, so `days_ago(conn, -1)` is tomorrow.
    fn days_ago(conn: &Connection, days: i64) -> String {
        conn.query_row(
            "SELECT date('now', 'localtime', ?1)",
            params![format!("{:+} days", -days)],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn titles(tasks: &[Task]) -> Vec<&str> {
        tasks.iter().map(|task| task.title.as_str()).collect()
    }

    /// A bare routine to point a task at (section 18). The actions are the
    /// launcher's business; all a task needs is an id that resolves.
    fn a_routine(conn: &Connection, name: &str) -> i64 {
        routines::create(
            conn,
            serde_json::from_value(json!({ "name": name })).expect("valid NewRoutine payload"),
        )
        .unwrap()
        .id
    }

    #[test]
    fn assigns_a_routine_to_a_task() {
        let conn = init_memory_db().unwrap();
        let routine_id = a_routine(&conn, "Coding Mode");

        let task = create(
            &conn,
            new_task(json!({ "title": "Finish React project", "routine_id": routine_id })),
        )
        .unwrap();

        assert_eq!(task.routine_id, Some(routine_id));
        assert_eq!(get(&conn, task.id).unwrap().unwrap().routine_id, Some(routine_id));
    }

    #[test]
    fn assigns_and_unassigns_a_routine_on_update() {
        let conn = init_memory_db().unwrap();
        let routine_id = a_routine(&conn, "Study Mode");
        let task = create(&conn, new_task(json!({ "title": "Study JavaScript" }))).unwrap();

        let assigned = update(&conn, task.id, task_update(json!({ "routine_id": routine_id })))
            .unwrap();
        assert_eq!(assigned.routine_id, Some(routine_id));

        // Omitting the field leaves the assignment alone...
        let renamed = update(&conn, task.id, task_update(json!({ "title": "Study JS" }))).unwrap();
        assert_eq!(renamed.routine_id, Some(routine_id));

        // ...and null clears it without touching the routine.
        let cleared = update(&conn, task.id, task_update(json!({ "routine_id": null }))).unwrap();
        assert_eq!(cleared.routine_id, None);
        assert!(routines::get(&conn, routine_id).unwrap().is_some());
    }

    #[test]
    fn refuses_a_routine_that_does_not_exist() {
        let conn = init_memory_db().unwrap();

        let created = create(
            &conn,
            new_task(json!({ "title": "Finish React project", "routine_id": 999 })),
        );
        assert!(matches!(created, Err(ServiceError::Validation(message)) if message == MISSING_ROUTINE));

        let task = create(&conn, new_task(json!({ "title": "Finish React project" }))).unwrap();
        let updated = update(&conn, task.id, task_update(json!({ "routine_id": 999 })));
        assert!(matches!(updated, Err(ServiceError::Validation(message)) if message == MISSING_ROUTINE));
    }

    #[test]
    fn deleting_a_routine_leaves_its_tasks_behind() {
        let conn = init_memory_db().unwrap();
        let routine_id = a_routine(&conn, "Work Mode");
        let task = create(
            &conn,
            new_task(json!({ "title": "Clear the inbox", "routine_id": routine_id })),
        )
        .unwrap();

        routines::delete(&conn, routine_id).unwrap();

        // ON DELETE SET NULL: the task survives, it just has no workspace.
        let task = get(&conn, task.id).unwrap().unwrap();
        assert_eq!(task.title, "Clear the inbox");
        assert_eq!(task.routine_id, None);
    }

    #[test]
    fn a_repeating_task_carries_its_routine_into_tomorrows_instance() {
        let conn = init_memory_db().unwrap();
        let routine_id = a_routine(&conn, "Morning Mode");

        let task = create(
            &conn,
            new_task(json!({
                "title": "Daily standup",
                "routine_id": routine_id,
                "recurrence": { "frequency": "daily" },
            })),
        )
        .unwrap();
        assert_eq!(task.routine_id, Some(routine_id));

        // Backdate today's instance so the series owes one for today.
        conn.execute(
            "UPDATE tasks SET due_date = date('now', 'localtime', '-1 day') WHERE id = ?1",
            params![task.id],
        )
        .unwrap();

        let created = ensure_recurring_instances(&conn).unwrap();
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].routine_id, Some(routine_id));
    }

    #[test]
    fn creates_a_task_from_a_title_alone() {
        let conn = init_memory_db().unwrap();
        let task = create(&conn, new_task(json!({ "title": "  Check emails  " }))).unwrap();

        assert_eq!(task.title, "Check emails");
        assert_eq!(task.status, TaskStatus::Todo);
        assert_eq!(task.priority, TaskPriority::Normal);
        assert_eq!(task.due_date, None);
        assert_eq!(task.completed_at, None);
        assert_eq!(task.routine_id, None);
        assert_eq!(task.recurrence_id, None);
    }

    #[test]
    fn stores_every_section_58_field() {
        let conn = init_memory_db().unwrap();
        let task = create(
            &conn,
            new_task(json!({
                "title": "Finish database documentation",
                "description": "Cover the migration runner too",
                "status": "in_progress",
                "priority": "high",
                "category_id": 1,
                "due_date": "2026-08-28",
                "due_time": "17:00",
                "estimated_minutes": 45,
            })),
        )
        .unwrap();

        assert_eq!(
            task.description.as_deref(),
            Some("Cover the migration runner too")
        );
        assert_eq!(task.status, TaskStatus::InProgress);
        assert_eq!(task.priority, TaskPriority::High);
        assert_eq!(task.category_id, Some(1));
        assert_eq!(task.due_date.as_deref(), Some("2026-08-28"));
        assert_eq!(task.due_time.as_deref(), Some("17:00"));
        assert_eq!(task.estimated_minutes, Some(45));
        assert_eq!(get(&conn, task.id).unwrap().unwrap().id, task.id);
    }

    #[test]
    fn rejects_invalid_input() {
        let conn = init_memory_db().unwrap();

        let cases = vec![
            json!({ "title": "   " }),
            json!({ "title": "Bad date", "due_date": "28/08/2026" }),
            json!({ "title": "Bad month", "due_date": "2026-13-01" }),
            json!({ "title": "Bad time", "due_date": "2026-08-28", "due_time": "25:00" }),
            json!({ "title": "Time without a date", "due_time": "09:00" }),
            json!({ "title": "Zero estimate", "estimated_minutes": 0 }),
            json!({ "title": "Missing category", "category_id": 9999 }),
        ];

        for case in cases {
            let result = create(&conn, new_task(case.clone()));
            assert!(
                matches!(result, Err(ServiceError::Validation(_))),
                "expected {case} to be rejected, got {result:?}"
            );
        }
    }

    #[test]
    fn update_leaves_omitted_fields_alone_and_clears_explicit_nulls() {
        let conn = init_memory_db().unwrap();
        let task = create(
            &conn,
            new_task(json!({
                "title": "Study JavaScript",
                "description": "Chapter 4",
                "due_date": "2026-09-01",
                "due_time": "09:30",
                "estimated_minutes": 60,
                "category_id": 2,
            })),
        )
        .unwrap();

        // Omitted keys change nothing.
        let untouched =
            update(&conn, task.id, task_update(json!({ "priority": "high" }))).unwrap();
        assert_eq!(untouched.priority, TaskPriority::High);
        assert_eq!(untouched.description.as_deref(), Some("Chapter 4"));
        assert_eq!(untouched.due_date.as_deref(), Some("2026-09-01"));
        assert_eq!(untouched.category_id, Some(2));

        // Explicit nulls clear the column.
        let cleared = update(
            &conn,
            task.id,
            task_update(json!({
                "description": null,
                "due_time": null,
                "due_date": null,
                "estimated_minutes": null,
                "category_id": null,
            })),
        )
        .unwrap();

        assert_eq!(cleared.description, None);
        assert_eq!(cleared.due_date, None);
        assert_eq!(cleared.due_time, None);
        assert_eq!(cleared.estimated_minutes, None);
        assert_eq!(cleared.category_id, None);
        assert_eq!(
            cleared.priority,
            TaskPriority::High,
            "unrelated fields survive"
        );
    }

    #[test]
    fn update_rejects_a_due_time_left_stranded_without_its_date() {
        let conn = init_memory_db().unwrap();
        let task = create(
            &conn,
            new_task(
                json!({ "title": "Standup", "due_date": "2026-09-01", "due_time": "09:30" }),
            ),
        )
        .unwrap();

        let result = update(&conn, task.id, task_update(json!({ "due_date": null })));
        assert!(matches!(result, Err(ServiceError::Validation(_))));

        // The rejected update must not have partially applied.
        let unchanged = get(&conn, task.id).unwrap().unwrap();
        assert_eq!(unchanged.due_date.as_deref(), Some("2026-09-01"));
    }

    #[test]
    fn completed_at_follows_the_status_transition() {
        let conn = init_memory_db().unwrap();
        let task = create(&conn, new_task(json!({ "title": "Finish report" }))).unwrap();
        assert_eq!(task.completed_at, None);

        let completed =
            update(&conn, task.id, task_update(json!({ "status": "completed" }))).unwrap();
        let stamped_at = completed
            .completed_at
            .clone()
            .expect("completing stamps completed_at");

        // Re-saving an already-completed task keeps the original timestamp.
        let resaved = update(
            &conn,
            task.id,
            task_update(json!({ "status": "completed", "priority": "low" })),
        )
        .unwrap();
        assert_eq!(resaved.completed_at, Some(stamped_at));

        // Reopening clears it again.
        let reopened = update(&conn, task.id, task_update(json!({ "status": "todo" }))).unwrap();
        assert_eq!(reopened.completed_at, None);
    }

    #[test]
    fn deletes_a_task_and_reports_a_missing_one() {
        let conn = init_memory_db().unwrap();
        let task = create(&conn, new_task(json!({ "title": "Organise Downloads" }))).unwrap();

        delete(&conn, task.id).unwrap();
        assert_eq!(get(&conn, task.id).unwrap().map(|t| t.id), None);
        assert!(matches!(
            delete(&conn, task.id),
            Err(ServiceError::NotFound(_))
        ));
        assert!(matches!(
            update(&conn, task.id, TaskUpdate::default()),
            Err(ServiceError::NotFound(_))
        ));
    }

    #[test]
    fn views_split_tasks_by_date_and_completion() {
        let conn = init_memory_db().unwrap();
        let today = local_today(&conn);

        create(&conn, new_task(json!({ "title": "Due today", "due_date": today }))).unwrap();
        create(
            &conn,
            new_task(json!({ "title": "Due later", "due_date": "2099-01-01" })),
        )
        .unwrap();
        create(&conn, new_task(json!({ "title": "Someday" }))).unwrap();
        let done = create(&conn, new_task(json!({ "title": "Already done" }))).unwrap();
        update(&conn, done.id, task_update(json!({ "status": "completed" }))).unwrap();

        let view = |name: &str| list(&conn, task_filter(json!({ "view": name }))).unwrap();

        assert_eq!(titles(&view("today")), vec!["Due today"]);
        assert_eq!(titles(&view("upcoming")), vec!["Due later"]);
        assert_eq!(titles(&view("inbox")), vec!["Someday", "Already done"]);
        assert_eq!(titles(&view("completed")), vec!["Already done"]);
        assert_eq!(view("all").len(), 4);
        assert_eq!(list(&conn, TaskFilter::default()).unwrap().len(), 4);
    }

    #[test]
    fn filters_by_status_priority_and_category() {
        let conn = init_memory_db().unwrap();

        create(
            &conn,
            new_task(json!({ "title": "Urgent work", "priority": "urgent", "category_id": 1 })),
        )
        .unwrap();
        create(
            &conn,
            new_task(
                json!({ "title": "Cancelled study", "status": "cancelled", "category_id": 2 }),
            ),
        )
        .unwrap();
        create(&conn, new_task(json!({ "title": "Uncategorised" }))).unwrap();

        let filtered = |filter: serde_json::Value| list(&conn, task_filter(filter)).unwrap();

        assert_eq!(
            titles(&filtered(json!({ "priority": "urgent" }))),
            vec!["Urgent work"]
        );
        assert_eq!(
            titles(&filtered(json!({ "statuses": ["cancelled"] }))),
            vec!["Cancelled study"]
        );
        assert_eq!(filtered(json!({ "statuses": ["todo", "cancelled"] })).len(), 3);
        assert_eq!(
            titles(&filtered(json!({ "category_id": 2 }))),
            vec!["Cancelled study"]
        );
        assert_eq!(
            titles(&filtered(json!({ "category_id": null }))),
            vec!["Uncategorised"]
        );
        assert_eq!(
            filtered(json!({ "statuses": [] })).len(),
            3,
            "an empty status list is not a filter"
        );
        assert_eq!(filtered(json!({ "limit": 2 })).len(), 2);
    }

    #[test]
    fn orders_the_day_by_time_then_priority() {
        let conn = init_memory_db().unwrap();
        let today = local_today(&conn);

        for task in [
            json!({ "title": "Low, no time", "priority": "low", "due_date": today }),
            json!({ "title": "Urgent, no time", "priority": "urgent", "due_date": today }),
            json!({ "title": "Low, 09:00", "priority": "low", "due_date": today, "due_time": "09:00" }),
        ] {
            create(&conn, new_task(task)).unwrap();
        }

        assert_eq!(
            titles(&list(&conn, task_filter(json!({ "view": "today" }))).unwrap()),
            vec!["Low, 09:00", "Urgent, no time", "Low, no time"]
        );
    }

    #[test]
    fn undated_tasks_sort_after_dated_ones() {
        let conn = init_memory_db().unwrap();

        create(&conn, new_task(json!({ "title": "Someday" }))).unwrap();
        create(
            &conn,
            new_task(json!({ "title": "Dated", "due_date": "2099-01-01" })),
        )
        .unwrap();

        assert_eq!(
            titles(&list(&conn, TaskFilter::default()).unwrap()),
            vec!["Dated", "Someday"]
        );
    }

    #[test]
    fn today_carries_over_unfinished_tasks_from_earlier_days() {
        let conn = init_memory_db().unwrap();
        let today = local_today(&conn);
        let yesterday = days_ago(&conn, 1);
        let last_week = days_ago(&conn, 7);

        create(&conn, new_task(json!({ "title": "Due today", "due_date": today }))).unwrap();
        create(
            &conn,
            new_task(json!({ "title": "Forgot yesterday", "due_date": yesterday })),
        )
        .unwrap();
        create(
            &conn,
            new_task(json!({
                "title": "Started last week",
                "due_date": last_week,
                "status": "in_progress",
            })),
        )
        .unwrap();
        create(
            &conn,
            new_task(json!({ "title": "Due tomorrow", "due_date": days_ago(&conn, -1) })),
        )
        .unwrap();

        // Longest-overdue first, then the rest of today.
        assert_eq!(
            titles(&list(&conn, task_filter(json!({ "view": "today" }))).unwrap()),
            vec!["Started last week", "Forgot yesterday", "Due today"]
        );
    }

    #[test]
    fn overdue_tasks_report_how_late_they_are() {
        let conn = init_memory_db().unwrap();
        let task = create(
            &conn,
            new_task(json!({ "title": "Forgot to do it", "due_date": days_ago(&conn, 3) })),
        )
        .unwrap();

        assert!(task.is_overdue);
        assert_eq!(task.days_overdue, 3);

        // The flag is derived on every read, not just at creation.
        let refetched = get(&conn, task.id).unwrap().unwrap();
        assert!(refetched.is_overdue);
        assert_eq!(refetched.days_overdue, 3);
    }

    #[test]
    fn tasks_due_today_or_later_are_never_overdue() {
        let conn = init_memory_db().unwrap();

        for payload in [
            json!({ "title": "Due today", "due_date": local_today(&conn) }),
            json!({ "title": "Due tomorrow", "due_date": days_ago(&conn, -1) }),
            json!({ "title": "No due date" }),
        ] {
            let task = create(&conn, new_task(payload)).unwrap();
            assert!(!task.is_overdue, "{} should not be overdue", task.title);
            assert_eq!(task.days_overdue, 0);
        }
    }

    #[test]
    fn finishing_or_cancelling_a_late_task_stops_it_being_overdue() {
        let conn = init_memory_db().unwrap();
        let late = json!({ "due_date": days_ago(&conn, 2) });

        let mut done = late.clone();
        done["title"] = json!("Did it late");
        let done = create(&conn, new_task(done)).unwrap();
        assert!(done.is_overdue);

        let mut abandoned = late.clone();
        abandoned["title"] = json!("Never doing it");
        let abandoned = create(&conn, new_task(abandoned)).unwrap();

        let done = update(&conn, done.id, task_update(json!({ "status": "completed" }))).unwrap();
        let abandoned = update(
            &conn,
            abandoned.id,
            task_update(json!({ "status": "cancelled" })),
        )
        .unwrap();

        assert!(!done.is_overdue, "a completed task is done, not overdue");
        assert_eq!(done.days_overdue, 0);
        assert!(!abandoned.is_overdue, "a cancelled task should stop nagging");
        assert_eq!(abandoned.days_overdue, 0);

        // ...and neither is still being carried into today.
        assert!(list(&conn, task_filter(json!({ "view": "today" })))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_overdue_view_returns_only_the_carried_over_subset() {
        let conn = init_memory_db().unwrap();

        create(
            &conn,
            new_task(json!({ "title": "Due today", "due_date": local_today(&conn) })),
        )
        .unwrap();
        create(
            &conn,
            new_task(json!({ "title": "Two days late", "due_date": days_ago(&conn, 2) })),
        )
        .unwrap();
        create(
            &conn,
            new_task(json!({ "title": "A week late", "due_date": days_ago(&conn, 7) })),
        )
        .unwrap();

        let overdue = list(&conn, task_filter(json!({ "view": "overdue" }))).unwrap();

        assert_eq!(titles(&overdue), vec!["A week late", "Two days late"]);
        assert!(overdue.iter().all(|task| task.is_overdue));
    }

    #[test]
    fn overdue_tasks_stay_out_of_the_other_views() {
        let conn = init_memory_db().unwrap();
        create(
            &conn,
            new_task(json!({ "title": "Late", "due_date": days_ago(&conn, 1) })),
        )
        .unwrap();

        // Upcoming is the future and Inbox is the undated pile; an overdue
        // task belongs to neither, only to Today and Overdue.
        assert!(list(&conn, task_filter(json!({ "view": "upcoming" })))
            .unwrap()
            .is_empty());
        assert!(list(&conn, task_filter(json!({ "view": "inbox" })))
            .unwrap()
            .is_empty());
        assert!(list(&conn, task_filter(json!({ "view": "completed" })))
            .unwrap()
            .is_empty());
    }

    // -----------------------------------------------------------------------
    // Recurrence (section 23)
    // -----------------------------------------------------------------------

    #[test]
    fn a_recurring_task_starts_on_the_first_date_its_schedule_fires() {
        let conn = init_memory_db().unwrap();

        // "Check email, every weekday", set up on a Saturday: the first one is
        // owed on Monday, not on the weekend the user happened to add it.
        let task = create(
            &conn,
            new_task(json!({
                "title": "Check email",
                "due_date": "2026-09-05",
                "recurrence": { "frequency": "weekdays" },
            })),
        )
        .unwrap();

        assert_eq!(task.due_date.as_deref(), Some("2026-09-07"));

        let rule = task_recurrence::get(&conn, task.recurrence_id.unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(rule.frequency, RecurrenceFrequency::Weekdays);
        assert_eq!(rule.start_date, "2026-09-07");
    }

    #[test]
    fn each_day_gets_one_instance_carrying_the_series_forward() {
        let conn = init_memory_db().unwrap();
        let today = local_today(&conn);

        let series = create(
            &conn,
            new_task(json!({
                "title": "Check email",
                "description": "Inbox zero",
                "priority": "high",
                "due_time": "09:00",
                "estimated_minutes": 15,
                "category_id": 1,
                "due_date": days_ago(&conn, 3),
                "recurrence": { "frequency": "daily", "start_date": days_ago(&conn, 3) },
            })),
        )
        .unwrap();

        let created = ensure_recurring_instances(&conn).unwrap();
        assert_eq!(titles(&created), vec!["Check email"]);

        let instance = &created[0];
        assert_eq!(instance.due_date.as_deref(), Some(today.as_str()));
        assert_eq!(instance.recurrence_id, series.recurrence_id);
        assert_eq!(instance.description.as_deref(), Some("Inbox zero"));
        assert_eq!(instance.priority, TaskPriority::High);
        assert_eq!(instance.due_time.as_deref(), Some("09:00"));
        assert_eq!(instance.estimated_minutes, Some(15));
        assert_eq!(instance.category_id, Some(1));
        assert_eq!(instance.status, TaskStatus::Todo);

        // Opening the app again the same day must not add a second one, even
        // after today's has been ticked off.
        assert!(ensure_recurring_instances(&conn).unwrap().is_empty());
        update(&conn, instance.id, task_update(json!({ "status": "completed" }))).unwrap();
        assert!(ensure_recurring_instances(&conn).unwrap().is_empty());
    }

    #[test]
    fn no_instance_is_created_on_a_day_the_schedule_skips() {
        let conn = init_memory_db().unwrap();

        // A weekly repeat on tomorrow's weekday, anchored today, so nothing is
        // owed until next week.
        let tomorrow_weekday: String = conn
            .query_row(
                "SELECT strftime('%w', date('now', 'localtime', '+1 day'))",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let token = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]
            [tomorrow_weekday.parse::<usize>().unwrap()];

        create(
            &conn,
            new_task(json!({
                "title": "Weekly review",
                "recurrence": { "frequency": "weekly", "days_of_week": [token] },
            })),
        )
        .unwrap();

        assert!(ensure_recurring_instances(&conn).unwrap().is_empty());
    }

    #[test]
    fn the_recurring_view_lists_one_row_per_series() {
        let conn = init_memory_db().unwrap();

        create(
            &conn,
            new_task(json!({
                "title": "Check email",
                "due_date": days_ago(&conn, 2),
                "recurrence": { "frequency": "daily", "start_date": days_ago(&conn, 2) },
            })),
        )
        .unwrap();
        create(&conn, new_task(json!({ "title": "One-off" }))).unwrap();

        ensure_recurring_instances(&conn).unwrap();
        assert_eq!(list(&conn, TaskFilter::default()).unwrap().len(), 3);

        // Three tasks exist, but only one repeating *thing* to show.
        assert_eq!(
            titles(&list(&conn, task_filter(json!({ "view": "recurring" }))).unwrap()),
            vec!["Check email"]
        );
    }

    #[test]
    fn an_edit_to_the_series_carries_into_the_next_day() {
        let conn = init_memory_db().unwrap();
        let first = create(
            &conn,
            new_task(json!({
                "title": "Check email",
                "due_date": days_ago(&conn, 2),
                "recurrence": { "frequency": "daily", "start_date": days_ago(&conn, 2) },
            })),
        )
        .unwrap();

        update(
            &conn,
            first.id,
            task_update(json!({ "title": "Check email and reply", "priority": "high" })),
        )
        .unwrap();

        let today = ensure_recurring_instances(&conn).unwrap();
        assert_eq!(titles(&today), vec!["Check email and reply"]);
        assert_eq!(today[0].priority, TaskPriority::High);

        // The Recurring view shows that live row, not the original.
        let listed = list(&conn, task_filter(json!({ "view": "recurring" }))).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, today[0].id);
    }

    #[test]
    fn editing_a_schedule_re_times_the_series_without_detaching_it() {
        let conn = init_memory_db().unwrap();
        let task = create(
            &conn,
            new_task(json!({
                "title": "Backup project",
                "due_date": "2026-08-31",
                "recurrence": { "frequency": "daily", "start_date": "2026-08-31" },
            })),
        )
        .unwrap();

        // 2026-08-31 is a Monday, so the first Sunday after it is 2026-09-06.
        let retimed = update(
            &conn,
            task.id,
            task_update(
                json!({ "recurrence": { "frequency": "weekly", "days_of_week": ["SUN"] } }),
            ),
        )
        .unwrap();

        assert_eq!(retimed.recurrence_id, task.recurrence_id);
        assert_eq!(retimed.due_date.as_deref(), Some("2026-09-06"));
        assert_eq!(task_recurrence::list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn stopping_a_repeat_keeps_the_tasks_it_already_produced() {
        let conn = init_memory_db().unwrap();
        let series = create(
            &conn,
            new_task(json!({
                "title": "Check email",
                "due_date": days_ago(&conn, 1),
                "recurrence": { "frequency": "daily", "start_date": days_ago(&conn, 1) },
            })),
        )
        .unwrap();
        ensure_recurring_instances(&conn).unwrap();

        let stopped =
            update(&conn, series.id, task_update(json!({ "recurrence": null }))).unwrap();

        assert_eq!(stopped.recurrence_id, None);
        assert!(task_recurrence::list(&conn).unwrap().is_empty());
        // Yesterday's and today's tasks survive as ordinary tasks.
        assert_eq!(list(&conn, TaskFilter::default()).unwrap().len(), 2);
        assert!(list(&conn, task_filter(json!({ "view": "recurring" })))
            .unwrap()
            .is_empty());
        // ...and nothing regenerates them.
        assert!(ensure_recurring_instances(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_missed_instance_stops_nagging_once_the_next_one_arrives() {
        let conn = init_memory_db().unwrap();

        create(
            &conn,
            new_task(json!({
                "title": "Check email",
                "due_date": days_ago(&conn, 5),
                "recurrence": { "frequency": "daily", "start_date": days_ago(&conn, 5) },
            })),
        )
        .unwrap();
        create(
            &conn,
            new_task(json!({ "title": "One-off I forgot", "due_date": days_ago(&conn, 5) })),
        )
        .unwrap();

        ensure_recurring_instances(&conn).unwrap();

        // Today owes today's email check and the forgotten one-off — not five
        // days of skipped email checks.
        assert_eq!(
            titles(&list(&conn, task_filter(json!({ "view": "today" }))).unwrap()),
            vec!["One-off I forgot", "Check email"]
        );

        // The superseded instance still exists; it just is not overdue.
        let superseded = list(&conn, task_filter(json!({ "view": "all" })))
            .unwrap()
            .into_iter()
            .find(|task| task.title == "Check email" && task.due_date != Some(local_today(&conn)))
            .expect("the original instance is kept");
        assert!(!superseded.is_overdue);
        assert_eq!(superseded.days_overdue, 0);

        // A one-off is never superseded, however late it gets.
        assert_eq!(
            titles(&list(&conn, task_filter(json!({ "view": "overdue" }))).unwrap()),
            vec!["One-off I forgot"]
        );
    }

    #[test]
    fn a_rejected_schedule_leaves_no_half_written_task_behind() {
        let conn = init_memory_db().unwrap();

        let result = create(
            &conn,
            new_task(json!({
                "title": "Impossible",
                "recurrence": { "frequency": "monthly", "day_of_month": 99 },
            })),
        );

        assert!(matches!(result, Err(ServiceError::Validation(_))));
        assert!(list(&conn, TaskFilter::default()).unwrap().is_empty());
        assert!(task_recurrence::list(&conn).unwrap().is_empty());
    }

    /// The weekday token (`"MON"`) of the local date `days` days from today.
    fn weekday_in(conn: &Connection, days: i64) -> &'static str {
        let weekday: i64 = conn
            .query_row(
                "SELECT CAST(strftime('%w', date('now', 'localtime', ?1)) AS INTEGER)",
                params![format!("{days:+} days")],
                |row| row.get(0),
            )
            .unwrap();
        ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][weekday as usize]
    }

    fn task_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn a_dated_day_lists_what_was_due_on_it_and_carries_nothing_over() {
        let conn = init_memory_db().unwrap();
        let yesterday = days_ago(&conn, 1);

        create(&conn, new_task(json!({ "title": "Left open", "due_date": yesterday }))).unwrap();
        let done = create(&conn, new_task(json!({ "title": "Ticked off", "due_date": yesterday })))
            .unwrap();
        update(&conn, done.id, task_update(json!({ "status": "completed" }))).unwrap();
        let dropped = create(&conn, new_task(json!({ "title": "Dropped", "due_date": yesterday })))
            .unwrap();
        update(&conn, dropped.id, task_update(json!({ "status": "cancelled" }))).unwrap();
        // Still owed from earlier: Today carries it, yesterday's page does not.
        create(
            &conn,
            new_task(json!({ "title": "Older", "due_date": days_ago(&conn, 3) })),
        )
        .unwrap();
        create(
            &conn,
            new_task(json!({ "title": "Today's", "due_date": local_today(&conn) })),
        )
        .unwrap();

        let all = list_for_date(&conn, &yesterday, None).unwrap();
        assert_eq!(titles(&all), vec!["Left open", "Ticked off", "Dropped"]);

        let shown = list_for_date(
            &conn,
            &yesterday,
            Some(vec![TaskStatus::Todo, TaskStatus::InProgress, TaskStatus::Completed]),
        )
        .unwrap();
        assert_eq!(titles(&shown), vec!["Left open", "Ticked off"]);
        // The open one is still late, the same as it is on Today's page.
        assert!(shown[0].is_overdue);
        assert_eq!(shown[0].days_overdue, 1);

        // Today's own view is untouched by any of this.
        let today = list(&conn, task_filter(json!({ "view": "today" }))).unwrap();
        assert_eq!(titles(&today), vec!["Older", "Left open", "Today's"]);

        assert!(matches!(
            list_for_date(&conn, "16/09/2026", None),
            Err(ServiceError::Validation(_))
        ));
    }

    #[test]
    fn tomorrow_previews_its_repeats_without_creating_them() {
        let conn = init_memory_db().unwrap();
        let start = days_ago(&conn, 3);

        create(
            &conn,
            new_task(json!({
                "title": "Check email",
                "priority": "high",
                "due_time": "09:00",
                "estimated_minutes": 15,
                "due_date": start,
                "recurrence": { "frequency": "daily", "start_date": start },
            })),
        )
        .unwrap();
        let today_instance = ensure_recurring_instances(&conn).unwrap().remove(0);
        // Tomorrow is cloned from the latest instance, so an edit made today
        // has to show up in the preview.
        update(
            &conn,
            today_instance.id,
            task_update(json!({ "title": "Check email and chat" })),
        )
        .unwrap();
        let before = task_count(&conn);

        let tomorrow = days_ago(&conn, -1);
        let previews = list_repeats_for_date(&conn, &tomorrow).unwrap();
        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].title, "Check email and chat");
        assert_eq!(Some(previews[0].recurrence_id), today_instance.recurrence_id);
        assert_eq!(previews[0].priority, TaskPriority::High);
        assert_eq!(previews[0].due_time.as_deref(), Some("09:00"));
        assert_eq!(previews[0].estimated_minutes, Some(15));

        // Previewing wrote nothing: tomorrow still has no real task.
        assert_eq!(task_count(&conn), before);
        assert!(list_for_date(&conn, &tomorrow, None).unwrap().is_empty());

        // Today's instance already exists and past days are never back-filled,
        // so neither has anything to preview.
        assert!(list_repeats_for_date(&conn, &local_today(&conn)).unwrap().is_empty());
        assert!(list_repeats_for_date(&conn, &days_ago(&conn, 1)).unwrap().is_empty());
    }

    #[test]
    fn a_repeat_preview_follows_the_schedule() {
        let conn = init_memory_db().unwrap();

        // Weekly on today's weekday: the series starts today, skips tomorrow,
        // and comes back a week from now.
        create(
            &conn,
            new_task(json!({
                "title": "Weekly review",
                "recurrence": { "frequency": "weekly", "days_of_week": [weekday_in(&conn, 0)] },
            })),
        )
        .unwrap();

        assert!(list_repeats_for_date(&conn, &days_ago(&conn, -1)).unwrap().is_empty());

        let next_week = list_repeats_for_date(&conn, &days_ago(&conn, -7)).unwrap();
        let titles: Vec<&str> = next_week.iter().map(|preview| preview.title.as_str()).collect();
        assert_eq!(titles, vec!["Weekly review"]);
    }

    #[test]
    fn a_series_already_dated_on_the_day_is_listed_rather_than_previewed() {
        let conn = init_memory_db().unwrap();

        // Weekly on tomorrow's weekday, so the series' first task is already
        // a real task dated tomorrow.
        create(
            &conn,
            new_task(json!({
                "title": "Weekly review",
                "recurrence": { "frequency": "weekly", "days_of_week": [weekday_in(&conn, 1)] },
            })),
        )
        .unwrap();

        let tomorrow = days_ago(&conn, -1);
        assert_eq!(
            titles(&list_for_date(&conn, &tomorrow, None).unwrap()),
            vec!["Weekly review"]
        );
        assert!(list_repeats_for_date(&conn, &tomorrow).unwrap().is_empty());
    }

    /// Records a finished focus session against a task, the way the timer
    /// does: start it, backdate it so there is wall-clock time to measure
    /// against, then end it with the seconds the frontend counted.
    ///
    /// The backdating is what makes the duration stick — `focus::end` clamps
    /// a measured figure down to the time the session was really open for, so
    /// a session started and ended in the same instant records nothing.
    fn focused_on(conn: &Connection, task_id: i64, seconds: i64, completed: bool) {
        let session = focus::start(
            conn,
            serde_json::from_value(json!({ "task_id": task_id, "preset": "custom",
                                           "planned_seconds": seconds }))
                .expect("valid NewFocusSession payload"),
        )
        .unwrap();

        conn.execute(
            "UPDATE focus_sessions SET started_at = datetime('now', ?2) WHERE id = ?1",
            params![session.id, format!("-{seconds} seconds")],
        )
        .unwrap();

        focus::end(
            conn,
            session.id,
            serde_json::from_value(json!({ "completed": completed,
                                           "duration_seconds": seconds }))
                .expect("valid FocusSessionOutcome payload"),
        )
        .unwrap();
    }

    #[test]
    fn totals_the_focus_time_recorded_against_a_task() {
        let conn = init_memory_db().unwrap();
        let task = create(&conn, new_task(json!({ "title": "Study JavaScript" }))).unwrap();

        // Nothing focused on yet is a measured zero, not a missing figure.
        assert_eq!(task.focus_seconds, 0);

        // Section 19's example: a 45-minute estimate that took 43 minutes...
        focused_on(&conn, task.id, 43 * 60, true);
        assert_eq!(get(&conn, task.id).unwrap().unwrap().focus_seconds, 43 * 60);

        // ...and a second sitting adds to it rather than replacing it —
        // including an interrupted one, which is still focus that happened.
        focused_on(&conn, task.id, 12 * 60, false);
        let listed = list(&conn, task_filter(json!({ "view": "all" }))).unwrap();
        assert_eq!(listed[0].focus_seconds, 55 * 60);
    }

    #[test]
    fn a_running_session_is_not_counted_until_it_ends() {
        let conn = init_memory_db().unwrap();
        let task = create(&conn, new_task(json!({ "title": "Finish project report" }))).unwrap();

        let session = focus::start(
            &conn,
            serde_json::from_value(json!({ "task_id": task.id, "preset": "50-10" })).unwrap(),
        )
        .unwrap();

        // The clock is running, so the minutes are not focused *yet*.
        assert_eq!(get(&conn, task.id).unwrap().unwrap().focus_seconds, 0);

        conn.execute(
            "UPDATE focus_sessions SET started_at = datetime('now', '-3000 seconds') WHERE id = ?1",
            params![session.id],
        )
        .unwrap();
        focus::end(
            &conn,
            session.id,
            serde_json::from_value(json!({ "completed": true, "duration_seconds": 3000 })).unwrap(),
        )
        .unwrap();

        assert_eq!(get(&conn, task.id).unwrap().unwrap().focus_seconds, 3000);
    }

    #[test]
    fn one_task_s_focus_time_is_not_another_s() {
        let conn = init_memory_db().unwrap();
        let mine = create(&conn, new_task(json!({ "title": "Mine" }))).unwrap();
        let yours = create(&conn, new_task(json!({ "title": "Yours" }))).unwrap();

        focused_on(&conn, mine.id, 25 * 60, true);

        // An unattached session (section 34's "launched independently") is
        // nobody's task time either.
        let loose = focus::start(&conn, serde_json::from_value(json!({ "preset": "25-5" })).unwrap())
            .unwrap();
        conn.execute(
            "UPDATE focus_sessions SET started_at = datetime('now', '-1500 seconds') WHERE id = ?1",
            params![loose.id],
        )
        .unwrap();
        focus::end(
            &conn,
            loose.id,
            serde_json::from_value(json!({ "completed": true })).unwrap(),
        )
        .unwrap();

        assert_eq!(get(&conn, mine.id).unwrap().unwrap().focus_seconds, 25 * 60);
        assert_eq!(get(&conn, yours.id).unwrap().unwrap().focus_seconds, 0);
    }
}
