//! Cloud and cross-device synchronization, without a cloud
//! (development-plan.md sections 56, 68, 69, 92 Tier 5).
//!
//! Section 92 lists cloud and cross-device sync as future features, and
//! sections 56 and 68 promise no account, no backend and no cloud database.
//! Both are kept by syncing through a **folder the user chooses**: point two
//! computers at the same OneDrive, Dropbox, Google Drive or network folder,
//! and each writes and reads one file there, [`SYNC_FILE_NAME`]. Whatever
//! syncs that folder carries the file between machines. This app opens no
//! socket for it and knows nothing about the provider.
//!
//! # A snapshot, not a merge
//!
//! The file is section 69's backup — every table, lossless, ids and all —
//! plus which device wrote it and a hash of its data. Pushing writes this
//! device's data there; pulling replaces this device's data with the file's,
//! through the same validated, all-or-nothing restore as Import. Rows are
//! never merged, because a merge that pairs up ids written independently on
//! two machines is exactly the kind of quiet corruption section 69 exists to
//! avoid.
//!
//! What makes that safe is knowing which side changed. Each device remembers
//! the hash of the data it last pushed or pulled ([`LAST_HASH_KEY`]):
//!
//! | this device changed | the folder changed | state |
//! | --- | --- | --- |
//! | no | no | up to date |
//! | yes | no | push |
//! | no | yes | pull |
//! | yes | yes | conflict — the user picks a side |
//!
//! A conflict is never resolved automatically, and a pull always saves this
//! device's data to `sync-safety/before-pull.json` first.
//!
//! # What stays on this device
//!
//! Some rows describe the machine rather than the user's work: where the
//! widget sits, the quick launcher's shortcut, the large-file archive folder,
//! this device's sync state, the usage history of *this* computer's programs,
//! and the calendar, which each computer reads from its own feed or file.
//! Those are left out of the file and kept through a pull
//! ([`is_device_setting`], [`DEVICE_TABLES`]). So is section 66's command
//! switch: a file written by another machine must never be the thing that
//! lets commands run on this one.
//!
//! # Automatic sync
//!
//! A snapshot suits one computer at a time — the laptop in the morning, the
//! desktop in the evening. Two computers open at once each write their own
//! changes (a reminder firing is a change), so the second to push meets a
//! conflict, which is reported rather than guessed at.
//!
//! Optional. When on, a pull that is safe (nothing changed here) happens at
//! start-up, before any window reads the database, and changes made here are
//! pushed every [`AUTO_SYNC_SECONDS`] while the app runs. Newer data arriving
//! in the folder *while* the app is open is announced rather than pulled, so
//! the screen is never replaced under the user's hands.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};

use crate::db;

use super::backup::{self, Backup};
use super::error::{ServiceError, ServiceResult};
use super::random;
use super::routines::COMMAND_ACTIONS_ENABLED_KEY;
use super::settings;

/// The one file the sync folder holds.
pub const SYNC_FILE_NAME: &str = "routine-launcher-sync.json";
/// Marks the file as ours.
pub const SYNC_FORMAT: &str = "routine-launcher-sync";
/// The envelope's version.
pub const SYNC_FORMAT_VERSION: i64 = 1;
/// How often automatic sync looks for changes to push.
pub const AUTO_SYNC_SECONDS: u64 = 120;

const FOLDER_KEY: &str = "sync.folder";
const DEVICE_ID_KEY: &str = "sync.device_id";
const DEVICE_NAME_KEY: &str = "sync.device_name";
const AUTO_KEY: &str = "sync.auto";
const LAST_HASH_KEY: &str = "sync.last_hash";
const LAST_SYNCED_AT_KEY: &str = "sync.last_synced_at";

