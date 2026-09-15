//! Commands for Desktop Cleanup (development-plan.md sections 38, 66, 67, 81).
//!
//! Thin, per section 86: [`services::desktop`](crate::services::desktop) holds
//! every rule about what may be touched, and what lives here is the one thing
//! it cannot know — *where the desktops are* — because that is a different
//! path on every OS and only Tauri's path resolver and the environment can
//! answer it.
//!
//! Resolving the folders is deliberately the *only* way they are chosen. No
//! command here takes a desktop folder from the frontend, so there is no
//! argument a bug or a stray `invoke` could set to make the cleanup tools act
//! somewhere else on the disk. `destination` on [`move_desktop_items`] is the
//! single path that comes in from outside, it can only ever be a move
//! *target*, and the service checks it exists, is a directory, is not a
//! desktop itself and is not on the public one before anything is written
//! into it.
//!
//! Section 67's order — scan, show, select, confirm, act — is kept by what is
//! and is not exposed here: [`scan_desktop`] reads and changes nothing, and
//! the two that do change something take an explicit list of items. There is
//! no command that clears "everything older than a month" or "all the
//! shortcuts", because there is no point in the product where the app, rather
//! than the user, gets to decide that — and so no quest, schedule or tray item
//! has anything to call.
//!
//! The two that change something also leave a row in `cleanup_actions` once
//! at least one item was handled, for the cleanup quest and the Organized
//! achievement to count. The row is written after the items have been
//! handled, never before, and holds no path.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::db::DbConnection;
use crate::services::cleanup_actions::{self, CleanupAction, CleanupUtility};
use crate::services::desktop::{self, ActionReport, DesktopRoot, DesktopRootKind, DesktopScan};
use crate::services::screenshots::{now_epoch, LocalClock};

/// Reads both desktops and describes what is on them.
///
/// The database is touched once, for the local UTC offset the age buckets are
/// measured against, and the lock is released before the walk starts — a
/// desktop full of files takes a moment, and holding the shared connection
/// across it would stall every other query in the app for no reason.
///
/// Step one of section 67, and the only step that happens without the user
/// having selected anything. It changes nothing.
#[tauri::command]
pub fn scan_desktop(app: AppHandle, db: State<DbConnection>) -> Result<DesktopScan, String> {
    let clock = {
        let conn = db.lock().map_err(|error| error.to_string())?;
        LocalClock::from_db(&conn).map_err(|error| error.to_string())?
    };

    let roots = desktop_roots(&app);
    if roots.is_empty() {
        return Err("Could not find your Desktop folder on this computer.".to_string());
    }

    Ok(desktop::scan(&roots, clock, now_epoch()))
}

/// Moves the items the user selected into a folder they picked.
///
/// The recoverable action, and the one the review flow offers first: nothing
/// is lost, so something that turns out to have been wanted is still there.
#[tauri::command]
pub fn move_desktop_items(
    app: AppHandle,
    db: State<DbConnection>,
    paths: Vec<String>,
    destination: String,
) -> Result<ActionReport, String> {
    let report = desktop::move_items(&desktop_roots(&app), &paths, &destination)
        .map_err(|error| error.to_string())?;
    cleanup_actions::note(
        &db,
        CleanupUtility::Desktop,
        CleanupAction::Move,
        report.succeeded,
    );
    Ok(report)
}

/// Deletes the items the user selected, permanently.
///
/// The last step of section 67's chain. It is only reached from a confirmation
/// dialog that names the count and says there is no undo, and it never runs on
/// a list the user did not tick: an empty `paths` is refused by the service
/// rather than treated as "all of them". Folders and anything on the public
/// desktop are refused there too, whatever the frontend sends.
#[tauri::command]
pub fn delete_desktop_items(
    app: AppHandle,
    db: State<DbConnection>,
    paths: Vec<String>,
) -> Result<ActionReport, String> {
    let report =
        desktop::delete_items(&desktop_roots(&app), &paths).map_err(|error| error.to_string())?;
    cleanup_actions::note(
        &db,
        CleanupUtility::Desktop,
        CleanupAction::Delete,
        report.succeeded,
    );
    Ok(report)
}

