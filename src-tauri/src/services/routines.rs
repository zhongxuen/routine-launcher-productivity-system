//! Routine and routine-action persistence.
//!
//! Owns every SQL statement touching `routines` and `routine_actions` (see
//! development-plan.md sections 59-60 for the schemas and 29-33 for the
//! behaviour). Actually *doing* what an action says — launching an app,
//! opening a URL — lives next door in [`super::routine_exec`]; this module
//! stops at "here is the ordered, validated list of things to do".
//!
//! Two rules shape the API:
//!
//! * **Order is a first-class property.** Section 31 requires reorderable
//!   actions, so `sort_order` is renumbered to a dense `0..n-1` after every
//!   write and every read is `ORDER BY sort_order, id`. The frontend can
//!   therefore treat position in the returned list as the truth.
//! * **Targets are validated on the way in.** A timer's target must be a
//!   number of minutes, a URL's must have a safe scheme, a command must pass
//!   the section 66 guardrails. Storing only well-formed targets keeps the
//!   executor free of parsing failures it can do nothing about.

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, Value, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row, ToSql};
use serde::{Deserialize, Serialize};

use super::error::{ServiceError, ServiceResult};
use super::installed_apps;
use super::serde_util::double_option;
use super::settings;
use super::validate::{normalize_text, optional_text};
use super::xp;

/// Settings key for the section 66 opt-in that gates `command` actions.
/// Absent means disabled — see [`command_actions_enabled`].
pub const COMMAND_ACTIONS_ENABLED_KEY: &str = "routines.command_actions_enabled";

const ROUTINE_COLUMNS: &str = "id, name, description, icon, created_at, updated_at, \
     last_launched_at, launch_count";

const ACTION_COLUMNS: &str = "id, routine_id, type, target, arguments, sort_order, enabled";

/// Longest timer an action may request. A routine that starts a focus block
/// longer than a day is a typo, not an intention.
const MAX_TIMER_MINUTES: i64 = 24 * 60;

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

/// The action types from development-plan.md section 30. The database's CHECK
/// constraint accepts exactly these six strings and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutineActionType {
    /// Launch an executable, a shortcut, or a registered application name.
    Application,
    /// Open a web address in the default browser.
    Url,
    /// Open a directory in the file explorer.
    Folder,
    /// Open a file with whatever handler the OS has registered for it.
    File,
    /// Request a focus timer of N minutes. Purely a signal — see
    /// [`super::routine_exec`].
    Timer,
    /// Run an arbitrary shell command. Off unless the user turns it on; see
    /// [`command_actions_enabled`] and development-plan.md section 66.
    Command,
}

impl RoutineActionType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Application => "application",
            Self::Url => "url",
            Self::Folder => "folder",
            Self::File => "file",
            Self::Timer => "timer",
            Self::Command => "command",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "application" => Some(Self::Application),
            "url" => Some(Self::Url),
            "folder" => Some(Self::Folder),
            "file" => Some(Self::File),
            "timer" => Some(Self::Timer),
            "command" => Some(Self::Command),
            _ => None,
        }
    }
}

impl ToSql for RoutineActionType {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.as_str()))
    }
}

impl FromSql for RoutineActionType {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let raw = value.as_str()?;
        Self::parse(raw).ok_or_else(|| {
            FromSqlError::Other(format!("unknown routine action type {raw:?} in database").into())
        })
    }
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One step of a routine, exactly as stored (section 60).
#[derive(Debug, Clone, Serialize)]
pub struct RoutineAction {
    pub id: i64,
    pub routine_id: i64,
    #[serde(rename = "type")]
    pub action_type: RoutineActionType,
    /// What to act on: an executable path, a URL, a directory, a file, or —
    /// for `timer` — the number of minutes as a string.
    pub target: String,
    /// Extra command-line arguments for `application`, unused by the other
    /// types. Split into argv by `routine_exec::parse_arguments`.
    pub arguments: Option<String>,
    pub sort_order: i64,
    /// Disabled actions stay in the routine and are reported as `skipped`
    /// when it runs, so the user can park a step without deleting it.
    pub enabled: bool,
    /// Short human name for this step, derived from the target.
    ///
    /// Not sent to the frontend: `src/lib/routine-utils.ts` derives a better
    /// one (it knows `Code.exe` is "VS Code"), and two competing labels on
    /// one action would only raise the question of which to render. This copy
    /// exists so a run's summary sentence — "GitHub could not be opened" —
    /// can be built where the failure is detected.
    #[serde(skip_serializing)]
    pub label: String,
}

impl RoutineAction {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let action_type: RoutineActionType = row.get("type")?;
        let target: String = row.get("target")?;
        Ok(Self {
            id: row.get("id")?,
            routine_id: row.get("routine_id")?,
            action_type,
            label: derive_label(action_type, &target),
            target,
            arguments: row.get("arguments")?,
            sort_order: row.get("sort_order")?,
            enabled: row.get("enabled")?,
        })
    }
}

/// A routine with its ordered action list attached (section 59).
#[derive(Debug, Clone, Serialize)]
pub struct Routine {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// UTC `YYYY-MM-DD HH:MM:SS`, or null if the routine has never run.
    pub last_launched_at: Option<String>,
    pub launch_count: i64,
    /// Always sorted by `sort_order`, so list position *is* run order.
    pub actions: Vec<RoutineAction>,
}