/// Settings that belong to the machine, by prefix. See the module docs.
const DEVICE_SETTING_PREFIXES: &[&str] = &[
    "sync.",
    "widget.",
    "large_files.",
    "shortcuts.",
    "tray.",
    "updates.",
    "companion.",
    "usage.",
    // Each computer reads its own calendar feed on its own clock, so the
    // copy of the events is the computer's too (see `DEVICE_TABLES`).
    "calendar.",
];

/// Settings that belong to the machine, by exact key.
const DEVICE_SETTING_KEYS: &[&str] = &[
    COMMAND_ACTIONS_ENABLED_KEY,
    // Section 22's once-a-day notification is shown once per machine.
    "daily.end_of_day_notified_on",
];

/// Tables that belong to the machine: this computer's program usage, and its
/// copy of the calendar. A feed is re-read every few hours on each computer
/// that has it, and every re-read replaces the rows — syncing them would make
/// two computers with the same feed disagree every six hours.
pub const DEVICE_TABLES: &[&str] = &["app_usage", "calendar_events"];

/// Where a pull keeps this device's data before replacing it.
const SAFETY_FOLDER: &str = "sync-safety";
const SAFETY_FILE: &str = "before-pull.json";

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// The file in the sync folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFile {
    pub format: String,
    pub format_version: i64,
    pub device_id: String,
    pub device_name: String,
    /// [`data_hash`] of `backup`, so a reader need not recompute it.
    pub data_hash: String,
    pub backup: Backup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    /// No folder chosen.
    NotConfigured,
    /// The chosen folder is not there (a drive not mounted, a provider not
    /// running), or the file in it cannot be read.
    Unavailable,
    /// The folder has no sync file yet: push to start.
    Empty,
    UpToDate,
    /// This device has changes the folder does not.
    LocalChanges,
    /// The folder has changes this device does not.
    RemoteChanges,
    /// Both changed since they last agreed.
    Conflict,
    /// This device has never synced with a folder that already has data.
    FirstSync,
    /// The folder was written by a newer version of the app.
    RemoteTooNew,
}

/// Who wrote the file in the folder, and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub device_id: String,
    pub device_name: String,
    /// UTC `YYYY-MM-DD HH:MM:SS`.
    pub written_at: String,
    pub app_version: String,
    pub is_this_device: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: SyncState,
    pub folder: Option<String>,
    pub device_name: String,
    pub auto_sync: bool,
    /// UTC, the last push or pull.
    pub last_synced_at: Option<String>,
    pub remote: Option<RemoteInfo>,
    /// Why the folder is unavailable, in a sentence.
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// This device's id, created the first time it is asked for.
fn device_id(conn: &Connection) -> ServiceResult<String> {
    if let Some(id) = settings::get(conn, DEVICE_ID_KEY)? {
        return Ok(id);
    }
    let id = random::hex_token(16)?;
    settings::set(conn, DEVICE_ID_KEY, &id)?;
    Ok(id)
}

fn device_name(conn: &Connection) -> ServiceResult<String> {
    Ok(settings::get(conn, DEVICE_NAME_KEY)?
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(default_device_name))
}

fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "This computer".to_string())
}

pub fn auto_sync(conn: &Connection) -> ServiceResult<bool> {
    settings::get_bool(conn, AUTO_KEY, false)
}

pub fn folder(conn: &Connection) -> ServiceResult<Option<String>> {
    Ok(settings::get(conn, FOLDER_KEY)?.filter(|folder| !folder.trim().is_empty()))
}

