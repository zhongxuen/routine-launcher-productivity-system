//! `invoke`-able focus session commands. Each one locks the connection,
//! forwards to `services::focus`, and flattens the service error to a
//! `String` the frontend can surface. No SQL and no rules live here
//! (section 86).
//!
//! There is no "tick" command: the countdown itself runs in the frontend
//! (`src/stores/focusStore.ts`), and these four calls are the points where
//! something worth keeping happens — a session begins, a session ends, and a
//! reload or a new window needs to find out what is already running.
//!
//! The one thing that does happen here beyond forwarding is section 78's
//! focus-completion notification: a session that *finished* is announced to
//! the OS on its way out (see [`announce_if_completed`]). It hangs off the
//! end of the session rather than off the end of the countdown so that it
//! fires wherever the timer was being watched from — or from nowhere at all,
//! if the user has walked away from the window.

use tauri::{AppHandle, State};

use crate::commands::notification;
use crate::db::DbConnection;
use crate::services::focus::{self, FocusFilter, FocusSession, FocusSessionOutcome, NewFocusSession};

/// Starts a focus session and returns it with `started_at` already stored, so
/// the elapsed time survives a reload of the UI. Any session still running is
/// closed as interrupted first.
#[tauri::command]
pub fn start_focus_session(
    db: State<DbConnection>,
    session: NewFocusSession,
) -> Result<FocusSession, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    focus::start(&conn, session).map_err(|e| e.to_string())
}

/// Ends a running session. `outcome.completed` is what separates a finished
/// session from an abandoned one (section 35), and `outcome.duration_seconds`
/// is the frontend's measured focus time for a timer that was paused.
#[tauri::command]
pub fn end_focus_session(
    app: AppHandle,
    db: State<DbConnection>,
    id: i64,
    outcome: FocusSessionOutcome,
) -> Result<FocusSession, String> {
    // The guard is dropped before the notification goes out: showing one is
    // an OS round-trip, and no query should wait behind it.
    let session = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        focus::end(&conn, id, outcome).map_err(|e| e.to_string())?
    };

    Ok(announce_if_completed(&app, session))
}

/// Ends whatever session is running, and returns `null` if none was.
///
/// Used on startup to close a session the previous run left open: no one was
/// watching that clock, so it is recorded as interrupted rather than resumed.
#[tauri::command]
pub fn end_active_focus_session(
    app: AppHandle,
    db: State<DbConnection>,
    outcome: FocusSessionOutcome,
) -> Result<Option<FocusSession>, String> {
    let session = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        focus::end_active(&conn, outcome).map_err(|e| e.to_string())?
    };

    Ok(session.map(|session| announce_if_completed(&app, session)))
}

/// The session that is still running, or `null`. This is how a freshly loaded
/// window picks a timer back up mid-session.
#[tauri::command]
pub fn get_active_focus_session(db: State<DbConnection>) -> Result<Option<FocusSession>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    focus::active(&conn).map_err(|e| e.to_string())
}

/// Returns `null` rather than an error when the session does not exist, so the
/// caller can treat "gone" as an ordinary outcome.
#[tauri::command]
pub fn get_focus_session(
    db: State<DbConnection>,
    id: i64,
) -> Result<Option<FocusSession>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    focus::get(&conn, id).map_err(|e| e.to_string())
}

/// Focus history (section 64), newest first. Omitting `filter` lists every
/// session, running one included.
#[tauri::command]
pub fn list_focus_sessions(
    db: State<DbConnection>,
    filter: Option<FocusFilter>,
) -> Result<Vec<FocusSession>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    focus::list(&conn, filter.unwrap_or_default()).map_err(|e| e.to_string())
}

/// Announces a session that finished, and says nothing about one that did
/// not.
///
/// The distinction is section 35's: a *completed* session ran to its target,
/// which is news — the user may well be looking at something else by then.
/// An interrupted one was stopped by somebody who was already there, and the
/// startup sweep closes abandoned sessions the same way; telling either of
/// them what they just did would be noise.
fn announce_if_completed(app: &AppHandle, session: FocusSession) -> FocusSession {
    if session.completed {
        notification::announce_focus_session(app, &session);
    }
    session
}
