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
use super::serde_util::double_option;
use super::task_recurrence::{self, NewRecurrence};
use super::validate::{
    normalize_text, optional_integer, optional_text, validate_optional_date,
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

/// Picks out the one task per recurrence rule that stands for the series: its
/// most recent instance. That is both the row the Recurring view should list
/// — the live one, usually today's — and the template the next day is cloned
/// from (see [`ensure_recurring_instances`]), which is what makes editing a
/// repeating task carry forward instead of only fixing a single day.
const LATEST_IN_SERIES_PREDICATE: &str = "recurrence_id IS NOT NULL AND id = \
     (SELECT MAX(latest.id) FROM tasks AS latest \
       WHERE latest.recurrence_id = tasks.recurrence_id)";

/// Every column of `tasks` plus the computed `days_overdue`, in the order
/// `Task::from_row` reads them. Built from [`overdue_predicate`] so the
/// derived flag cannot drift from the views that use the same rule.
fn task_columns() -> String {
    format!(
        "id, title, description, status, priority, category_id, due_date, \
         due_time, estimated_minutes, routine_id, recurrence_id, created_at, updated_at, \
         completed_at, \
         CASE WHEN {} \
              THEN CAST(julianday(date('now', 'localtime')) - julianday(due_date) AS INTEGER) \
              ELSE 0 END AS days_overdue",
        overdue_predicate()
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

    fn parse(value: &str) -> Option<Self> {
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

/// A task as stored, returned to the frontend verbatim, plus the two derived
/// `is_overdue`/`days_overdue` fields.
///
/// Those two are computed by the query against the user's local today rather
/// than stored, so every read is current and no caller has to do date
/// arithmetic to find out a task is late. They are a snapshot taken when the
/// row was read: a list held on screen across midnight needs re-fetching for
/// them to stay accurate.
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
    /// Reserved for the Routine stage; always null for now.
    pub routine_id: Option<i64>,
    /// Reserved for the Recurrence stage; always null for now.
    pub recurrence_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    /// Derived: the due date has passed and the task is still open.
    pub is_overdue: bool,
    /// Derived: how many days past its due date the task is, or 0 when it is
    /// not overdue. 1 means "was due yesterday".
    pub days_overdue: i64,
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
        })
    }
}

/// Fields accepted when creating a task. Everything except `title` is
/// optional so quick-add (section 16) can post just a title.
///
/// `routine_id` is intentionally absent: the column exists, but nothing can
/// populate it until the Routine feature lands. `recurrence_id` is not
/// settable either — pass `recurrence` instead and the rule is created and
/// linked here, so the UI can never point a task at a rule that is not
/// really there.
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
            due_date, due_time, estimated_minutes, recurrence_id, completed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                title,
                description,
                status,
                priority,
                new_task.category_id,
                due_date,
                due_time,
                estimated_minutes,
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

    if let Some(statuses) = filter.statuses.filter(|statuses| !statuses.is_empty()) {
        let placeholders = vec!["?"; statuses.len()].join(", ");
        clauses.push(format!("status IN ({placeholders})"));
        values.extend(
            statuses
                .into_iter()
                .map(|status| Value::Text(status.as_str().to_owned())),
        );
    }

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

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

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

    for rule in task_recurrence::list(conn)? {
        if !task_recurrence::occurs_on(conn, &rule, &today)? {
            continue;
        }

        let already_scheduled: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM tasks WHERE recurrence_id = ?1 AND due_date = ?2)",
            params![rule.id, today],
            |row| row.get(0),
        )?;
        if already_scheduled {
            continue;
        }

        // A rule with no tasks left (the user deleted the whole series) has
        // nothing to copy, so it simply stops producing.
        let inserted = conn.execute(
            "INSERT INTO tasks (
                title, description, status, priority, category_id,
                due_date, due_time, estimated_minutes, routine_id, recurrence_id
             )
             SELECT title, description, 'todo', priority, category_id,
                    ?2, due_time, estimated_minutes, routine_id, recurrence_id
               FROM tasks
              WHERE recurrence_id = ?1
              ORDER BY id DESC
              LIMIT 1",
            params![rule.id, today],
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

/// Field labels for the shared date/time validators, so a rejection names the
/// input the user actually filled in.
const DUE_DATE: &str = "Due date";
const DUE_TIME: &str = "Due time";

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
}