/// Sets the folder (null to stop syncing), this device's name and the
/// automatic switch. A folder has to exist. Choosing a different folder
/// forgets what the old one last agreed on.
pub fn configure(
    conn: &Connection,
    folder_path: Option<String>,
    name: Option<String>,
    auto: bool,
    app_version: &str,
) -> ServiceResult<SyncStatus> {
    let folder_path = folder_path
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());

    if let Some(path) = &folder_path {
        if !Path::new(path).is_dir() {
            return Err(ServiceError::validation(format!(
                "There is no folder at {path}. Choose a folder that exists, such as one inside \
                 OneDrive or Dropbox."
            )));
        }
    }

    let previous = folder(conn)?;
    if previous != folder_path {
        conn.execute(
            "DELETE FROM settings WHERE key IN (?1, ?2)",
            [LAST_HASH_KEY, LAST_SYNCED_AT_KEY],
        )?;
    }

    match &folder_path {
        Some(path) => settings::set(conn, FOLDER_KEY, path)?,
        None => {
            conn.execute("DELETE FROM settings WHERE key = ?1", [FOLDER_KEY])?;
        }
    }

    let name = name.map(|name| name.trim().to_string()).filter(|name| !name.is_empty());
    match name {
        Some(name) if name.chars().count() > 60 => {
            return Err(ServiceError::validation("A device name can be at most 60 characters."))
        }
        Some(name) => settings::set(conn, DEVICE_NAME_KEY, &name)?,
        None => {
            conn.execute("DELETE FROM settings WHERE key = ?1", [DEVICE_NAME_KEY])?;
        }
    }

    settings::set_bool(conn, AUTO_KEY, auto && folder_path.is_some())?;
    device_id(conn)?;
    status(conn, app_version)
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/// Whether a settings key describes this machine rather than the user's work.
pub fn is_device_setting(key: &str) -> bool {
    DEVICE_SETTING_KEYS.contains(&key)
        || DEVICE_SETTING_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
}

fn setting_key(row: &serde_json::Map<String, JsonValue>) -> &str {
    row.get("key").and_then(JsonValue::as_str).unwrap_or_default()
}

/// The backup this device would push: everything but the device's own rows.
pub fn sync_view(conn: &Connection, app_version: &str) -> ServiceResult<Backup> {
    let mut snapshot = backup::snapshot(conn, app_version)?;
    for table in DEVICE_TABLES {
        snapshot.tables.remove(*table);
    }
    if let Some(rows) = snapshot.tables.get_mut("settings") {
        rows.retain(|row| !is_device_setting(setting_key(row)));
    }
    Ok(snapshot)
}

