//! Native desktop notifications: the reminder commands, and the scheduler
//! that fires reminders whether or not anybody is looking at the app
//! (development-plan.md sections 24 and 78).
//!
//! The split follows section 86, with one wrinkle. `services/reminders.rs`
//! owns what a reminder is and when it is owed; `services/notifications.rs`
//! owns what it says. Both are free of the Tauri runtime, so both are
//! testable without one. This module is the part that cannot be: it talks to
//! the OS through `tauri-plugin-notification`, emits to the frontend, and
//! owns the background thread — the same reason `commands/routines.rs` does
//! the emitting for `routine_exec`.
//!
//! ## The fallback
//!
//! Section 24 wants Start Task / Snooze / Dismiss on the notification. No
//! desktop platform can draw them with this plugin (the reasons are listed in
//! `services/notifications.rs`), so every reminder is delivered twice over:
//! once as an OS notification whose body says where the buttons are, and once
//! as a [`REMINDER_FIRED_EVENT`] carrying the same payload — task, routine,
//! wording and the three actions — for the app to act on when it is open.
//! [`snooze_task_reminder`] and [`dismiss_task_reminder`] are what those
//! buttons call, wherever they end up being drawn, so the behaviour section
//! 24 asks for is the same on a platform that grows real buttons later.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::{NotificationExt, PermissionState};

use crate::db::DbConnection;
use crate::services::end_of_day;
use crate::services::focus::FocusSession;
use crate::services::notifications::{
    self, ReminderNotification, NATIVE_ACTION_BUTTONS, REMINDER_ACTION_TYPE,
};
use crate::services::reminders::{
    self, ReminderInput, TaskReminder, TaskReminderEntry, DEFAULT_SNOOZE_MINUTES,
};
use crate::services::tasks::{self, Task};

/// Emitted for every reminder the scheduler delivers, carrying the same
/// payload the OS was given.
///
/// This is the click-through half of section 24: with no buttons on the toast
/// itself, the app is where Start Task, Snooze and Dismiss live, and this is
/// how it finds out there is a reminder to offer them for.
pub const REMINDER_FIRED_EVENT: &str = "notification://reminder-fired";

/// How often the scheduler looks for reminders that have come due.
///
/// Half a minute is well inside the smallest thing a user can configure — a
/// reminder is set to the minute — so the worst case is a notification up to
/// 30 seconds late, and the poll itself is one indexed read of a handful of
/// rows. Anything finer would spend more time waking up than working; anything
/// coarser would make "at 5:00 PM" visibly untrue.
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Lets only one delivery pass run at a time.
///
/// Two can be asked for at once — the scheduler wakes up while the frontend
/// is calling [`check_task_reminders`] — and both would read the same owed
/// reminders before either had marked one as delivered, which is one toast
/// per pass for the same reminder. The database lock cannot prevent that: it
/// is released between reading and marking, on purpose, so the OS call in
/// between blocks nothing else. This is the lock that makes a pass atomic
/// against another pass, and nothing else waits on it.
static DELIVERY: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------------------
// Configuring a reminder
// ---------------------------------------------------------------------------

/// Sets, replaces or (with `reminder: null`) removes a task's reminder, and
/// answers with the task as stored so the caller can drop it straight back
/// into a list.
///
/// Rejects a reminder the task cannot support — both forms need a due date,
/// and "N minutes before" needs a due time to count back from — so set the
/// task's dates first and its reminder second.
#[tauri::command]
pub fn set_task_reminder(
    db: State<DbConnection>,
    task_id: i64,
    reminder: Option<ReminderInput>,
) -> Result<Task, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    reminders::set(&conn, task_id, reminder).map_err(|e| e.to_string())?;
    require_task(&conn, task_id)
}