/// Opens one item with whatever the OS opens it with.
///
/// Not part of section 67's chain — it changes nothing — but it is most of how
/// somebody decides. "Is this the shortcut I still use?" is answered by
/// looking, and having to leave the app to look is how a review gets abandoned
/// half-finished. Guarded by the same [`desktop::resolve_item`] check the
/// destructive commands use, so this cannot become a way to launch an
/// arbitrary path.
#[tauri::command]
pub fn open_desktop_item(app: AppHandle, path: String) -> Result<(), String> {
    let resolved =
        desktop::resolve_item(&desktop_roots(&app), &path).map_err(|error| error.to_string())?;

    tauri_plugin_opener::open_path(resolved.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| format!("Could not open {path}: {error}"))
}

/// Shows one item in the OS file manager.
///
/// The other half of "let me look first", and the safer of the two for a
/// shortcut: revealing a `.lnk` shows the shortcut, where opening one runs
/// whatever it points at.
#[tauri::command]
pub fn reveal_desktop_item(app: AppHandle, path: String) -> Result<(), String> {
    let resolved =
        desktop::resolve_item(&desktop_roots(&app), &path).map_err(|error| error.to_string())?;

    tauri_plugin_opener::reveal_item_in_dir(&resolved)
        .map_err(|error| format!("Could not show {path} in the file manager: {error}"))
}

/// The desktops to read, in the order they are reported.
///
/// Two of them, because Windows composites both into the one surface the user
/// is looking at:
///
/// * the signed-in user's own Desktop, from Tauri's path resolver, which is
///   the only folder anything is ever done to;
/// * the Public (All Users) Desktop, from `%PUBLIC%` with the standard
///   location as a fallback — read and labelled so the scan agrees with what
///   is on screen, and refused by the service for every action, because
///   writing there needs elevation this app does not ask for.
///
/// A folder that is not there is simply left off the list and the scan reports
/// it as missing, which is the normal case for the public desktop off Windows.
/// Duplicates are dropped: a redirected or roamed Desktop can make both
/// entries the same folder, and a second copy of every item under a second
/// label would be a confusing way to say "there is only one".
fn desktop_roots(app: &AppHandle) -> Vec<DesktopRoot> {
    let mut roots: Vec<DesktopRoot> = Vec::new();

    if let Ok(desktop) = app.path().desktop_dir() {
        push_root(&mut roots, "Desktop", desktop, DesktopRootKind::User);
    }

    if let Some(public) = public_desktop_dir() {
        push_root(
            &mut roots,
            "Public Desktop",
            public,
            DesktopRootKind::Public,
        );
    }

    roots
}

/// Where Windows keeps the desktop every account shares.
///
/// `%PUBLIC%` is what the OS itself uses and is what a redirected profile
/// updates, so it is read first; `C:\Users\Public` is the fallback for the
/// rare shell that does not set it. There is no equivalent anywhere else, so
/// off Windows this is simply `None` and the scan reports one desktop.
#[cfg(windows)]
fn public_desktop_dir() -> Option<PathBuf> {
    let public = std::env::var_os("PUBLIC")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Users\Public"));

    Some(public.join("Desktop"))
}

#[cfg(not(windows))]
fn public_desktop_dir() -> Option<PathBuf> {
    None
}

/// Adds a root unless the same folder is already on the list under another
/// name. Compared on the canonical path so a junction, a symlink or a
/// redirected profile folder resolves to whatever it actually points at.
fn push_root(roots: &mut Vec<DesktopRoot>, label: &str, path: PathBuf, kind: DesktopRootKind) {
    let key = canonical_key(&path);
    if roots.iter().any(|root| canonical_key(&root.path) == key) {
        return;
    }
    roots.push(DesktopRoot::new(label, path, kind));
}

/// The canonical form of `path`, or the path itself when it does not exist —
/// which still compares correctly against another spelling of the same
/// missing folder.
fn canonical_key(path: &PathBuf) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.clone())
}