/// A hash of a snapshot's data, stable across exports of unchanged data.
///
/// The settings table's `updated_at` is left out: saving a setting with the
/// value it already had is not a change worth syncing.
pub fn data_hash(snapshot: &Backup) -> String {
    let mut tables = snapshot.tables.clone();
    if let Some(rows) = tables.get_mut("settings") {
        for row in rows.iter_mut() {
            row.remove("updated_at");
        }
    }
    let json = serde_json::to_string(&tables).unwrap_or_default();
    let digest = Sha256::digest(json.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sync_path(folder_path: &str) -> PathBuf {
    Path::new(folder_path).join(SYNC_FILE_NAME)
}

/// The file in the folder: `Ok(None)` when there is none yet.
fn read_remote(folder_path: &str) -> ServiceResult<Option<SyncFile>> {
    if !Path::new(folder_path).is_dir() {
        return Err(ServiceError::validation(format!(
            "The sync folder {folder_path} is not available. If it is on a drive or a cloud \
             folder that is not connected, connect it and try again."
        )));
    }

    let path = sync_path(folder_path);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(ServiceError::validation(format!(
                "Could not read {}: {error}",
                path.display()
            )))
        }
    };

    let file: SyncFile = serde_json::from_str(&text).map_err(|error| {
        ServiceError::validation(format!(
            "{} is not a readable sync file (it may still be downloading): {error}",
            path.display()
        ))
    })?;
    if file.format != SYNC_FORMAT {
        return Err(ServiceError::validation(format!(
            "{} is not a Routine Launcher sync file.",
            path.display()
        )));
    }
    Ok(Some(file))
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

pub fn status(conn: &Connection, app_version: &str) -> ServiceResult<SyncStatus> {
    let this_device = device_id(conn)?;
    let mut result = SyncStatus {
        state: SyncState::NotConfigured,
        folder: folder(conn)?,
        device_name: device_name(conn)?,
        auto_sync: auto_sync(conn)?,
        last_synced_at: settings::get(conn, LAST_SYNCED_AT_KEY)?,
        remote: None,
        message: None,
    };

    let Some(folder_path) = result.folder.clone() else {
        return Ok(result);
    };

    let remote = match read_remote(&folder_path) {
        Ok(remote) => remote,
        Err(error) => {
            result.state = SyncState::Unavailable;
            result.message = Some(error.to_string());
            return Ok(result);
        }
    };

    let local_hash = data_hash(&sync_view(conn, app_version)?);
    let last_hash = settings::get(conn, LAST_HASH_KEY)?;

    let Some(remote) = remote else {
        result.state = SyncState::Empty;
        return Ok(result);
    };

    result.remote = Some(RemoteInfo {
        is_this_device: remote.device_id == this_device,
        device_id: remote.device_id.clone(),
        device_name: remote.device_name.clone(),
        written_at: remote.backup.exported_at.clone(),
        app_version: remote.backup.app_version.clone(),
    });

    result.state = decide(
        &local_hash,
        &remote.data_hash,
        last_hash.as_deref(),
        remote.backup.schema_version > db::schema_version(conn)?,
    );
    Ok(result)
}

/// The table in the module docs.
fn decide(local: &str, remote: &str, last: Option<&str>, remote_too_new: bool) -> SyncState {
    if local == remote {
        return SyncState::UpToDate;
    }
    let state = match last {
        None => SyncState::FirstSync,
        Some(last) => match (local != last, remote != last) {
            (false, false) => SyncState::UpToDate,
            (true, false) => SyncState::LocalChanges,
            (false, true) => SyncState::RemoteChanges,
            (true, true) => SyncState::Conflict,
        },
    };
    if remote_too_new && state != SyncState::LocalChanges {
        return SyncState::RemoteTooNew;
    }
    state
}

// ---------------------------------------------------------------------------
// Push and pull
// ---------------------------------------------------------------------------

/// Writes this device's data to the folder.
///
/// Refuses to overwrite changes made elsewhere unless `overwrite` is set,
/// which is the "keep this device's" answer to a conflict.
pub fn push(conn: &Connection, app_version: &str, overwrite: bool) -> ServiceResult<SyncStatus> {
    let folder_path = folder(conn)?
        .ok_or_else(|| ServiceError::validation("Choose a sync folder first."))?;

    let current = status(conn, app_version)?;
    match current.state {
        SyncState::Unavailable => {
            return Err(ServiceError::validation(
                current.message.unwrap_or_else(|| "The sync folder is not available.".into()),
            ))
        }
        SyncState::RemoteChanges | SyncState::Conflict | SyncState::FirstSync | SyncState::RemoteTooNew
            if !overwrite =>
        {
            return Err(ServiceError::validation(
                "The sync folder has changes this computer does not have. Pull them, or choose \
                 to keep this computer's data instead.",
            ))
        }
        _ => {}
    }

    let snapshot = sync_view(conn, app_version)?;
    let hash = data_hash(&snapshot);
    let file = SyncFile {
        format: SYNC_FORMAT.to_string(),
        format_version: SYNC_FORMAT_VERSION,
        device_id: device_id(conn)?,
        device_name: device_name(conn)?,
        data_hash: hash.clone(),
        backup: snapshot,
    };

    let json = serde_json::to_string(&file)
        .map_err(|e| ServiceError::validation(format!("Could not build the sync file: {e}")))?;

    // Written beside the real file and renamed over it, so a sync client
    // never uploads half a file.
    let target = sync_path(&folder_path);
    let partial = target.with_extension("json.partial");
    std::fs::write(&partial, json)
        .map_err(|e| ServiceError::validation(format!("Could not write to the sync folder: {e}")))?;
    std::fs::rename(&partial, &target).map_err(|e| {
        let _ = std::fs::remove_file(&partial);
        ServiceError::validation(format!("Could not write to the sync folder: {e}"))
    })?;

    remember(conn, &hash)?;
    status(conn, app_version)
}

/// Replaces this device's data with the folder's.
///
/// Refuses to discard changes made here unless `overwrite` is set, which is
/// the "take the folder's" answer to a conflict. This device's data is saved
/// to `<app data>/sync-safety/before-pull.json` first either way.
pub fn pull(
    conn: &mut Connection,
    app_version: &str,
    app_data_dir: &Path,
    overwrite: bool,
) -> ServiceResult<SyncStatus> {
    let folder_path = folder(conn)?
        .ok_or_else(|| ServiceError::validation("Choose a sync folder first."))?;

    let current = status(conn, app_version)?;
    match current.state {
        SyncState::Unavailable => {
            return Err(ServiceError::validation(
                current.message.unwrap_or_else(|| "The sync folder is not available.".into()),
            ))
        }
        SyncState::Empty => {
            return Err(ServiceError::validation("The sync folder has nothing to pull yet."))
        }
        SyncState::RemoteTooNew => {
            return Err(ServiceError::validation(
                "The sync folder was written by a newer version of Routine Launcher. Update this \
                 computer's copy, then pull.",
            ))
        }
        SyncState::LocalChanges | SyncState::Conflict | SyncState::FirstSync if !overwrite => {
            return Err(ServiceError::validation(
                "This computer has changes the sync folder does not. Push them, or choose to take \
                 the folder's data instead.",
            ))
        }
        _ => {}
    }

    let remote = read_remote(&folder_path)?
        .ok_or_else(|| ServiceError::validation("The sync folder has nothing to pull yet."))?;

    // The safety copy, before anything is replaced.
    let safety_dir = app_data_dir.join(SAFETY_FOLDER);
    std::fs::create_dir_all(&safety_dir).map_err(|e| {
        ServiceError::validation(format!("Could not save this computer's data before pulling: {e}"))
    })?;
    backup::export_to_file(
        conn,
        app_version,
        &safety_dir.join(SAFETY_FILE).to_string_lossy(),
    )?;

    let merged = with_device_rows(conn, remote.backup, app_version)?;
    backup::restore(conn, &merged)?;

    let hash = data_hash(&sync_view(conn, app_version)?);
    remember(conn, &hash)?;
    status(conn, app_version)
}

/// `incoming` with this device's own rows put back in place of the file's.
fn with_device_rows(conn: &Connection, mut incoming: Backup, app_version: &str) -> ServiceResult<Backup> {
    let local = backup::snapshot(conn, app_version)?;

    for table in DEVICE_TABLES {
        match local.tables.get(*table) {
            Some(rows) => {
                incoming.tables.insert((*table).to_string(), rows.clone());
            }
            None => {
                incoming.tables.remove(*table);
            }
        }
    }

    let local_device_settings: Vec<_> = local
        .tables
        .get("settings")
        .map(|rows| {
            rows.iter()
                .filter(|row| is_device_setting(setting_key(row)))
                .cloned()
                .collect()
        })
        .unwrap_or_default();

    let settings_rows = incoming.tables.entry("settings".to_string()).or_default();
    settings_rows.retain(|row| !is_device_setting(setting_key(row)));
    settings_rows.extend(local_device_settings);

    Ok(incoming)
}

fn remember(conn: &Connection, hash: &str) -> ServiceResult<()> {
    settings::set(conn, LAST_HASH_KEY, hash)?;
    let now: String = conn.query_row("SELECT datetime('now')", [], |row| row.get(0))?;
    settings::set(conn, LAST_SYNCED_AT_KEY, &now)
}

// ---------------------------------------------------------------------------
// Automatic sync
// ---------------------------------------------------------------------------

/// What one automatic pass did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoOutcome {
    Nothing,
    Pushed,
    Pulled,
    /// The folder has newer data, and pulling is left to the user.
    RemoteWaiting(SyncStatus),
    /// Both sides changed.
    Conflicted(SyncStatus),
}