/// Returns the task's reminder, or `null` when it has none — including when
/// the task itself is gone, which the caller can treat the same way.
#[tauri::command]
pub fn get_task_reminder(
    db: State<DbConnection>,
    task_id: i64,
) -> Result<Option<TaskReminder>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    reminders::get(&conn, task_id).map_err(|e| e.to_string())
}

/// Every reminder configured on a task that is still open, in due order. One
/// call is what lets a task list mark the rows that have a reminder without a
/// query per row.
#[tauri::command]
pub fn list_task_reminders(db: State<DbConnection>) -> Result<Vec<TaskReminderEntry>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    reminders::list(&conn).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Acting on one
// ---------------------------------------------------------------------------

/// Section 24's Snooze: put the reminder back for `minutes`, defaulting to
/// [`DEFAULT_SNOOZE_MINUTES`], and let it come round again once more.
///
/// The task and the reminder's configuration are both untouched — see
/// `services/reminders.rs`.
#[tauri::command]
pub fn snooze_task_reminder(
    db: State<DbConnection>,
    task_id: i64,
    minutes: Option<i64>,
) -> Result<Task, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    reminders::snooze(&conn, task_id, minutes).map_err(|e| e.to_string())?;
    require_task(&conn, task_id)
}

/// Section 24's Dismiss: silence this reminder. The reminder stays configured
/// and the task is not completed, cancelled or deleted — dismissing a
/// notification is not doing the work.
#[tauri::command]
pub fn dismiss_task_reminder(db: State<DbConnection>, task_id: i64) -> Result<Task, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    reminders::dismiss(&conn, task_id).map_err(|e| e.to_string())?;
    require_task(&conn, task_id)
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/// What the frontend needs to know about how notifications behave here.
#[derive(Debug, Clone, Serialize)]
pub struct NotificationCapabilities {
    /// Whether the OS will actually show what we send it.
    pub permission_granted: bool,
    /// Whether the notification can carry section 24's three buttons itself.
    /// False everywhere today, which is what the in-app fallback is for.
    pub native_action_buttons: bool,
    /// The snooze length used when the caller does not choose one.
    pub default_snooze_minutes: i64,
    /// How often reminders are checked, so the UI can say how late a reminder
    /// might be rather than implying it is instant.
    pub poll_seconds: u64,
}

/// Whether notifications can be shown, and how much of section 24 the OS can
/// do on its own.
#[tauri::command]
pub fn notification_capabilities(app: AppHandle) -> NotificationCapabilities {
    NotificationCapabilities {
        permission_granted: permission_granted(&app),
        native_action_buttons: NATIVE_ACTION_BUTTONS,
        default_snooze_minutes: DEFAULT_SNOOZE_MINUTES,
        poll_seconds: POLL_INTERVAL.as_secs(),
    }
}

/// Shows one notification, so a user can find out that their OS is swallowing
/// them without waiting for a reminder to be the thing that goes missing.
#[tauri::command]
pub fn send_test_notification(app: AppHandle) -> Result<(), String> {
    let (title, body) = notifications::test_notification();
    show(&app, &title, &body, None)
}

/// Runs a reminder check immediately and answers with what it delivered.
///
/// The scheduler does this on its own every [`POLL_INTERVAL`]; this is for
/// the moments where waiting is silly — the app has just come back to the
/// foreground, or a reminder has just been configured for a moment that has
/// already passed.
#[tauri::command]
pub fn check_task_reminders(app: AppHandle) -> Result<Vec<ReminderNotification>, String> {
    deliver_due_reminders(&app)
}