impl Routine {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            description: row.get("description")?,
            icon: row.get("icon")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            last_launched_at: row.get("last_launched_at")?,
            launch_count: row.get("launch_count")?,
            actions: Vec::new(),
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewRoutineAction {
    #[serde(rename = "type")]
    pub action_type: RoutineActionType,
    pub target: String,
    #[serde(default)]
    pub arguments: Option<String>,
    /// Only honoured by [`add_action`]. When an action arrives as part of an
    /// ordered list, its position in the list wins.
    #[serde(default)]
    pub sort_order: Option<i64>,
    /// Defaults to enabled.
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewRoutine {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    /// Stored in the order given; `sort_order` is assigned from the position.
    #[serde(default)]
    pub actions: Vec<NewRoutineAction>,
}

/// A partial routine update: omitted fields are left alone, and
/// `description`/`icon` can be cleared by passing null.
#[derive(Debug, Default, Deserialize)]
pub struct RoutineUpdate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub icon: Option<Option<String>>,
    /// When present, replaces the whole action list in one shot — what the
    /// section 31 builder's Save button wants. Omit it to leave the existing
    /// actions untouched and edit them individually instead.
    #[serde(default)]
    pub actions: Option<Vec<NewRoutineAction>>,
}

/// A partial action update. `type` and `target` are re-validated together, so
/// switching a step from `url` to `timer` requires a target the new type
/// accepts.
#[derive(Debug, Default, Deserialize)]
pub struct RoutineActionUpdate {
    #[serde(default, rename = "type")]
    pub action_type: Option<RoutineActionType>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub arguments: Option<Option<String>>,
    #[serde(default)]
    pub sort_order: Option<i64>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

// ---------------------------------------------------------------------------
// Routine CRUD
// ---------------------------------------------------------------------------

/// Every routine, most-recently-launched first so the workspaces the user
/// actually uses stay at the top of the section 29 list. Routines that have
/// never run sort after those that have, newest first.
pub fn list(conn: &Connection) -> ServiceResult<Vec<Routine>> {
    let sql = format!(
        "SELECT {ROUTINE_COLUMNS} FROM routines \
         ORDER BY last_launched_at IS NULL, last_launched_at DESC, id DESC"
    );
    let mut statement = conn.prepare(&sql)?;
    let mut routines = statement
        .query_map([], Routine::from_row)?
        .collect::<rusqlite::Result<Vec<Routine>>>()?;

    // One query for every action rather than one per routine, then hand each
    // routine its own slice.
    let action_sql =
        format!("SELECT {ACTION_COLUMNS} FROM routine_actions ORDER BY routine_id, sort_order, id");
    let mut action_statement = conn.prepare(&action_sql)?;
    let actions = action_statement
        .query_map([], RoutineAction::from_row)?
        .collect::<rusqlite::Result<Vec<RoutineAction>>>()?;

    for action in actions {
        if let Some(routine) = routines
            .iter_mut()
            .find(|routine| routine.id == action.routine_id)
        {
            routine.actions.push(action);
        }
    }

    Ok(routines)
}

/// Just enough of a routine to put it on a menu: what it is called and which
/// glyph it wears. Returned by [`top_by_use`].
#[derive(Debug, Clone, Serialize)]
pub struct RoutineSummary {
    pub id: i64,
    pub name: String,
    pub icon: Option<String>,
}

/// The routines a shortcut surface should offer, most-used first.
///
/// Launch count is the ranking, ties break on the most recently launched and
/// then on name — the same rule `quickStartRoutines` applies in the frontend
/// (`src/components/dashboard/QuickStart.tsx`), so section 27's tray menu, the
/// dashboard's QUICK START row and the popup's launch button can never
/// disagree about which workspace is the obvious one. A user who has launched
/// nothing yet still gets a list, ordered by name, rather than an empty menu
/// that only fills in once they have used the feature somewhere else.
///
/// Ordered and limited in SQL rather than by reading [`list`] and slicing it,
/// because the caller wants the top few and nothing about their actions — a
/// menu item is a name and an icon.
pub fn top_by_use(conn: &Connection, limit: usize) -> ServiceResult<Vec<RoutineSummary>> {
    let mut statement = conn.prepare(
        "SELECT id, name, icon FROM routines \
         ORDER BY launch_count DESC, \
                  last_launched_at IS NULL, last_launched_at DESC, \
                  name COLLATE NOCASE \
         LIMIT ?1",
    )?;

    let routines = statement
        .query_map(params![limit as i64], |row| {
            Ok(RoutineSummary {
                id: row.get("id")?,
                name: row.get("name")?,
                icon: row.get("icon")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<RoutineSummary>>>()?;

    Ok(routines)
}

pub fn get(conn: &Connection, id: i64) -> ServiceResult<Option<Routine>> {
    let sql = format!("SELECT {ROUTINE_COLUMNS} FROM routines WHERE id = ?1");
    let routine = conn
        .query_row(&sql, params![id], Routine::from_row)
        .optional()?;

    match routine {
        Some(mut routine) => {
            routine.actions = list_actions(conn, id)?;
            Ok(Some(routine))
        }
        None => Ok(None),
    }
}

/// Creates a routine and its actions together. A routine whose actions failed
/// to store would launch nothing, so both halves share one transaction.
pub fn create(conn: &Connection, new_routine: NewRoutine) -> ServiceResult<Routine> {
    let name = validate_name(&new_routine.name)?;
    let description = normalize_text(new_routine.description);
    let icon = normalize_text(new_routine.icon);

    let transaction = conn.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO routines (name, description, icon) VALUES (?1, ?2, ?3)",
        params![name, description, icon],
    )?;

    let id = transaction.last_insert_rowid();
    insert_actions(&transaction, id, &new_routine.actions)?;

    // Re-read so the caller gets the database's own defaults and timestamps.
    let routine = get(&transaction, id)?.ok_or_else(|| routine_not_found(id))?;
    transaction.commit()?;

    Ok(routine)
}

pub fn update(conn: &Connection, id: i64, update: RoutineUpdate) -> ServiceResult<Routine> {
    let transaction = conn.unchecked_transaction()?;
    let existing = get(&transaction, id)?.ok_or_else(|| routine_not_found(id))?;

    let mut assignments: Vec<&str> = Vec::new();
    let mut values: Vec<Value> = Vec::new();

    if let Some(name) = update.name {
        assignments.push("name = ?");
        values.push(Value::Text(validate_name(&name)?));
    }

    if let Some(description) = update.description {
        assignments.push("description = ?");
        values.push(optional_text(normalize_text(description)));
    }

    if let Some(icon) = update.icon {
        assignments.push("icon = ?");
        values.push(optional_text(normalize_text(icon)));
    }

    // Replacing the action list is a change to the routine even when no
    // column on the row itself moved, so it also refreshes `updated_at`.
    let replacing_actions = update.actions.is_some();
    if let Some(actions) = update.actions {
        transaction.execute(
            "DELETE FROM routine_actions WHERE routine_id = ?1",
            params![id],
        )?;
        insert_actions(&transaction, id, &actions)?;
    }

    if assignments.is_empty() && !replacing_actions {
        return Ok(existing);
    }

    assignments.push("updated_at = datetime('now')");
    values.push(Value::Integer(id));
    let sql = format!("UPDATE routines SET {} WHERE id = ?", assignments.join(", "));
    transaction.execute(&sql, params_from_iter(values))?;

    let routine = get(&transaction, id)?.ok_or_else(|| routine_not_found(id))?;
    transaction.commit()?;

    Ok(routine)
}

/// Deletes the routine. Its actions go with it (`ON DELETE CASCADE`), but
/// tasks and focus sessions that referenced it are kept and simply lose the
/// link — the work outlives the workspace it was done in.
pub fn delete(conn: &Connection, id: i64) -> ServiceResult<()> {
    let deleted = conn.execute("DELETE FROM routines WHERE id = ?1", params![id])?;
    if deleted == 0 {
        return Err(routine_not_found(id));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Action CRUD
// ---------------------------------------------------------------------------

pub fn list_actions(conn: &Connection, routine_id: i64) -> ServiceResult<Vec<RoutineAction>> {
    let sql = format!(
        "SELECT {ACTION_COLUMNS} FROM routine_actions WHERE routine_id = ?1 \
         ORDER BY sort_order, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let actions = statement
        .query_map(params![routine_id], RoutineAction::from_row)?
        .collect::<rusqlite::Result<Vec<RoutineAction>>>()?;

    Ok(actions)
}

pub fn get_action(conn: &Connection, id: i64) -> ServiceResult<Option<RoutineAction>> {
    let sql = format!("SELECT {ACTION_COLUMNS} FROM routine_actions WHERE id = ?1");
    conn.query_row(&sql, params![id], RoutineAction::from_row)
        .optional()
        .map_err(ServiceError::from)
}

/// Appends an action to a routine, or inserts it at `sort_order` when one is
/// given. Either way the routine is renumbered afterwards, so the returned
/// action carries its real final position.
pub fn add_action(
    conn: &Connection,
    routine_id: i64,
    action: NewRoutineAction,
) -> ServiceResult<RoutineAction> {
    let transaction = conn.unchecked_transaction()?;
    require_routine(&transaction, routine_id)?;

    let action_type = action.action_type;
    let target = validate_target(action_type, &action.target)?;
    let arguments = normalize_text(action.arguments.clone());
    let sort_order = match action.sort_order {
        Some(requested) => {
            // Inserting *at* a position means everything from there on moves
            // down. Without the shift the newcomer would tie with the current
            // occupant and lose the tiebreak (it has the higher id), landing
            // one place later than asked for.
            let requested = requested.max(0);
            transaction.execute(
                "UPDATE routine_actions SET sort_order = sort_order + 1 \
                  WHERE routine_id = ?1 AND sort_order >= ?2",
                params![routine_id, requested],
            )?;
            requested
        }
        None => next_sort_order(&transaction, routine_id)?,
    };

    transaction.execute(
        "INSERT INTO routine_actions (routine_id, type, target, arguments, sort_order, enabled)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            routine_id,
            action_type,
            target,
            arguments,
            sort_order,
            action.enabled.unwrap_or(true),
        ],
    )?;

    let id = transaction.last_insert_rowid();
    renumber_actions(&transaction, routine_id)?;
    touch_routine(&transaction, routine_id)?;

    let stored = get_action(&transaction, id)?.ok_or_else(|| action_not_found(id))?;
    transaction.commit()?;

    Ok(stored)
}

pub fn update_action(
    conn: &Connection,
    id: i64,
    update: RoutineActionUpdate,
) -> ServiceResult<RoutineAction> {
    let transaction = conn.unchecked_transaction()?;
    let existing = get_action(&transaction, id)?.ok_or_else(|| action_not_found(id))?;

    let mut assignments: Vec<&str> = Vec::new();
    let mut values: Vec<Value> = Vec::new();

    // The type decides what a valid target looks like, so a change to either
    // one re-checks the pair rather than the field in isolation.
    if update.action_type.is_some() || update.target.is_some() {
        let action_type = update.action_type.unwrap_or(existing.action_type);
        let target = update.target.clone().unwrap_or_else(|| existing.target.clone());
        let target = validate_target(action_type, &target)?;

        assignments.push("type = ?");
        values.push(Value::Text(action_type.as_str().to_owned()));
        assignments.push("target = ?");
        values.push(Value::Text(target));
    }

    if let Some(arguments) = update.arguments {
        assignments.push("arguments = ?");
        values.push(optional_text(normalize_text(arguments)));
    }

    // `sort_order` is the position the action should end up at, so the
    // actions it moves past close up (or open up) behind it. Use
    // [`reorder_actions`] to set a whole order at once; this is for nudging a
    // single step up or down.
    if let Some(requested) = update.sort_order {
        let last = next_sort_order(&transaction, existing.routine_id)? - 1;
        let target = requested.clamp(0, last.max(0));
        let current = existing.sort_order;

        if target > current {
            transaction.execute(
                "UPDATE routine_actions SET sort_order = sort_order - 1 \
                  WHERE routine_id = ?1 AND sort_order > ?2 AND sort_order <= ?3",
                params![existing.routine_id, current, target],
            )?;
        } else if target < current {
            transaction.execute(
                "UPDATE routine_actions SET sort_order = sort_order + 1 \
                  WHERE routine_id = ?1 AND sort_order >= ?2 AND sort_order < ?3",
                params![existing.routine_id, target, current],
            )?;
        }

        assignments.push("sort_order = ?");
        values.push(Value::Integer(target));
    }

    if let Some(enabled) = update.enabled {
        assignments.push("enabled = ?");
        values.push(Value::Integer(i64::from(enabled)));
    }

    if assignments.is_empty() {
        return Ok(existing);
    }

    values.push(Value::Integer(id));
    let sql = format!(
        "UPDATE routine_actions SET {} WHERE id = ?",
        assignments.join(", ")
    );
    transaction.execute(&sql, params_from_iter(values))?;

    renumber_actions(&transaction, existing.routine_id)?;
    touch_routine(&transaction, existing.routine_id)?;

    let stored = get_action(&transaction, id)?.ok_or_else(|| action_not_found(id))?;
    transaction.commit()?;

    Ok(stored)
}

pub fn delete_action(conn: &Connection, id: i64) -> ServiceResult<()> {
    let transaction = conn.unchecked_transaction()?;
    let existing = get_action(&transaction, id)?.ok_or_else(|| action_not_found(id))?;

    transaction.execute("DELETE FROM routine_actions WHERE id = ?1", params![id])?;
    renumber_actions(&transaction, existing.routine_id)?;
    touch_routine(&transaction, existing.routine_id)?;
    transaction.commit()?;

    Ok(())
}

/// Rewrites the run order from a full list of the routine's action ids
/// (section 31's drag-to-reorder). The list has to name every action exactly
/// once — a partial list would leave the rest in an order nobody chose.
pub fn reorder_actions(
    conn: &Connection,
    routine_id: i64,
    ordered_ids: &[i64],
) -> ServiceResult<Vec<RoutineAction>> {
    let transaction = conn.unchecked_transaction()?;
    require_routine(&transaction, routine_id)?;

    let mut current: Vec<i64> = list_actions(&transaction, routine_id)?
        .into_iter()
        .map(|action| action.id)
        .collect();
    let mut requested = ordered_ids.to_vec();
    current.sort_unstable();
    requested.sort_unstable();

    if current != requested {
        return Err(ServiceError::validation(
            "The new order must list every action of this routine exactly once.",
        ));
    }

    for (position, id) in ordered_ids.iter().enumerate() {
        transaction.execute(
            "UPDATE routine_actions SET sort_order = ?1 WHERE id = ?2 AND routine_id = ?3",
            params![position as i64, id, routine_id],
        )?;
    }

    touch_routine(&transaction, routine_id)?;
    let actions = list_actions(&transaction, routine_id)?;
    transaction.commit()?;

    Ok(actions)
}

/// Convenience for the builder's Save: swap the whole action list for a new
/// one, in the order given.
pub fn replace_actions(
    conn: &Connection,
    routine_id: i64,
    actions: Vec<NewRoutineAction>,
) -> ServiceResult<Vec<RoutineAction>> {
    let transaction = conn.unchecked_transaction()?;
    require_routine(&transaction, routine_id)?;

    transaction.execute(
        "DELETE FROM routine_actions WHERE routine_id = ?1",
        params![routine_id],
    )?;
    insert_actions(&transaction, routine_id, &actions)?;
    touch_routine(&transaction, routine_id)?;

    let stored = list_actions(&transaction, routine_id)?;
    transaction.commit()?;

    Ok(stored)
}

// ---------------------------------------------------------------------------
// Command-action opt-in (development-plan.md section 66)
// ---------------------------------------------------------------------------

/// Whether `command` actions may run at all. Defaults to **false**: a fresh
/// install never executes a shell command, and the user has to turn the
/// feature on deliberately. Turning it back off disables every command action
/// in every routine at once without editing any of them.
pub fn command_actions_enabled(conn: &Connection) -> ServiceResult<bool> {
    settings::get_bool(conn, COMMAND_ACTIONS_ENABLED_KEY, false)
}

pub fn set_command_actions_enabled(conn: &Connection, enabled: bool) -> ServiceResult<()> {
    settings::set_bool(conn, COMMAND_ACTIONS_ENABLED_KEY, enabled)
}

// ---------------------------------------------------------------------------
// Launch plans
// ---------------------------------------------------------------------------

/// Everything [`super::routine_exec::run`] needs, snapshotted from the
/// database so execution can happen with no connection held.
///
/// Launching an app is slow enough (and blocking enough) that holding the
/// single shared SQLite mutex across it would stall unrelated queries, so the
/// database work happens up front and the running happens after.
#[derive(Debug, Clone)]
pub struct RoutineLaunchPlan {
    pub routine_id: i64,
    pub routine_name: String,
    /// Launch stats as they stand *after* this launch was recorded.
    pub launch_count: i64,
    pub last_launched_at: Option<String>,
    /// Snapshot of the section 66 opt-in, read at plan time so a setting
    /// change mid-run cannot half-apply.
    pub command_actions_enabled: bool,
    /// The actions to work through, in order. Disabled ones are included on
    /// purpose so the run can report them as `skipped` (section 87).
    pub actions: Vec<RoutineAction>,
}

/// Records a launch and returns the plan for it.
///
/// The launch is counted here, before anything runs, so a routine the user
/// started still shows up in the section 33 statistics even if every action
/// fails or the machine is shut down mid-launch. "How often do I start this
/// workspace" is the question those stats answer.
pub fn prepare_launch(conn: &Connection, routine_id: i64) -> ServiceResult<RoutineLaunchPlan> {
    let transaction = conn.unchecked_transaction()?;
    require_routine(&transaction, routine_id)?;

    transaction.execute(
        "UPDATE routines
            SET launch_count = launch_count + 1,
                last_launched_at = datetime('now')
          WHERE id = ?1",
        params![routine_id],
    )?;

    // The same launch, dated, for the windowed statistics of sections 36 and
    // 82 — "Routines: 4" today, "Most used routine" this week. The counter
    // above answers "how many, ever" and cannot be asked "how many, today";
    // see `0007_routine_launches.sql` for why the two live side by side
    // instead of one being derived from the other. Written in this
    // transaction so a launch can never be counted by one and missed by the
    // other.
    transaction.execute(
        "INSERT INTO routine_launches (routine_id) VALUES (?1)",
        params![routine_id],
    )?;

    // Section 88's rule, and the reason it is written here rather than after
    // the run: a launch is counted the moment it is started (see this
    // function's own docs), and its reward is counted with it. Only the first
    // launch of the local day pays out — `award_routine_launch` asks the
    // ledger, so the second, fifth and twentieth launch all quietly earn
    // nothing and still launch. Behind `xp::note` so a progression failure
    // cannot stop a workspace from opening (section 50).
    xp::note(
        xp::award_routine_launch(&transaction, routine_id),
        &format!("launching routine {routine_id}"),
    );

    let routine = get(&transaction, routine_id)?.ok_or_else(|| routine_not_found(routine_id))?;
    let plan = RoutineLaunchPlan {
        routine_id: routine.id,
        routine_name: routine.name,
        launch_count: routine.launch_count,
        last_launched_at: routine.last_launched_at,
        command_actions_enabled: command_actions_enabled(&transaction)?,
        actions: routine.actions,
    };
    transaction.commit()?;

    Ok(plan)
}

/// A plan for re-running just the actions named in `action_ids` — the Retry
/// button in section 32.
///
/// This is *not* a new launch: `launch_count` is untouched, because retrying
/// the one app that failed to open is still the same trip to the workspace.
pub fn prepare_retry(
    conn: &Connection,
    routine_id: i64,
    action_ids: &[i64],
) -> ServiceResult<RoutineLaunchPlan> {
    let routine = get(conn, routine_id)?.ok_or_else(|| routine_not_found(routine_id))?;

    // Filter rather than look ids up one by one, so a retry keeps the
    // routine's own order regardless of the order the ids arrived in.
    let actions: Vec<RoutineAction> = routine
        .actions
        .into_iter()
        .filter(|action| action_ids.contains(&action.id))
        .collect();

    if let Some(missing) = action_ids
        .iter()
        .find(|id| !actions.iter().any(|action| action.id == **id))
    {
        return Err(ServiceError::not_found(format!(
            "Action {missing} does not belong to routine {routine_id}."
        )));
    }

    Ok(RoutineLaunchPlan {
        routine_id: routine.id,
        routine_name: routine.name,
        launch_count: routine.launch_count,
        last_launched_at: routine.last_launched_at,
        command_actions_enabled: command_actions_enabled(conn)?,
        actions,
    })
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// Stores `actions` in list order, assigning `sort_order` from the position.
fn insert_actions(
    conn: &Connection,
    routine_id: i64,
    actions: &[NewRoutineAction],
) -> ServiceResult<()> {
    let mut statement = conn.prepare(
        "INSERT INTO routine_actions (routine_id, type, target, arguments, sort_order, enabled)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;

    for (position, action) in actions.iter().enumerate() {
        let target = validate_target(action.action_type, &action.target)?;
        statement.execute(params![
            routine_id,
            action.action_type,
            target,
            normalize_text(action.arguments.clone()),
            position as i64,
            action.enabled.unwrap_or(true),
        ])?;
    }

    Ok(())
}

/// Collapses `sort_order` back to a dense `0..n-1` while preserving the
/// current order, so inserting at a position and deleting from the middle
/// never leave gaps or ties for the frontend to reason about.
fn renumber_actions(conn: &Connection, routine_id: i64) -> ServiceResult<()> {
    conn.execute(
        "UPDATE routine_actions
            SET sort_order = (
                SELECT COUNT(*) FROM routine_actions AS earlier
                 WHERE earlier.routine_id = routine_actions.routine_id
                   AND (earlier.sort_order < routine_actions.sort_order
                        OR (earlier.sort_order = routine_actions.sort_order
                            AND earlier.id < routine_actions.id))
            )
          WHERE routine_id = ?1",
        params![routine_id],
    )?;
    Ok(())
}

fn next_sort_order(conn: &Connection, routine_id: i64) -> ServiceResult<i64> {
    let next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM routine_actions WHERE routine_id = ?1",
        params![routine_id],
        |row| row.get(0),
    )?;
    Ok(next)
}

/// Editing an action changes the routine, so the routine's `updated_at` moves
/// with it — otherwise a reordered routine would look untouched.
fn touch_routine(conn: &Connection, routine_id: i64) -> ServiceResult<()> {
    conn.execute(
        "UPDATE routines SET updated_at = datetime('now') WHERE id = ?1",
        params![routine_id],
    )?;
    Ok(())
}

fn require_routine(conn: &Connection, routine_id: i64) -> ServiceResult<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM routines WHERE id = ?1)",
        params![routine_id],
        |row| row.get(0),
    )?;

    if exists {
        Ok(())
    } else {
        Err(routine_not_found(routine_id))
    }
}

fn routine_not_found(id: i64) -> ServiceError {
    ServiceError::not_found(format!("Routine {id} was not found."))
}

fn action_not_found(id: i64) -> ServiceError {
    ServiceError::not_found(format!("Routine action {id} was not found."))
}

fn validate_name(name: &str) -> ServiceResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ServiceError::validation("A routine needs a name."));
    }
    Ok(name.to_owned())
}

/// Normalises and checks a target against the rules of its action type, and
/// returns the exact string to store.
pub fn validate_target(action_type: RoutineActionType, target: &str) -> ServiceResult<String> {
    let target = target.trim();
    if target.is_empty() {
        return Err(ServiceError::validation(format!(
            "A {} action needs a target.",
            action_type.as_str()
        )));
    }

    match action_type {
        RoutineActionType::Application | RoutineActionType::Folder | RoutineActionType::File => {
            // Paths are deliberately not checked for existence here: a
            // routine may point at a network share or a removable drive that
            // is simply not mounted right now. The executor reports that at
            // launch time, where it is actually true.
            Ok(target.to_owned())
        }
        RoutineActionType::Url => validate_url(target),
        RoutineActionType::Timer => validate_timer_minutes(target).map(|m| m.to_string()),
        RoutineActionType::Command => validate_command(target),
    }
}

/// Accepts a URL, adding `https://` when the user typed a bare host.
///
/// Schemes that would make "open in the default browser" do something else
/// entirely — run script, open a local file, embed a payload — are refused
/// outright (section 66).
fn validate_url(target: &str) -> ServiceResult<String> {
    let scheme = target
        .split_once("://")
        .map(|(scheme, _)| scheme)
        .or_else(|| target.split_once(':').map(|(scheme, _)| scheme))
        .filter(|scheme| {
            !scheme.is_empty()
                && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        })
        .map(str::to_ascii_lowercase);

    // No scheme at all — "github.com" is what people type, and https is what
    // they mean.
    let Some(scheme) = scheme else {
        return Ok(format!("https://{target}"));
    };

    const REFUSED_SCHEMES: [&str; 5] = ["javascript", "data", "vbscript", "file", "about"];
    if REFUSED_SCHEMES.contains(&scheme.as_str()) {
        return Err(ServiceError::validation(format!(
            "{scheme}: links are not allowed as URL actions. Use a File or Folder action to \
             open something on this computer."
        )));
    }

    Ok(target.to_owned())
}

fn validate_timer_minutes(target: &str) -> ServiceResult<i64> {
    let minutes: i64 = target.trim().parse().map_err(|_| {
        ServiceError::validation(format!(
            "A timer action's target must be a number of minutes, not {target:?}."
        ))
    })?;

    if !(1..=MAX_TIMER_MINUTES).contains(&minutes) {
        return Err(ServiceError::validation(format!(
            "A timer must be between 1 and {MAX_TIMER_MINUTES} minutes."
        )));
    }

    Ok(minutes)
}

/// Reads a stored timer target back as minutes.
///
/// Targets are validated on the way in, so a stored timer always parses; the
/// `None` case only covers a row edited outside the app.
pub fn timer_minutes(target: &str) -> Option<i64> {
    validate_timer_minutes(target).ok()
}

/// Fragments that turn a command into a destructive one. This is a guardrail
/// against a mistyped or copy-pasted command, not a sandbox: anyone who can
/// edit a routine can already run programs, and the real protections are the
/// opt-in switch and echoing the command before it runs (section 66).
const REFUSED_COMMAND_FRAGMENTS: [(&str, &str); 8] = [
    ("format ", "formats a drive"),
    ("diskpart", "repartitions disks"),
    ("rm -rf", "deletes a tree without confirmation"),
    ("del /f", "force-deletes files"),
    ("rd /s", "deletes a directory tree"),
    ("rmdir /s", "deletes a directory tree"),
    ("reg delete", "deletes registry keys"),
    ("shutdown", "shuts the machine down"),
];

/// Rejects a command containing one of [`REFUSED_COMMAND_FRAGMENTS`]. Applied
/// both when the action is saved and again just before it runs, so a row that
/// was edited outside the app is still caught.
pub fn validate_command(target: &str) -> ServiceResult<String> {
    let haystack = target.to_ascii_lowercase();
    if let Some((fragment, why)) = REFUSED_COMMAND_FRAGMENTS
        .iter()
        .find(|(fragment, _)| haystack.contains(fragment))
    {
        return Err(ServiceError::validation(format!(
            "This command is blocked because it contains {fragment:?}, which {why}. \
             Routine actions are for setting up a workspace, not for maintenance."
        )));
    }

    Ok(target.trim().to_owned())
}

/// A short name for an action, for the launch checklist in section 32: the
/// file stem of an application or file, the folder name, the host of a URL,
/// "50-minute timer", or the command itself.
fn derive_label(action_type: RoutineActionType, target: &str) -> String {
    match action_type {
        RoutineActionType::Application if target.starts_with(installed_apps::APPS_FOLDER) => {
            store_app_label(target)
        }
        RoutineActionType::Application | RoutineActionType::File => {
            std::path::Path::new(target)
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .filter(|stem| !stem.is_empty())
                .unwrap_or_else(|| target.to_owned())
        }
        RoutineActionType::Folder => std::path::Path::new(target.trim_end_matches(['\\', '/']))
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| target.to_owned()),
        RoutineActionType::Url => target
            .split_once("://")
            .map_or(target, |(_, rest)| rest)
            .split('/')
            .next()
            .filter(|host| !host.is_empty())
            .unwrap_or(target)
            .to_owned(),
        RoutineActionType::Timer => match timer_minutes(target) {
            Some(minutes) => format!("{minutes}-minute timer"),
            None => target.to_owned(),
        },
        RoutineActionType::Command => target.to_owned(),
    }
}

/// A short name for a Store app, whose target is an ID rather than a path.
///
/// `shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude` is `PackageFamilyName` —
/// itself a name and a publisher hash — then `!`, then the application inside
/// the package. The last part is usually the readable one ("Claude",
/// "Spotify"); when the package only holds one app it is often just "App",
/// and then the package's own name is what is left to use.
fn store_app_label(target: &str) -> String {
    let id = target.trim_start_matches(installed_apps::APPS_FOLDER);
    let (family, application) = id.split_once('!').unwrap_or((id, ""));

    if !application.is_empty() && !application.eq_ignore_ascii_case("App") {
        return application.to_owned();
    }

    // `Microsoft.WindowsStore_8wekyb3d8bbwe` -> `WindowsStore`.
    family
        .split_once('_')
        .map_or(family, |(name, _hash)| name)
        .rsplit('.')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(id)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    fn action(action_type: RoutineActionType, target: &str) -> NewRoutineAction {
        NewRoutineAction {
            action_type,
            target: target.to_owned(),
            arguments: None,
            sort_order: None,
            enabled: None,
        }
    }

    fn coding_mode(conn: &Connection) -> Routine {
        create(
            conn,
            NewRoutine {
                name: "  Coding Mode  ".to_owned(),
                description: None,
                icon: Some("🚀".to_owned()),
                actions: vec![
                    action(RoutineActionType::Application, "C:\\Apps\\Code.exe"),
                    action(RoutineActionType::Url, "github.com"),
                    action(RoutineActionType::Folder, "C:\\Projects"),
                    action(RoutineActionType::Timer, "50"),
                ],
            },
        )
        .unwrap()
    }

    #[test]
    fn creates_a_routine_with_its_actions_in_order() {
        let conn = init_memory_db().unwrap();
        let routine = coding_mode(&conn);

        assert_eq!(routine.name, "Coding Mode");
        assert_eq!(routine.launch_count, 0);
        assert_eq!(routine.last_launched_at, None);

        let orders: Vec<i64> = routine.actions.iter().map(|a| a.sort_order).collect();
        assert_eq!(orders, vec![0, 1, 2, 3]);
        assert!(routine.actions.iter().all(|a| a.enabled));

        // Targets are normalised on the way in.
        assert_eq!(routine.actions[1].target, "https://github.com");
        assert_eq!(routine.actions[1].label, "github.com");
        assert_eq!(routine.actions[0].label, "Code");
        assert_eq!(routine.actions[2].label, "Projects");
        assert_eq!(routine.actions[3].label, "50-minute timer");
    }

    /// A Store app's target is an ID, and every part of it except one is
    /// machinery: the checklist in section 32 has to say "Claude", not
    /// "Claude_pzs8sxrjxfjjc!Claude".
    #[test]
    fn a_store_app_is_labelled_by_its_name_rather_than_its_id() {
        let label = |id: &str| {
            derive_label(
                RoutineActionType::Application,
                &format!("{}{id}", installed_apps::APPS_FOLDER),
            )
        };

        assert_eq!(label("Claude_pzs8sxrjxfjjc!Claude"), "Claude");
        assert_eq!(label("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
        // A package holding one app names it "App", which says nothing — the
        // package's own name is the only readable part left.
        assert_eq!(label("Microsoft.WindowsStore_8wekyb3d8bbwe!App"), "WindowsStore");
    }

    #[test]
    fn rejects_blank_names_and_targets_the_type_cannot_use() {
        let conn = init_memory_db().unwrap();

        let blank_name = create(
            &conn,
            NewRoutine {
                name: "   ".to_owned(),
                description: None,
                icon: None,
                actions: Vec::new(),
            },
        );
        assert!(matches!(blank_name, Err(ServiceError::Validation(_))));

        for (action_type, target) in [
            (RoutineActionType::Timer, "soon"),
            (RoutineActionType::Timer, "0"),
            (RoutineActionType::Timer, "1441"),
            (RoutineActionType::Url, "javascript:alert(1)"),
            (RoutineActionType::Url, "file:///C:/Windows"),
            (RoutineActionType::Command, "del /f C:\\Windows"),
            (RoutineActionType::Application, "   "),
        ] {
            assert!(
                matches!(
                    validate_target(action_type, target),
                    Err(ServiceError::Validation(_))
                ),
                "{action_type:?} should reject {target:?}"
            );
        }
    }

    #[test]
    fn adding_removing_and_reordering_keeps_sort_order_dense() {
        let conn = init_memory_db().unwrap();
        let routine = coding_mode(&conn);

        // Insert at the front rather than appending.
        let inserted = add_action(
            &conn,
            routine.id,
            NewRoutineAction {
                sort_order: Some(0),
                ..action(RoutineActionType::Application, "C:\\Apps\\chrome.exe")
            },
        )
        .unwrap();
        assert_eq!(inserted.sort_order, 0, "an insert at 0 wins the tie");

        let after_insert = get(&conn, routine.id).unwrap().unwrap();
        assert_eq!(
            after_insert.actions.iter().map(|a| a.sort_order).collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4]
        );
        assert_eq!(after_insert.actions[0].label, "chrome");

        // Deleting from the middle closes the gap.
        delete_action(&conn, after_insert.actions[2].id).unwrap();
        let after_delete = get(&conn, routine.id).unwrap().unwrap();
        assert_eq!(
            after_delete.actions.iter().map(|a| a.sort_order).collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );

        // Reordering rewrites positions from the given list.
        let mut ids: Vec<i64> = after_delete.actions.iter().map(|a| a.id).collect();
        ids.reverse();
        let reordered = reorder_actions(&conn, routine.id, &ids).unwrap();
        assert_eq!(reordered.iter().map(|a| a.id).collect::<Vec<_>>(), ids);
        assert_eq!(
            reordered.iter().map(|a| a.sort_order).collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
    }

    #[test]
    fn moving_one_action_lands_it_on_the_position_it_asked_for() {
        let conn = init_memory_db().unwrap();
        let routine = coding_mode(&conn);
        let labels = |conn: &Connection| -> Vec<String> {
            get(conn, routine.id)
                .unwrap()
                .unwrap()
                .actions
                .into_iter()
                .map(|a| a.label)
                .collect()
        };

        assert_eq!(
            labels(&conn),
            vec!["Code", "github.com", "Projects", "50-minute timer"]
        );

        // Down the list: the actions it passes close up behind it.
        let moved = update_action(
            &conn,
            routine.actions[0].id,
            RoutineActionUpdate { sort_order: Some(2), ..Default::default() },
        )
        .unwrap();
        assert_eq!(moved.sort_order, 2);
        assert_eq!(
            labels(&conn),
            vec!["github.com", "Projects", "Code", "50-minute timer"]
        );

        // Back up the list again.
        update_action(
            &conn,
            routine.actions[0].id,
            RoutineActionUpdate { sort_order: Some(0), ..Default::default() },
        )
        .unwrap();
        assert_eq!(
            labels(&conn),
            vec!["Code", "github.com", "Projects", "50-minute timer"]
        );

        // A position past the end clamps to last rather than erroring.
        update_action(
            &conn,
            routine.actions[0].id,
            RoutineActionUpdate { sort_order: Some(99), ..Default::default() },
        )
        .unwrap();
        assert_eq!(
            labels(&conn),
            vec!["github.com", "Projects", "50-minute timer", "Code"]
        );
    }

    #[test]
    fn reorder_refuses_a_list_that_is_not_the_whole_routine() {
        let conn = init_memory_db().unwrap();
        let routine = coding_mode(&conn);
        let ids: Vec<i64> = routine.actions.iter().map(|a| a.id).collect();

        assert!(matches!(
            reorder_actions(&conn, routine.id, &ids[..2]),
            Err(ServiceError::Validation(_))
        ));
        assert!(matches!(
            reorder_actions(&conn, routine.id, &[ids[0], ids[0], ids[1], ids[2], ids[3]]),
            Err(ServiceError::Validation(_))
        ));
    }

    #[test]
    fn update_replaces_the_action_list_when_one_is_given_and_leaves_it_alone_otherwise() {
        let conn = init_memory_db().unwrap();
        let routine = coding_mode(&conn);

        let renamed = update(
            &conn,
            routine.id,
            RoutineUpdate {
                name: Some("Deep Work".to_owned()),
                icon: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(renamed.name, "Deep Work");
        assert_eq!(renamed.icon, None, "explicit null clears the icon");
        assert_eq!(renamed.actions.len(), 4, "actions survive a rename");

        let rebuilt = update(
            &conn,
            routine.id,
            RoutineUpdate {
                actions: Some(vec![action(RoutineActionType::Timer, "25")]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rebuilt.actions.len(), 1);
        assert_eq!(rebuilt.actions[0].target, "25");
    }

    #[test]
    fn changing_an_action_type_revalidates_the_target_it_keeps() {
        let conn = init_memory_db().unwrap();
        let routine = coding_mode(&conn);
        let url_action = routine.actions[1].id;

        // "https://github.com" is not a number of minutes.
        assert!(matches!(
            update_action(
                &conn,
                url_action,
                RoutineActionUpdate {
                    action_type: Some(RoutineActionType::Timer),
                    ..Default::default()
                },
            ),
            Err(ServiceError::Validation(_))
        ));

        let switched = update_action(
            &conn,
            url_action,
            RoutineActionUpdate {
                action_type: Some(RoutineActionType::Timer),
                target: Some("15".to_owned()),
                enabled: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(switched.action_type, RoutineActionType::Timer);
        assert!(!switched.enabled);
    }

    #[test]
    fn launching_records_the_launch_and_retrying_does_not() {
        let conn = init_memory_db().unwrap();
        let routine = coding_mode(&conn);

        let first = prepare_launch(&conn, routine.id).unwrap();
        assert_eq!(first.launch_count, 1);
        assert!(first.last_launched_at.is_some());
        assert_eq!(first.actions.len(), 4);
        assert!(
            !first.command_actions_enabled,
            "command actions are off until the user opts in"
        );

        let second = prepare_launch(&conn, routine.id).unwrap();
        assert_eq!(second.launch_count, 2);

        let retry = prepare_retry(&conn, routine.id, &[routine.actions[1].id]).unwrap();
        assert_eq!(retry.launch_count, 2, "a retry is not a new launch");
        assert_eq!(retry.actions.len(), 1);
        assert_eq!(retry.actions[0].id, routine.actions[1].id);

        // Stats survive a re-read, and a stranger's action id is refused.
        let stored = get(&conn, routine.id).unwrap().unwrap();
        assert_eq!(stored.launch_count, 2);
        assert!(matches!(
            prepare_retry(&conn, routine.id, &[9999]),
            Err(ServiceError::NotFound(_))
        ));
    }

    #[test]
    fn top_by_use_ranks_by_launches_and_falls_back_to_name() {
        let conn = init_memory_db().unwrap();

        let named = |name: &str| {
            create(
                &conn,
                NewRoutine {
                    name: name.to_owned(),
                    description: None,
                    icon: None,
                    actions: vec![action(RoutineActionType::Url, "example.com")],
                },
            )
            .unwrap()
        };

        // Deliberately not in alphabetical order, so the fallback is doing
        // something rather than agreeing with insertion order by accident.
        let work = named("Work");
        let coding = named("Coding");
        let study = named("Study");

        let names = |routines: Vec<RoutineSummary>| {
            routines
                .into_iter()
                .map(|routine| routine.name)
                .collect::<Vec<_>>()
        };

        // Nobody has launched anything: the menu is still offered, by name.
        assert_eq!(
            names(top_by_use(&conn, 5).unwrap()),
            vec!["Coding", "Study", "Work"]
        );

        prepare_launch(&conn, study.id).unwrap();
        prepare_launch(&conn, study.id).unwrap();
        prepare_launch(&conn, work.id).unwrap();

        assert_eq!(
            names(top_by_use(&conn, 5).unwrap()),
            vec!["Study", "Work", "Coding"]
        );

        // The limit is what keeps a tray menu from becoming the routine list.
        assert_eq!(names(top_by_use(&conn, 2).unwrap()), vec!["Study", "Work"]);

        // A routine with no launches sorts below one that has some, whatever
        // its name — `coding` is first alphabetically and still last here.
        assert_eq!(coding.launch_count, 0);
    }

    #[test]
    fn command_actions_stay_off_until_explicitly_enabled() {
        let conn = init_memory_db().unwrap();

        assert!(!command_actions_enabled(&conn).unwrap());
        set_command_actions_enabled(&conn, true).unwrap();
        assert!(command_actions_enabled(&conn).unwrap());
        set_command_actions_enabled(&conn, false).unwrap();
        assert!(!command_actions_enabled(&conn).unwrap());
    }

    #[test]
    fn deleting_a_routine_takes_its_actions_but_not_its_tasks() {
        let conn = init_memory_db().unwrap();
        let routine = coding_mode(&conn);

        let task = crate::services::tasks::create(
            &conn,
            serde_json::from_value(serde_json::json!({ "title": "Ship the feature" })).unwrap(),
        )
        .unwrap();
        conn.execute(
            "UPDATE tasks SET routine_id = ?1 WHERE id = ?2",
            params![routine.id, task.id],
        )
        .unwrap();

        delete(&conn, routine.id).unwrap();

        let orphaned_actions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM routine_actions WHERE routine_id = ?1",
                params![routine.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(orphaned_actions, 0, "actions cascade with the routine");

        let surviving = crate::services::tasks::get(&conn, task.id).unwrap().unwrap();
        assert_eq!(surviving.routine_id, None, "the task outlives the routine");

        assert!(matches!(delete(&conn, routine.id), Err(ServiceError::NotFound(_))));
    }

    #[test]
    fn list_puts_recently_launched_routines_first() {
        let conn = init_memory_db().unwrap();
        let first = coding_mode(&conn);
        let second = create(
            &conn,
            NewRoutine {
                name: "Study Mode".to_owned(),
                description: None,
                icon: None,
                actions: vec![action(RoutineActionType::Timer, "25")],
            },
        )
        .unwrap();

        // Never-launched routines come newest-first.
        let names: Vec<String> = list(&conn).unwrap().into_iter().map(|r| r.name).collect();
        assert_eq!(names, vec!["Study Mode", "Coding Mode"]);

        prepare_launch(&conn, first.id).unwrap();
        let listed = list(&conn).unwrap();
        assert_eq!(listed[0].id, first.id);
        assert_eq!(listed[0].actions.len(), 4, "list attaches each action list");
        assert_eq!(listed[1].id, second.id);
    }
}