/// The start-up pass: pull when that loses nothing, push when only this
/// device changed. Runs before any window reads the database.
pub fn at_startup(conn: &mut Connection, app_version: &str, app_data_dir: &Path) -> ServiceResult<AutoOutcome> {
    if !auto_sync(conn)? || folder(conn)?.is_none() {
        return Ok(AutoOutcome::Nothing);
    }
    let current = status(conn, app_version)?;
    match current.state {
        SyncState::RemoteChanges => {
            pull(conn, app_version, app_data_dir, false)?;
            Ok(AutoOutcome::Pulled)
        }
        SyncState::LocalChanges | SyncState::Empty => {
            push(conn, app_version, false)?;
            Ok(AutoOutcome::Pushed)
        }
        SyncState::Conflict | SyncState::FirstSync => Ok(AutoOutcome::Conflicted(current)),
        _ => Ok(AutoOutcome::Nothing),
    }
}

/// The periodic pass while the app runs: push local changes, and announce,
/// rather than pull, anything newer in the folder.
pub fn periodic(conn: &Connection, app_version: &str) -> ServiceResult<AutoOutcome> {
    if !auto_sync(conn)? || folder(conn)?.is_none() {
        return Ok(AutoOutcome::Nothing);
    }
    let current = status(conn, app_version)?;
    match current.state {
        SyncState::LocalChanges | SyncState::Empty => {
            push(conn, app_version, false)?;
            Ok(AutoOutcome::Pushed)
        }
        SyncState::RemoteChanges => Ok(AutoOutcome::RemoteWaiting(current)),
        SyncState::Conflict | SyncState::FirstSync => Ok(AutoOutcome::Conflicted(current)),
        _ => Ok(AutoOutcome::Nothing),
    }
}