/// Starts the background reminder scheduler. Called once from `lib.rs`.
///
/// A plain OS thread rather than an async task: it sleeps almost all the time
/// and its only work is a short SQLite read, which is blocking anyway. It is
/// detached deliberately — there is nothing to join, and it should stop
/// exactly when the process does.
pub fn start_scheduler(app: AppHandle) {
    let spawned = thread::Builder::new()
        .name("task-reminder-scheduler".to_owned())
        .spawn(move || loop {
            // Sleeps first: at this point the window is still being built,
            // and a reminder is no less due half a minute from now.
            thread::sleep(POLL_INTERVAL);

            if let Err(error) = deliver_due_reminders(&app) {
                crate::log_error!("[notification] could not check reminders: {error}");
            }

            announce_end_of_day_if_due(&app);
        });

    if let Err(error) = spawned {
        // Reminders are then only as good as `check_task_reminders`, which
        // the frontend still calls — worth saying loudly, not worth refusing
        // to start the app over.
        crate::log_error!("[notification] reminder scheduler could not start: {error}");
    }
}

/// Announces a finished focus session (section 34's timer running out).
///
/// Called from `commands/focus.rs` when a session ends *completed*, which is
/// the only case worth a notification: a session the user stopped early was
/// stopped by someone already looking at the app.
///
/// Failure is logged, never returned: the session is on record by this point,
/// and a notification the OS refused is not a reason to fail the write that
/// ended it.
pub fn announce_focus_session(app: &AppHandle, session: &FocusSession) {
    let notification = notifications::for_focus_session(session);

    if let Err(error) = show(app, &notification.title, &notification.body, None) {
        crate::log_error!(
            "[notification] could not announce focus session {}: {error}",
            session.id
        );
    }
}

/// The last focus break whose end was announced, by the id the frontend gave
/// it.
///
/// Every window holding the focus store counts the break down, and each one
/// reaches the end within a tick of the others — so each one asks. Only the
/// first ask for a given break is shown; the rest are told they were not
/// first, which is also how the frontend knows not to play the sound twice.
/// One slot is enough: there is only ever one break, and a new one replaces
/// the id before its own end can come round.
static ANNOUNCED_BREAK: Mutex<Option<String>> = Mutex::new(None);

/// Announces the end of a focus break (section 34), once per break however
/// many windows ask. Answers true to the caller that got to announce it.
///
/// A command rather than something Rust notices for itself because Rust keeps
/// no break: a break is not focus, has no row, and lives only in the
/// frontend's focus store. `back_to` is the task or routine the next session
/// is for, if any, so the notification can say what to get back to.
///
/// A notification the OS refuses is logged and still counts as announced — the
/// caller's sound is then the only cue left, and it should not be skipped
/// because a toast failed.
#[tauri::command]
pub fn announce_break_over(
    app: AppHandle,
    break_id: String,
    minutes: i64,
    back_to: Option<String>,
) -> bool {
    {
        // Poisoning guards nothing here: the slot is a single id, and the
        // worst a half-finished writer can leave is a break announced twice.
        let mut announced = ANNOUNCED_BREAK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if announced.as_deref() == Some(break_id.as_str()) {
            return false;
        }
        *announced = Some(break_id);
    }

    let (title, body) = notifications::break_over(minutes, back_to.as_deref());
    if let Err(error) = show(&app, &title, &body, None) {
        crate::log_error!("[notification] could not announce the end of a break: {error}");
    }

    true
}

/// Tells the user, once, that closing the window put the app in the tray
/// rather than quitting it (development-plan.md section 27).
///
/// Called from `on_window_event` in `lib.rs`, which owns the "once" —
/// `tray::should_announce_minimize` records that it has been said. Failure is
/// logged and nothing else: the window is already hidden by this point, and a
/// notice the OS would not show is not a reason to keep it on screen.
pub fn announce_minimized_to_tray(app: &AppHandle) {
    let (title, body) = notifications::minimized_to_tray();

    if let Err(error) = show(app, &title, &body, None) {
        crate::log_error!("[notification] could not announce the tray: {error}");
    }
}

