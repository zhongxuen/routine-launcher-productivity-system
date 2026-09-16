//! Commands for the sync folder (development-plan.md section 92 Tier 5).
//! Thin wrappers over `services::sync` (section 86), plus the background pass
//! that pushes local changes and announces newer data in the folder.

use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::DbConnection;
use crate::services::sync::{self, AutoOutcome, SyncStatus};
use crate::services::tray;

/// Emitted when automatic sync finds newer data in the folder, or a conflict,
/// that the user has to act on. Payload is a [`SyncStatus`].
pub const SYNC_ATTENTION_EVENT: &str = "sync://attention";

fn version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn get_sync_status(app: AppHandle, db: State<DbConnection>) -> Result<SyncStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    sync::status(&conn, &version(&app)).map_err(|e| e.to_string())
}

/// Chooses the folder (null stops syncing), this device's name, and whether
/// sync runs by itself.
#[tauri::command]
pub fn configure_sync(
    app: AppHandle,
    db: State<DbConnection>,
    folder: Option<String>,
    device_name: Option<String>,
    auto_sync: bool,
) -> Result<SyncStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    sync::configure(&conn, folder, device_name, auto_sync, &version(&app)).map_err(|e| e.to_string())
}

/// Writes this device's data to the folder. `overwrite` keeps this device's
/// side of a conflict.
#[tauri::command]
pub fn sync_push(app: AppHandle, db: State<DbConnection>, overwrite: bool) -> Result<SyncStatus, String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    sync::push(&conn, &version(&app), overwrite).map_err(|e| e.to_string())
}

/// Replaces this device's data with the folder's. `overwrite` takes the
/// folder's side of a conflict. The windows reload afterwards, as after Import.
#[tauri::command]
pub fn sync_pull(app: AppHandle, db: State<DbConnection>, overwrite: bool) -> Result<SyncStatus, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let status = {
        let mut conn = db.lock().map_err(|e| e.to_string())?;
        sync::pull(&mut conn, &version(&app), &app_data_dir, overwrite).map_err(|e| e.to_string())?
    };
    tray::refresh(&app);
    Ok(status)
}

/// Starts the periodic pass. It sleeps first and does nothing while automatic
/// sync is off.
pub fn start_background(app: AppHandle) {
    let spawned = thread::Builder::new().name("sync".into()).spawn(move || {
        // The last folder write announced, so one arrival is announced once.
        let mut announced: Option<String> = None;
        loop {
            thread::sleep(Duration::from_secs(sync::AUTO_SYNC_SECONDS));

            let Some(state) = app.try_state::<DbConnection>() else {
                continue;
            };
            let outcome = match state.lock() {
                Ok(conn) => {
                    if !sync::wants_background(&conn) {
                        continue;
                    }
                    sync::periodic(&conn, &version(&app)).map_err(|e| e.to_string())
                }
                Err(error) => Err(error.to_string()),
            };

            match outcome {
                Ok(AutoOutcome::RemoteWaiting(status)) | Ok(AutoOutcome::Conflicted(status)) => {
                    let marker = status.remote.as_ref().map(|remote| remote.written_at.clone());
                    if marker != announced {
                        announced = marker;
                        if let Err(error) = app.emit(SYNC_ATTENTION_EVENT, &status) {
                            crate::log_warn!("[sync] could not announce newer data: {error}");
                        }
                    }
                }
                Ok(_) => {}
                Err(error) => crate::log_warn!("[sync] automatic sync did not run: {error}"),
            }
        }
    });
    if let Err(error) = spawned {
        crate::log_error!("[sync] could not start automatic sync: {error}");
    }
}
