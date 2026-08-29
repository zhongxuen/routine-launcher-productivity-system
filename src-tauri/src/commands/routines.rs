//! `invoke`-able routine commands. Thin wrappers over `services::routines`
//! and `services::routine_exec` (section 86).
//!
//! Two things happen here that do not belong in a service:
//!
//! * the SQLite mutex is released before a routine actually runs, so
//!   launching applications never blocks other queries;
//! * timer requests are turned into a Tauri event, because emitting is a
//!   Tauri concern and the services stay free of the runtime.

use tauri::{AppHandle, Emitter, State};

use crate::db::DbConnection;
use crate::services::routine_exec::{self, ActionStatus, RoutineRunResult};
use crate::services::routines::{
    self, NewRoutine, NewRoutineAction, Routine, RoutineAction, RoutineActionUpdate, RoutineUpdate,
};

/// Emitted once per `timer` action that a routine ran, carrying the requested
/// focus length. Stage 4's focus timer listens for this; until then the launch
/// panel just shows "⏱ Focus timer started" from the same signal.
const TIMER_REQUESTED_EVENT: &str = "routine://timer-requested";

/// Payload of [`TIMER_REQUESTED_EVENT`].
#[derive(Clone, serde::Serialize)]
pub struct TimerRequest {
    pub routine_id: i64,
    pub routine_name: String,
    pub action_id: i64,
    pub minutes: i64,
}

// ---------------------------------------------------------------------------
// Routine CRUD
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_routines(db: State<DbConnection>) -> Result<Vec<Routine>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routines::list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_routine(db: State<DbConnection>, id: i64) -> Result<Option<Routine>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routines::get(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_routine(db: State<DbConnection>, routine: NewRoutine) -> Result<Routine, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routines::create(&conn, routine).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_routine(
    db: State<DbConnection>,
    id: i64,
    updates: RoutineUpdate,
) -> Result<Routine, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routines::update(&conn, id, updates).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_routine(db: State<DbConnection>, id: i64) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routines::delete(&conn, id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Action CRUD
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_routine_actions(
    db: State<DbConnection>,
    routine_id: i64,
) -> Result<Vec<RoutineAction>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routines::list_actions(&conn, routine_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_routine_action(
    db: State<DbConnection>,
    routine_id: i64,
    action: NewRoutineAction,
) -> Result<RoutineAction, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routines::add_action(&conn, routine_id, action).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_routine_action(
    db: State<DbConnection>,
    id: i64,
    updates: RoutineActionUpdate,
) -> Result<RoutineAction, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routines::update_action(&conn, id, updates).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_routine_action(db: State<DbConnection>, id: i64) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routines::delete_action(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_routine_actions(
    db: State<DbConnection>,
    routine_id: i64,
    action_ids: Vec<i64>,
) -> Result<Vec<RoutineAction>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routines::reorder_actions(&conn, routine_id, &action_ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn replace_routine_actions(
    db: State<DbConnection>,
    routine_id: i64,
    actions: Vec<NewRoutineAction>,
) -> Result<Vec<RoutineAction>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routines::replace_actions(&conn, routine_id, actions).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Launches a routine: records the launch, runs every action in order, and
/// returns the structured result the launch panel renders (sections 32, 87).
#[tauri::command]
pub fn launch_routine(
    app: AppHandle,
    db: State<DbConnection>,
    id: i64,
) -> Result<RoutineRunResult, String> {
    let plan = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        routines::prepare_launch(&conn, id).map_err(|e| e.to_string())?
        // The guard is dropped here on purpose: everything below launches
        // programs, which must not hold the database.
    };

    Ok(finish_run(&app, routine_exec::run(plan)))
}

/// Re-runs only the given actions — the Retry button in section 32. Does not
/// count as another launch.
#[tauri::command]
pub fn retry_routine_actions(
    app: AppHandle,
    db: State<DbConnection>,
    routine_id: i64,
    action_ids: Vec<i64>,
) -> Result<RoutineRunResult, String> {
    let plan = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        routines::prepare_retry(&conn, routine_id, &action_ids).map_err(|e| e.to_string())?
    };

    Ok(finish_run(&app, routine_exec::run(plan)))
}

/// Turns the timer actions in a finished run into [`TIMER_REQUESTED_EVENT`]
/// emissions.
///
/// A failed emit is not a failed routine — the apps are already open — so it
/// is logged and the result is returned regardless.
fn finish_run(app: &AppHandle, result: RoutineRunResult) -> RoutineRunResult {
    for action in &result.actions {
        let (ActionStatus::Success, Some(minutes)) = (action.status, action.timer_minutes) else {
            continue;
        };

        let request = TimerRequest {
            routine_id: result.routine_id,
            routine_name: result.routine_name.clone(),
            action_id: action.action_id,
            minutes,
        };

        if let Err(err) = app.emit(TIMER_REQUESTED_EVENT, request) {
            eprintln!("[routine] could not emit {TIMER_REQUESTED_EVENT}: {err}");
        }
    }

    result
}

// ---------------------------------------------------------------------------
// Command-action opt-in (development-plan.md section 66)
// ---------------------------------------------------------------------------

/// Whether `command` actions are allowed to run. False on a fresh install.
#[tauri::command]
pub fn get_command_actions_enabled(db: State<DbConnection>) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routines::command_actions_enabled(&conn).map_err(|e| e.to_string())
}

/// Turns command execution on or off for every routine at once. Setting it to
/// false is the kill switch section 66 asks for: existing command actions stay
/// saved but stop running.
#[tauri::command]
pub fn set_command_actions_enabled(
    db: State<DbConnection>,
    enabled: bool,
) -> Result<bool, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    routines::set_command_actions_enabled(&conn, enabled).map_err(|e| e.to_string())?;
    Ok(enabled)
}