/// Whether auto sync is worth a background pass at all.
pub fn wants_background(conn: &Connection) -> bool {
    auto_sync(conn).unwrap_or(false) && folder(conn).ok().flatten().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;
    use crate::services::app_usage;

    struct Device {
        conn: Connection,
        data_dir: PathBuf,
    }

    fn device(name: &str, folder_path: &Path) -> Device {
        let conn = init_memory_db().unwrap();
        // Per test and per device: tests run in parallel, and two tests
        // sharing a "Laptop" folder would delete each other's safety copy.
        let folder_name = folder_path.file_name().unwrap().to_string_lossy();
        let data_dir = std::env::temp_dir().join(format!("{folder_name}-data-{name}"));
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).unwrap();
        configure(
            &conn,
            Some(folder_path.to_string_lossy().into_owned()),
            Some(name.into()),
            false,
            "0.1.5",
        )
        .unwrap();
        Device { conn, data_dir }
    }

    fn shared_folder(name: &str) -> PathBuf {
        let folder_path = std::env::temp_dir().join(format!("routine-launcher-sync-test-{name}"));
        let _ = std::fs::remove_dir_all(&folder_path);
        std::fs::create_dir_all(&folder_path).unwrap();
        folder_path
    }

    fn state(device: &Device) -> SyncState {
        status(&device.conn, "0.1.5").unwrap().state
    }

    fn titles(conn: &Connection) -> Vec<String> {
        conn.prepare("SELECT title FROM tasks ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn the_state_table() {
        assert_eq!(decide("a", "a", None, false), SyncState::UpToDate);
        assert_eq!(decide("a", "b", None, false), SyncState::FirstSync);
        assert_eq!(decide("b", "c", Some("c"), false), SyncState::LocalChanges);
        assert_eq!(decide("c", "b", Some("c"), false), SyncState::RemoteChanges);
        assert_eq!(decide("b", "d", Some("c"), false), SyncState::Conflict);
        assert_eq!(decide("c", "b", Some("c"), true), SyncState::RemoteTooNew);
    }

    #[test]
    fn two_devices_take_turns_through_one_folder() {
        let folder_path = shared_folder("turns");
        let mut laptop = device("Laptop", &folder_path);
        let mut desktop = device("Desktop", &folder_path);

        assert_eq!(state(&laptop), SyncState::Empty);
        laptop.conn.execute("INSERT INTO tasks (title) VALUES ('Written on the laptop')", []).unwrap();
        push(&laptop.conn, "0.1.5", false).unwrap();
        assert_eq!(state(&laptop), SyncState::UpToDate);

        // The desktop has never synced, and its own (empty) data differs.
        assert_eq!(state(&desktop), SyncState::FirstSync);
        assert!(
            pull(&mut desktop.conn, "0.1.5", &desktop.data_dir, false).is_err(),
            "a first sync never replaces data without being asked"
        );
        pull(&mut desktop.conn, "0.1.5", &desktop.data_dir, true).unwrap();
        assert_eq!(titles(&desktop.conn), ["Written on the laptop"]);
        assert_eq!(state(&desktop), SyncState::UpToDate);
        assert!(desktop.data_dir.join(SAFETY_FOLDER).join(SAFETY_FILE).is_file());

        desktop.conn.execute("INSERT INTO tasks (title) VALUES ('Then the desktop')", []).unwrap();
        assert_eq!(state(&desktop), SyncState::LocalChanges);
        push(&desktop.conn, "0.1.5", false).unwrap();

        assert_eq!(state(&laptop), SyncState::RemoteChanges);
        assert!(push(&laptop.conn, "0.1.5", false).is_err(), "a push must not overwrite them");
        pull(&mut laptop.conn, "0.1.5", &laptop.data_dir, false).unwrap();
        assert_eq!(titles(&laptop.conn), ["Written on the laptop", "Then the desktop"]);
        assert_eq!(state(&laptop), SyncState::UpToDate);
        assert_eq!(state(&desktop), SyncState::UpToDate);

        let _ = std::fs::remove_dir_all(folder_path);
    }

    #[test]
    fn a_conflict_waits_for_the_user() {
        let folder_path = shared_folder("conflict");
        let mut laptop = device("Laptop", &folder_path);
        let mut desktop = device("Desktop", &folder_path);
        push(&laptop.conn, "0.1.5", false).unwrap();
        pull(&mut desktop.conn, "0.1.5", &desktop.data_dir, true).unwrap();

        laptop.conn.execute("INSERT INTO tasks (title) VALUES ('Laptop')", []).unwrap();
        push(&laptop.conn, "0.1.5", false).unwrap();
        desktop.conn.execute("INSERT INTO tasks (title) VALUES ('Desktop')", []).unwrap();

        assert_eq!(state(&desktop), SyncState::Conflict);
        assert!(pull(&mut desktop.conn, "0.1.5", &desktop.data_dir, false).is_err());
        assert!(push(&desktop.conn, "0.1.5", false).is_err());
        assert!(matches!(
            at_startup(&mut desktop.conn, "0.1.5", &desktop.data_dir),
            Ok(AutoOutcome::Nothing)
        ), "auto sync is off here, so start-up does nothing");

        // Keeping the desktop's side.
        push(&desktop.conn, "0.1.5", true).unwrap();
        pull(&mut laptop.conn, "0.1.5", &laptop.data_dir, false).unwrap();
        assert_eq!(titles(&laptop.conn), ["Desktop"]);

        let _ = std::fs::remove_dir_all(folder_path);
    }

    #[test]
    fn device_rows_stay_on_the_device() {
        let folder_path = shared_folder("device-rows");
        let laptop = device("Laptop", &folder_path);
        let mut desktop = device("Desktop", &folder_path);

        settings::set(&laptop.conn, "widget.mode", "focus").unwrap();
        settings::set_bool(&laptop.conn, COMMAND_ACTIONS_ENABLED_KEY, true).unwrap();
        settings::set(&laptop.conn, "daily.quest_count", "2").unwrap();
        app_usage::record(&laptop.conn, "2026-09-16", 9, "Code.exe", None, 60).unwrap();
        push(&laptop.conn, "0.1.5", false).unwrap();

        settings::set(&desktop.conn, "widget.mode", "tasks").unwrap();
        app_usage::record(&desktop.conn, "2026-09-16", 9, "Photoshop.exe", None, 60).unwrap();
        pull(&mut desktop.conn, "0.1.5", &desktop.data_dir, true).unwrap();

        assert_eq!(settings::get(&desktop.conn, "daily.quest_count").unwrap().as_deref(), Some("2"));
        assert_eq!(settings::get(&desktop.conn, "widget.mode").unwrap().as_deref(), Some("tasks"));
        assert!(
            !settings::get_bool(&desktop.conn, COMMAND_ACTIONS_ENABLED_KEY, false).unwrap(),
            "another machine can never switch commands on here"
        );
        assert_eq!(
            settings::get(&desktop.conn, DEVICE_NAME_KEY).unwrap().as_deref(),
            Some("Desktop")
        );
        let apps: Vec<String> = desktop
            .conn
            .prepare("SELECT app_name FROM app_usage")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(apps, ["Photoshop.exe"]);

        let text = std::fs::read_to_string(folder_path.join(SYNC_FILE_NAME)).unwrap();
        assert!(!text.contains("Code.exe"), "usage never leaves the device");
        assert!(!text.contains("calendar_events"), "nor does the calendar copy");

        let _ = std::fs::remove_dir_all(folder_path);
    }

    #[test]
    fn automatic_sync_pulls_only_when_nothing_is_lost() {
        let folder_path = shared_folder("auto");
        let laptop = device("Laptop", &folder_path);
        let mut desktop = device("Desktop", &folder_path);
        push(&laptop.conn, "0.1.5", false).unwrap();
        pull(&mut desktop.conn, "0.1.5", &desktop.data_dir, true).unwrap();
        configure(
            &desktop.conn,
            Some(folder_path.to_string_lossy().into_owned()),
            Some("Desktop".into()),
            true,
            "0.1.5",
        )
        .unwrap();
        // Re-choosing the same folder keeps what it last agreed on.
        assert_eq!(state(&desktop), SyncState::UpToDate);

        laptop.conn.execute("INSERT INTO tasks (title) VALUES ('From the laptop')", []).unwrap();
        push(&laptop.conn, "0.1.5", false).unwrap();

        assert!(matches!(periodic(&desktop.conn, "0.1.5").unwrap(), AutoOutcome::RemoteWaiting(_)));
        assert!(titles(&desktop.conn).is_empty(), "never pulled under an open window");

        assert_eq!(
            at_startup(&mut desktop.conn, "0.1.5", &desktop.data_dir).unwrap(),
            AutoOutcome::Pulled
        );
        assert_eq!(titles(&desktop.conn), ["From the laptop"]);

        desktop.conn.execute("INSERT INTO tasks (title) VALUES ('Desktop again')", []).unwrap();
        assert_eq!(periodic(&desktop.conn, "0.1.5").unwrap(), AutoOutcome::Pushed);

        let _ = std::fs::remove_dir_all(folder_path);
    }

    #[test]
    fn a_folder_has_to_exist() {
        let conn = init_memory_db().unwrap();
        let missing = std::env::temp_dir().join("routine-launcher-sync-no-such-folder");
        assert!(configure(&conn, Some(missing.to_string_lossy().into_owned()), None, true, "0.1.5").is_err());
        let off = configure(&conn, None, None, true, "0.1.5").unwrap();
        assert_eq!(off.state, SyncState::NotConfigured);
        assert!(!off.auto_sync, "automatic sync needs a folder");
    }
}
