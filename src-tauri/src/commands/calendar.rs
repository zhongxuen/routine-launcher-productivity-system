//! Commands for calendar integration (development-plan.md sections 53, 92).
//! Thin wrappers over `services::calendar` (section 86), plus the one network
//! request it needs: fetching an `.ics` feed.
//!
//! # What the feed request is allowed to be
//!
//! A single `GET` of the address the user pasted, with no cookies, no body
//! and nothing that identifies the user beyond what the address itself
//! carries. The response is capped at `MAX_CALENDAR_BYTES` and read as text;
//! anything that is not a calendar is refused by the parser and leaves the
//! last good events in place. It runs when the address is saved, when Refresh
//! is pressed, shortly after start-up and every [`FEED_REFRESH_HOURS`] hours.

use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::db::DbConnection;
use crate::services::calendar::{self, CalendarEvent, CalendarStatus, Source, MAX_CALENDAR_BYTES};

/// How often the feed is re-read while the app runs.
pub const FEED_REFRESH_HOURS: u64 = 6;
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

#[tauri::command]
pub fn get_calendar_status(db: State<DbConnection>) -> Result<CalendarStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    calendar::status(&conn).map_err(|e| e.to_string())
}

/// A day's events, for Tasks > Today.
#[tauri::command]
pub fn list_calendar_events(db: State<DbConnection>, date: String) -> Result<Vec<CalendarEvent>, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    calendar::list_for_date(&conn, &date).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_calendar_file(db: State<DbConnection>, path: String) -> Result<CalendarStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    calendar::import_file(&conn, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_calendar_file(db: State<DbConnection>) -> Result<CalendarStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    calendar::clear(&conn, Source::File).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_calendar_feed(db: State<DbConnection>) -> Result<CalendarStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    calendar::clear(&conn, Source::Feed).map_err(|e| e.to_string())
}

/// Saves a feed address and reads it once. A feed that fails to load is still
/// saved, with the reason on the status, so a temporary outage does not make
/// the user paste it again.
#[tauri::command]
pub async fn set_calendar_feed(app: AppHandle, url: String) -> Result<CalendarStatus, String> {
    let normalized = {
        let db = app.state::<DbConnection>();
        let conn = db.lock().map_err(|e| e.to_string())?;
        calendar::set_feed_url(&conn, &url).map_err(|e| e.to_string())?
    };
    refresh(&app, &normalized).await
}

/// Reads the saved feed again.
#[tauri::command]
pub async fn refresh_calendar_feed(app: AppHandle) -> Result<CalendarStatus, String> {
    let url = {
        let db = app.state::<DbConnection>();
        let conn = db.lock().map_err(|e| e.to_string())?;
        calendar::feed_url(&conn).map_err(|e| e.to_string())?
    };
    match url {
        Some(url) => refresh(&app, &url).await,
        None => Err("Add a calendar feed address first.".into()),
    }
}

#[tauri::command]
pub fn default_calendar_export_name() -> &'static str {
    calendar::EXPORT_FILE_NAME
}

/// Writes open tasks with a due date to an `.ics` file. Answers how many.
#[tauri::command]
pub fn export_tasks_calendar(db: State<DbConnection>, path: String) -> Result<usize, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    calendar::export_tasks(&conn, &path).map_err(|e| e.to_string())
}

/// Fetches `url` without holding the database, then records the outcome.
async fn refresh(app: &AppHandle, url: &str) -> Result<CalendarStatus, String> {
    let fetched = fetch(url).await;
    let db = app.state::<DbConnection>();
    let conn = db.lock().map_err(|e| e.to_string())?;
    calendar::record_feed(&conn, fetched).map_err(|e| e.to_string())
}

async fn fetch(url: &str) -> Result<String, String> {
    // The same TLS provider the updater installs; whichever runs first wins.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent("RoutineLauncher-Calendar")
        .build()
        .map_err(|e| format!("Could not prepare the request: {e}"))?;

    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("The calendar could not be reached: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "The calendar server answered {}. Check that the address is still valid.",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CALENDAR_BYTES as u64)
    {
        return Err("That calendar is too large to read.".into());
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("The calendar could not be read: {e}"))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_CALENDAR_BYTES {
            return Err("That calendar is too large to read.".into());
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Re-reads a saved feed shortly after start-up and then every few hours.
pub fn start_feed_refresher(app: AppHandle) {
    const FIRST_DELAY: Duration = Duration::from_secs(20);

    let spawned = std::thread::Builder::new()
        .name("calendar-feed".into())
        .spawn(move || {
            // A little after start-up, so the first read does not compete
            // with the windows opening.
            std::thread::sleep(FIRST_DELAY);
            loop {
                let url = app.try_state::<DbConnection>().and_then(|db| {
                    let conn = db.lock().ok()?;
                    calendar::feed_url(&conn).ok().flatten()
                });
                if let Some(url) = url {
                    if let Err(error) = tauri::async_runtime::block_on(refresh(&app, &url)) {
                        crate::log_warn!("[calendar] could not record the feed refresh: {error}");
                    }
                }
                std::thread::sleep(Duration::from_secs(FEED_REFRESH_HOURS * 3600));
            }
        });
    if let Err(error) = spawned {
        crate::log_error!("[calendar] could not start the feed refresher: {error}");
    }
}
