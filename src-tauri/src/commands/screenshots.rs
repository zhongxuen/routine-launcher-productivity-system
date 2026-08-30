//! Commands for the Screenshot Organizer (development-plan.md sections 38, 42
//! and 67).
//!
//! Thin, per section 86: [`services::screenshots`] holds every rule about what
//! a screenshot is and what may be moved. What lives here is the one thing it
//! cannot know — *where to look* — because "the Pictures folder" is a
//! different path on every OS and only Tauri's path resolver can answer it.
//!
//! The two commands are deliberately separate, and that separation is
//! section 67's flow made structural: [`scan_screenshots`] only reads, and
//! [`organize_screenshots`] only moves what it is explicitly handed. There is
//! no command that finds files and acts on them, so there is no path by which
//! opening the page can move anything.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::db::DbConnection;
use crate::services::screenshots::{
    self, LocalClock, OrganizeRequest, OrganizeResult, RootKind, ScanRoot, ScreenshotScan,
};

/// Finds the screenshots, and reports where it looked.
///
/// The database is touched once, for the local UTC offset, and the lock is
/// released before the walk starts — a scan can take a moment on a full
/// Pictures folder, and holding the shared connection across it would stall
/// every other query in the app for no reason.
#[tauri::command]
pub fn scan_screenshots(app: AppHandle, db: State<DbConnection>) -> Result<ScreenshotScan, String> {
    let clock = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        LocalClock::from_db(&conn).map_err(|e| e.to_string())?
    };

    Ok(screenshots::scan(
        &scan_roots(&app),
        clock,
        screenshots::now_epoch(),
    ))
}

/// Moves the files the user selected into the folder the user chose.
///
/// Called only after the confirmation step in the UI, and it does not take
/// that on trust: the service re-tests every path against the same roots the
/// scan used, so a path that did not come from a scan is skipped rather than
/// moved.
#[tauri::command]
pub fn organize_screenshots(
    app: AppHandle,
    db: State<DbConnection>,
    request: OrganizeRequest,
) -> Result<OrganizeResult, String> {
    let clock = {
        let conn = db.lock().map_err(|e| e.to_string())?;
        LocalClock::from_db(&conn).map_err(|e| e.to_string())?
    };

    screenshots::organize(&scan_roots(&app), clock, &request).map_err(|e| e.to_string())
}

/// Opens one screenshot with whatever the OS opens images with.
///
/// Not part of section 67's chain — it changes nothing — but it is most of
/// how somebody decides. A screenshot is a picture, and a list of filenames
/// is a poor way to tell one picture from another; having to leave the app to
/// look is how a review gets abandoned half-finished. Guarded by the same
/// check the move uses, so it cannot become a way to launch an arbitrary path.
#[tauri::command]
pub fn open_screenshot(app: AppHandle, path: String) -> Result<(), String> {
    let resolved = screenshots::resolve(&scan_roots(&app), &path).map_err(|e| e.to_string())?;

    tauri_plugin_opener::open_path(resolved.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| format!("Could not open {path}: {error}"))
}

/// Shows one screenshot in the OS file manager — the other half of "let me
/// look first", and the quicker one when what the user needs is the folder
/// rather than the picture.
#[tauri::command]
pub fn reveal_screenshot(app: AppHandle, path: String) -> Result<(), String> {
    let resolved = screenshots::resolve(&scan_roots(&app), &path).map_err(|e| e.to_string())?;

    tauri_plugin_opener::reveal_item_in_dir(&resolved)
        .map_err(|error| format!("Could not show {path} in the file manager: {error}"))
}

/// Where the folder picker should open: the user's screenshots folder if
/// there is one, otherwise Pictures. Only a suggestion — the picker is what
/// decides, and `null` simply means "open wherever you normally would".
#[tauri::command]
pub fn default_screenshot_destination(app: AppHandle) -> Option<String> {
    let pictures = app.path().picture_dir().ok()?;
    let screenshots = pictures.join("Screenshots");
    let suggestion = if screenshots.is_dir() { screenshots } else { pictures };
    Some(suggestion.to_string_lossy().into_owned())
}

/// The folders a screenshot plausibly lands in, in the order they are
/// reported.
///
/// Two groups, and which group a folder is in decides how it is read (see
/// [`RootKind`]):
///
/// * **Screenshot folders** — Windows' `Pictures\Screenshots`, macOS's
///   `Screen Shots`, the copy OneDrive keeps when it has redirected Pictures,
///   and the Xbox Game Bar's `Videos\Captures`. Everything image-shaped inside
///   counts, subfolders included, because that is all these folders are for.
/// * **General folders** — Desktop (macOS's default capture location, and
///   where a lot of Windows users drop them), Pictures itself, and Downloads
///   (where a browser's capture extension puts them). Read at the top level
///   only, and only files whose *names* say screenshot.
///
/// A folder that does not exist is not a problem and is still listed: the scan
/// reports it as "not found", so the user can see the tool looked rather than
/// wonder whether it did. Duplicates are dropped here — OneDrive redirection
/// routinely makes `picture_dir()` and `~/OneDrive/Pictures` the same folder,
/// and a line reporting zero matches because it is a second name for the line
/// above it would be a confusing way to say "nothing more to see".
fn scan_roots(app: &AppHandle) -> Vec<ScanRoot> {
    let resolver = app.path();
    let pictures = resolver.picture_dir().ok();
    let mut roots: Vec<ScanRoot> = Vec::new();

    if let Some(pictures) = &pictures {
        push_root(
            &mut roots,
            "Screenshots",
            pictures.join("Screenshots"),
            RootKind::ScreenshotFolder,
        );
        push_root(
            &mut roots,
            "Screen Shots",
            pictures.join("Screen Shots"),
            RootKind::ScreenshotFolder,
        );
    }

    if let Ok(home) = resolver.home_dir() {
        push_root(
            &mut roots,
            "OneDrive screenshots",
            home.join("OneDrive").join("Pictures").join("Screenshots"),
            RootKind::ScreenshotFolder,
        );
    }

    if let Ok(videos) = resolver.video_dir() {
        push_root(
            &mut roots,
            "Game captures",
            videos.join("Captures"),
            RootKind::ScreenshotFolder,
        );
    }

    if let Ok(desktop) = resolver.desktop_dir() {
        push_root(&mut roots, "Desktop", desktop, RootKind::General);
    }

    if let Some(pictures) = pictures {
        push_root(&mut roots, "Pictures", pictures, RootKind::General);
    }

    if let Ok(downloads) = resolver.download_dir() {
        push_root(&mut roots, "Downloads", downloads, RootKind::General);
    }

    roots
}

/// Adds a root unless the same folder is already on the list under another
/// name. Compared on the canonical path so a junction, a symlink or a
/// redirected library folder resolves to whatever it actually points at.
fn push_root(roots: &mut Vec<ScanRoot>, label: &str, path: PathBuf, kind: RootKind) {
    let key = canonical_key(&path);
    if roots.iter().any(|root| canonical_key(&root.path) == key) {
        return;
    }
    roots.push(ScanRoot::new(label, path, kind));
}

/// The canonical form of `path`, or the path itself when it does not exist —
/// which is the common case here and still compares correctly against another
/// spelling of the same missing folder.
fn canonical_key(path: &PathBuf) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.clone())
}