/// Section 22's one end-of-day notification, if it is owed on this poll.
///
/// Rides the reminder scheduler rather than a thread of its own: it is one
/// more thing to check every 30 seconds, whether or not a window is open.
/// `end_of_day::take_notification` decides and records in one step, so it is
/// sent at most once a day. Nothing is opened — section 22's review is
/// optional, and the notification only says where it is.
fn announce_end_of_day_if_due(app: &AppHandle) {
    let owed = {
        let db = app.state::<DbConnection>();
        let conn = match db.lock() {
            Ok(conn) => conn,
            Err(error) => {
                crate::log_error!("[notification] could not reach the database: {error}");
                return;
            }
        };
        end_of_day::take_notification(&conn)
    };

    match owed {
        Ok(true) => {
            let (title, body) = notifications::end_of_day();
            if let Err(error) = show(app, &title, &body, None) {
                crate::log_error!("[notification] could not announce the end of the day: {error}");
            }
        }
        Ok(false) => {}
        Err(error) => {
            crate::log_error!("[notification] could not check the end of the day: {error}")
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// One pass of the scheduler: show every reminder that has come due, record
/// it as delivered, and tell the frontend about it.
///
/// The database lock is taken twice and held across neither the notification
/// nor the emit, so a slow OS notification never blocks a query — the same
/// rule `launch_routine` follows for launching applications.
///
/// Order matters: the reminder is marked as delivered *after* it has been
/// shown, so a notification the OS refuses is left owed and tried again on
/// the next pass rather than being silently swallowed. That retry is bounded
/// by the grace window in `services/reminders.rs`, so a permanently broken
/// notification channel cannot retry forever.
fn deliver_due_reminders(app: &AppHandle) -> Result<Vec<ReminderNotification>, String> {
    // A pass that panicked half-way through poisoned nothing worth guarding —
    // the state it works on is all in SQLite — so a poisoned lock is taken
    // rather than allowed to stop every reminder from then on.
    let _pass = DELIVERY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    let db = app.state::<DbConnection>();

    let pending = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        reminders::due(&conn).map_err(|e| e.to_string())?
    };

    let mut delivered = Vec::with_capacity(pending.len());

    for reminder in &pending {
        let notification = notifications::for_reminder(reminder);

        if let Err(error) = show(
            app,
            &notification.title,
            &notification.body,
            Some(REMINDER_ACTION_TYPE),
        ) {
            crate::log_error!(
                "[notification] could not show the reminder for task {}: {error}",
                notification.task_id
            );
            continue;
        }

        {
            let conn = db.lock().map_err(|e| e.to_string())?;
            reminders::mark_fired(&conn, notification.task_id).map_err(|e| e.to_string())?;
        }

        // A window that is closed, or not listening, is an ordinary state for
        // a notification to arrive in — it is the case the OS notification
        // exists for — so a failed emit is reported and the reminder still
        // counts as delivered.
        if let Err(error) = app.emit(REMINDER_FIRED_EVENT, &notification) {
            crate::log_error!("[notification] could not emit {REMINDER_FIRED_EVENT}: {error}");
        }

        delivered.push(notification);
    }

    Ok(delivered)
}

/// Hands one notification to the OS.
///
/// `action_type` names the button set the notification would carry on a
/// platform that supports them. Today's desktop implementation ignores it;
/// sending it anyway costs nothing and means the notification is already
/// tagged for the day one does.
fn show(app: &AppHandle, title: &str, body: &str, action_type: Option<&str>) -> Result<(), String> {
    let mut builder = app.notification().builder().title(title).body(body);

    if let Some(action_type) = action_type {
        builder = builder.action_type_id(action_type);
    }

    builder.show().map_err(|error| error.to_string())
}

fn permission_granted(app: &AppHandle) -> bool {
    matches!(
        app.notification().permission_state(),
        Ok(PermissionState::Granted)
    )
}

/// Re-reads the task a reminder command just changed, so the caller gets the
/// row with its reminder on it rather than having to fetch it again.
fn require_task(conn: &rusqlite::Connection, task_id: i64) -> Result<Task, String> {
    tasks::get(conn, task_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Task {task_id} was not found."))
}
