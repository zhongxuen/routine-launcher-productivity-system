//! Desktop Cleanup (development-plan.md sections 38, 66, 67, 81).
//!
//! ```text
//! DESKTOP
//!
//! Items:
//! 84
//!
//! Kinds:
//!
//! Shortcuts    31
//! Folders       6
//! Images       19
//! Documents    14
//! Archives      3
//! Installers    2
//! Other         9
//!
//! Age:
//!
//! Today         4
//! This week    11
//! This month   23
//! Older        46
//!
//! Largest:
//! 1.9 GB
//!
//! [ Review Desktop ]
//! ```
//!
//! Section 81's fifth utility, and the sibling of [`super::downloads`]: the
//! same shape, the same order, the same refusal to act on anything it was not
//! handed. What differs is what a desktop *is*, and that difference is the
//! whole of this module's reason to exist.
//!
//! ---------------------------------------------------------------------------
//! THE ORDER THIS MODULE EXISTS TO ENFORCE
//!
//! Section 67 states the rule the whole utility is built around:
//!
//! ```text
//! Scan -> Show results -> User selects files -> Confirm -> Perform action
//! ```
//!
//! Nothing here deletes or moves anything on its own. [`scan`] is pure
//! reading — it opens no file and changes nothing on disk — and it is the
//! only function the UI calls without being asked to. [`move_items`] and
//! [`delete_items`] each take an explicit list of paths, refuse an empty one,
//! and are only ever reached from a confirmation the user clicked through.
//! There is deliberately no "clean up the desktop" entry point for a quest, a
//! schedule or a tray item to call: section 67's "destructive actions must
//! always be user initiated" is kept by there being no other way in.
//!
//! ---------------------------------------------------------------------------
//! WHAT A DESKTOP HAS THAT A DOWNLOADS FOLDER DOES NOT
//!
//! **Shortcuts.** Most of what is on a desktop is `.lnk` and `.url` files, and
//! they are not the thing they point at. A shortcut is reported at its own
//! size — a couple of kilobytes — never the size of its target, so a link to a
//! 40 GB game does not become the "Largest" line. Nothing here reads the
//! inside of a shortcut, and no action ever follows one: deleting a shortcut
//! deletes the shortcut, which is what somebody clearing their desktop means.
//!
//! **Folders.** People arrange their desktop on purpose, and a folder there is
//! usually the arrangement rather than the mess. Folders are listed, with a
//! count of what is directly inside them, and that is all: the scan does not
//! descend into one to bucket its contents, and [`resolve_item`] refuses a
//! folder outright, so neither action can reach one. A cleanup tool that could
//! remove a folder tree from a checkbox is a different, much more dangerous
//! tool than the one section 38 asks for.
//!
//! **Age.** On a desktop, how long something has been sitting there is most of
//! how somebody decides about it, far more than its extension is. Every item
//! is bucketed into Today / This week / This month / Older against the same
//! rolling windows [`super::screenshots`] uses — the clock is literally that
//! module's, so "today" means one thing across the whole app.
//!
//! **Two desktops.** Windows composites the per-user Desktop and the
//! Public (All Users) Desktop into the one surface the user sees, so a scan
//! that read only the first would disagree with what is on screen. Both are
//! read and each item says which it came from. Only the per-user one is
//! actionable: writing to the public desktop needs elevation this app does not
//! ask for, and a delete that fails with an OS permission error after the user
//! confirmed it is worse than a row that says up front it cannot be touched.
//!
//! ---------------------------------------------------------------------------
//! WHY THE PATHS ARE CHECKED AGAIN HERE
//!
//! The frontend hands back the same paths [`scan`] gave it, so it is tempting
//! to trust them. This module does not. Every path an action touches goes
//! through [`resolve_item`] first, which re-reads it from disk and refuses
//! anything that is not a plain file sitting directly on the user's own
//! Desktop — no folders, no symlinks, no reparse points, nothing reached by
//! `..`, nothing on the public desktop, nothing outside Desktop at all, and
//! nothing whose name Windows would not accept in the first place.
//!
//! That is section 66 applied to filesystem calls rather than to shell
//! commands: a bug in a React component, or a stale list from a scan taken ten
//! minutes ago, must not be able to turn "delete these four shortcuts" into a
//! delete somewhere else on the disk. The check costs one `stat` per file and
//! removes the entire class of mistake.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use super::error::{ServiceError, ServiceResult};
use super::screenshots::{DateWindows, LocalClock};

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

/// What one thing on the desktop is.
///
/// The five buckets of section 39's Downloads mockup, plus the two a desktop
/// has and a downloads folder does not. The wire values are the lowercase
/// names, and `src/types/desktop.ts` declares exactly the same seven strings —
/// a kind is called the same thing here, across `invoke`, and in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopKind {
    /// A `.lnk` or `.url` file. Reported at its own size, never its target's.
    Shortcut,
    /// A folder. Counted, never descended into, never actionable.
    Folder,
    Image,
    Document,
    Archive,
    Installer,
    Other,
}

impl DesktopKind {
    /// The label the summary prints, sent along so the UI does not keep a
    /// second copy of the same seven words.
    pub fn label(self) -> &'static str {
        match self {
            Self::Shortcut => "Shortcuts",
            Self::Folder => "Folders",
            Self::Image => "Images",
            Self::Document => "Documents",
            Self::Archive => "Archives",
            Self::Installer => "Installers",
            Self::Other => "Other",
        }
    }

    /// Whether an action may ever be offered on this kind.
    ///
    /// Folders are the one `false`, and it is the only place that rule is
    /// written: [`resolve_item`] enforces it on the way in, the summary reads
    /// it to say folders were left alone, and the review reads it to draw the
    /// row without a checkbox.
    pub fn is_actionable(self) -> bool {
        !matches!(self, Self::Folder)
    }
}

/// Summary order: what a desktop is mostly made of first, then the file kinds
/// in the order section 39 prints them. All seven are always listed, empty
/// ones included, so the shape of the panel does not change between scans.
const KIND_ORDER: [DesktopKind; 7] = [
    DesktopKind::Shortcut,
    DesktopKind::Folder,
    DesktopKind::Image,
    DesktopKind::Document,
    DesktopKind::Archive,
    DesktopKind::Installer,
    DesktopKind::Other,
];

/// The two extensions Windows uses for "this is a link to something else".
///
/// Deliberately not a general "is this a link" test: a `.lnk` is an ordinary
/// file on disk that happens to contain a path, so it is read, sized and
/// deleted as itself. Real symlinks, junctions and other reparse points are a
/// different thing entirely and are refused rather than bucketed — see
/// [`is_reparse_point`].
const SHORTCUT_EXTENSIONS: &[&str] = &["lnk", "url", "website"];

const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "heic", "heif", "tif", "tiff", "ico",
    "avif", "raw", "cr2", "nef", "psd",
];

const DOCUMENT_EXTENSIONS: &[&str] = &[
    "pdf", "doc", "docx", "odt", "rtf", "txt", "md", "xls", "xlsx", "ods", "csv", "ppt", "pptx",
    "odp", "epub", "mobi", "pages", "numbers", "key", "tex",
];

const ARCHIVE_EXTENSIONS: &[&str] = &[
    "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz", "xz", "zst", "lz", "lzma", "cab", "arj",
];

const INSTALLER_EXTENSIONS: &[&str] = &[
    "exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "dmg", "pkg", "deb", "rpm",
    "appimage", "apk", "iso", "img", "snap", "flatpak",
];

/// Buckets a file by its extension, case-insensitively. A file with no
/// extension at all is `Other`.
///
/// Only ever called for things that are already known to be files — a folder's
/// kind is decided by its being a folder, not by whatever is after the last
/// dot in its name.
pub fn categorize(extension: Option<&str>) -> DesktopKind {
    let Some(extension) = extension else {
        return DesktopKind::Other;
    };
    let extension = extension.to_ascii_lowercase();
    let extension = extension.as_str();

    if SHORTCUT_EXTENSIONS.contains(&extension) {
        DesktopKind::Shortcut
    } else if IMAGE_EXTENSIONS.contains(&extension) {
        DesktopKind::Image
    } else if DOCUMENT_EXTENSIONS.contains(&extension) {
        DesktopKind::Document
    } else if ARCHIVE_EXTENSIONS.contains(&extension) {
        DesktopKind::Archive
    } else if INSTALLER_EXTENSIONS.contains(&extension) {
        DesktopKind::Installer
    } else {
        DesktopKind::Other
    }
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

/// How long something has been sitting on the desktop.
///
/// The same four rolling windows [`super::screenshots`] buckets into, computed
/// from the same [`LocalClock`], because two panels in one app that both say
/// "Today" and disagree about where today starts is a bug the user cannot
/// diagnose. Each item lands in the *narrowest* bucket that contains it, so
/// the four counts add up to the item count rather than nesting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgeBucket {
    Today,
    ThisWeek,
    ThisMonth,
    /// Older than a month, and the bucket a desktop cleanup is usually about.
    Older,
}

impl AgeBucket {
    pub fn label(self) -> &'static str {
        match self {
            Self::Today => "Today",
            Self::ThisWeek => "This week",
            Self::ThisMonth => "This month",
            Self::Older => "Older",
        }
    }
}

const AGE_ORDER: [AgeBucket; 4] = [
    AgeBucket::Today,
    AgeBucket::ThisWeek,
    AgeBucket::ThisMonth,
    AgeBucket::Older,
];

/// Which window `modified` falls in.
///
/// A filesystem that would not report a modification time gives `0`, which
/// falls before every boundary and so buckets as `Older` — the same answer
/// [`super::screenshots`] gives, and the honest one: an item whose age is
/// unknown is not one we may call recent.
fn bucket_age(windows: DateWindows, modified: i64) -> AgeBucket {
    if modified >= windows.today_start {
        AgeBucket::Today
    } else if modified >= windows.week_start {
        AgeBucket::ThisWeek
    } else if modified >= windows.month_start {
        AgeBucket::ThisMonth
    } else {
        AgeBucket::Older
    }
}

// ---------------------------------------------------------------------------
// Where to look
// ---------------------------------------------------------------------------

/// Which of the two desktops a root is.
///
/// The distinction exists for exactly one reason: [`Public`](Self::Public) is
/// readable and not writable without elevation, so it may be shown and may
/// never be acted on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopRootKind {
    /// The signed-in user's own Desktop. The only one anything is done to.
    User,
    /// The Public / All Users Desktop, composited into the same screen by
    /// Windows. Read and labelled; never written.
    Public,
}

impl DesktopRootKind {
    fn is_actionable(self) -> bool {
        matches!(self, Self::User)
    }
}

/// One desktop folder to read.
///
/// Built by the command layer from Tauri's path resolver and the environment,
/// so this module never has to know what a desktop folder is called on any
/// particular OS — and so there is no argument the frontend can set that would
/// point a scan somewhere else.
#[derive(Debug, Clone)]
pub struct DesktopRoot {
    /// What the UI calls it: "Desktop", "Public Desktop".
    pub label: String,
    pub path: PathBuf,
    pub kind: DesktopRootKind,
}

impl DesktopRoot {
    pub fn new(label: impl Into<String>, path: PathBuf, kind: DesktopRootKind) -> Self {
        Self {
            label: label.into(),
            path,
            kind,
        }
    }
}

// ---------------------------------------------------------------------------
// What a scan produces
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DesktopItem {
    /// Absolute path. This is the handle the UI sends back for an action, and
    /// it is re-checked by [`resolve_item`] before anything happens to it.
    pub path: String,
    pub name: String,
    /// Lowercased, without the dot. `None` for a folder or a file that has
    /// none.
    pub extension: Option<String>,
    pub kind: DesktopKind,
    /// The item's own size. For a shortcut that is the size of the `.lnk`
    /// itself — a kilobyte or two — and never the size of what it points at.
    /// For a folder it is `0`: measuring a folder means walking it, and this
    /// scan does not walk folders.
    pub size_bytes: u64,
    /// How many things are directly inside, for a folder. `Some(0)` for an
    /// empty folder, `None` for a folder that could not be read and for
    /// everything that is not a folder.
    pub item_count: Option<usize>,
    /// Last-modified, in seconds since the Unix epoch, or `None` on a
    /// filesystem that would not say.
    pub modified_at: Option<i64>,
    pub age: AgeBucket,
    /// The [`DesktopRoot::label`] it was found under, so a row can say which
    /// of the two desktops it is really on.
    pub source: String,
    /// Whether Move and Delete may be offered for it at all.
    ///
    /// False for every folder and for everything on the public desktop. The
    /// UI draws those rows without a checkbox; [`resolve_item`] refuses them
    /// again regardless, because a disabled checkbox is a decision made in a
    /// component and this is a decision made where it counts.
    pub actionable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct KindCount {
    pub kind: DesktopKind,
    /// The summary's label, sent by Rust so it is written once.
    pub label: &'static str,
    pub count: usize,
    /// Total size of the items in this bucket. Always `0` for folders, which
    /// are not measured.
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgeCount {
    pub age: AgeBucket,
    pub label: &'static str,
    pub count: usize,
    pub size_bytes: u64,
}

/// One desktop folder's contribution, reported whether or not it produced
/// anything — a tool that says "84 items" without saying where it looked is
/// impossible to trust or to debug, and on a machine with no public desktop
/// the honest answer is "there isn't one" rather than silence.
#[derive(Debug, Clone, Serialize)]
pub struct DesktopSource {
    pub label: String,
    pub path: String,
    pub kind: DesktopRootKind,
    /// False when the folder is simply not there. Normal for the public
    /// desktop off Windows.
    pub exists: bool,
    /// Whether anything found here can be moved or deleted.
    pub actionable: bool,
    pub item_count: usize,
    /// Why the folder could not be read. `None` when it read fine, or when it
    /// does not exist.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DesktopScan {
    /// Every folder that was looked in, in the order they were read.
    pub sources: Vec<DesktopSource>,
    /// Everything found, across both desktops.
    pub item_count: usize,
    /// Ordinary files: not shortcuts, not folders.
    pub file_count: usize,
    pub shortcut_count: usize,
    pub folder_count: usize,
    /// Bytes across everything that has a size — files and shortcuts. Folders
    /// contribute nothing, because they were not measured.
    pub total_bytes: u64,
    /// All seven kinds, in summary order, including empty ones.
    pub kinds: Vec<KindCount>,
    /// All four age windows, newest first, including empty ones.
    pub ages: Vec<AgeCount>,
    /// The largest thing on the desktop that has a size. `None` for a desktop
    /// holding nothing but folders.
    pub largest: Option<DesktopItem>,
    /// Everything found, largest first.
    pub items: Vec<DesktopItem>,
    /// Entries that could not be read, and entries that are symlinks,
    /// junctions or other reparse points. Reported, never listed, never
    /// fatal: one locked item is not a reason to refuse to show the other
    /// eighty.
    pub unreadable_count: usize,
}

// ---------------------------------------------------------------------------
// What an action produces
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ItemActionOutcome {
    pub path: String,
    pub name: String,
    pub ok: bool,
    /// A sentence worth showing the user. `None` when `ok`.
    pub error: Option<String>,
    /// Where the item ended up, for a move that worked. The destination
    /// filename can differ from the original — see [`unique_destination`].
    pub moved_to: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActionReport {
    pub succeeded: usize,
    pub failed: usize,
    /// Bytes actually moved or freed — the successes only, so the number the
    /// UI reports is one that really happened.
    pub bytes: u64,
    /// One entry per requested path, in the order they were requested, so a
    /// partial failure can name what it could not touch.
    pub outcomes: Vec<ItemActionOutcome>,
}

impl ActionReport {
    fn from_outcomes(outcomes: Vec<ItemActionOutcome>, bytes: u64) -> Self {
        let succeeded = outcomes.iter().filter(|outcome| outcome.ok).count();
        Self {
            succeeded,
            failed: outcomes.len() - succeeded,
            bytes,
            outcomes,
        }
    }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/// Reads the top level of every desktop folder in `roots` and describes what
/// is on them.
///
/// Pure reading: nothing is opened, changed, moved or removed. This is step
/// one of section 67's order and the only step that happens without the user
/// having selected anything.
///
/// It returns a scan rather than a `Result`, because "the public desktop is
/// not there" is the normal case rather than a failure, and a machine where
/// one of two folders will not open should still be told about the other.
/// Every folder that failed says so in [`DesktopScan::sources`].
pub fn scan(roots: &[DesktopRoot], clock: LocalClock, now: i64) -> DesktopScan {
    let windows = clock.windows(now);

    let mut items: Vec<DesktopItem> = Vec::new();
    let mut sources: Vec<DesktopSource> = Vec::new();
    let mut unreadable_count = 0usize;

    for root in roots {
        let path = root.path.to_string_lossy().into_owned();

        if !root.path.is_dir() {
            sources.push(DesktopSource {
                label: root.label.clone(),
                path,
                kind: root.kind,
                exists: false,
                actionable: root.kind.is_actionable(),
                item_count: 0,
                error: None,
            });
            continue;
        }

        let entries = match fs::read_dir(&root.path) {
            Ok(entries) => entries,
            Err(error) => {
                sources.push(DesktopSource {
                    label: root.label.clone(),
                    path,
                    kind: root.kind,
                    exists: true,
                    actionable: root.kind.is_actionable(),
                    item_count: 0,
                    error: Some(format!("Could not read it: {error}")),
                });
                continue;
            }
        };

        let before = items.len();

        for entry in entries {
            let Ok(entry) = entry else {
                unreadable_count += 1;
                continue;
            };

            // `DirEntry::metadata` does not follow links, so a `.lnk` is
            // described as the small file it is rather than as whatever it
            // points at — which keeps a link to a 40 GB folder out of the
            // "Largest" line, and keeps the target out of reach of anything
            // below.
            let Ok(metadata) = entry.metadata() else {
                unreadable_count += 1;
                continue;
            };

            // A symlink, junction or any other reparse point is a second name
            // for something that lives elsewhere. It is counted and then
            // dropped: it is not listed, so it can never be ticked, so no
            // action can be aimed through it at whatever is on the far side.
            if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                unreadable_count += 1;
                continue;
            }

            let path = entry.path();
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();

            let (kind, extension, size_bytes, item_count) = if metadata.is_dir() {
                // One `read_dir` to say how big the folder is in items. Not a
                // walk: what is inside those entries is never looked at, never
                // bucketed and never actionable.
                (DesktopKind::Folder, None, 0, Some(count_children(&path)))
            } else if metadata.is_file() {
                let extension = path
                    .extension()
                    .map(|extension| extension.to_string_lossy().to_ascii_lowercase());
                (
                    categorize(extension.as_deref()),
                    extension,
                    metadata.len(),
                    None,
                )
            } else {
                // A device, a socket, a FIFO. Not something on a desktop that
                // this tool has any business offering to delete.
                unreadable_count += 1;
                continue;
            };

            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|since| since.as_secs() as i64);

            items.push(DesktopItem {
                path: path.to_string_lossy().into_owned(),
                name,
                extension,
                kind,
                size_bytes,
                item_count,
                modified_at,
                age: bucket_age(windows, modified_at.unwrap_or(0)),
                source: root.label.clone(),
                actionable: root.kind.is_actionable() && kind.is_actionable(),
            });
        }

        sources.push(DesktopSource {
            label: root.label.clone(),
            path,
            kind: root.kind,
            exists: true,
            actionable: root.kind.is_actionable(),
            item_count: items.len() - before,
            error: None,
        });
    }

    // Largest first, then by name so two items of the same size do not swap
    // places between scans. Folders carry no size and so settle at the end,
    // in alphabetical order, which is where a list of things nobody can act on
    // belongs.
    items.sort_by(|left, right| {
        right
            .size_bytes
            .cmp(&left.size_bytes)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    let kinds = KIND_ORDER
        .iter()
        .map(|&kind| {
            let (count, size_bytes) = items
                .iter()
                .filter(|item| item.kind == kind)
                .fold((0usize, 0u64), |(count, bytes), item| {
                    (count + 1, bytes + item.size_bytes)
                });
            KindCount {
                kind,
                label: kind.label(),
                count,
                size_bytes,
            }
        })
        .collect();

    let ages = AGE_ORDER
        .iter()
        .map(|&age| {
            let (count, size_bytes) = items
                .iter()
                .filter(|item| item.age == age)
                .fold((0usize, 0u64), |(count, bytes), item| {
                    (count + 1, bytes + item.size_bytes)
                });
            AgeCount {
                age,
                label: age.label(),
                count,
                size_bytes,
            }
        })
        .collect();

    let count_of = |kind: DesktopKind| items.iter().filter(|item| item.kind == kind).count();
    let folder_count = count_of(DesktopKind::Folder);
    let shortcut_count = count_of(DesktopKind::Shortcut);

    DesktopScan {
        sources,
        item_count: items.len(),
        file_count: items.len() - folder_count - shortcut_count,
        shortcut_count,
        folder_count,
        total_bytes: items.iter().map(|item| item.size_bytes).sum(),
        kinds,
        ages,
        // The list is sorted largest first, so the first thing that has a size
        // at all is the summary's "Largest". Folders are skipped rather than
        // reported as 0 bytes: they were never measured, and saying "largest:
        // 0 KB, Projects" would be a lie about a folder that may hold gigabytes.
        largest: items
            .iter()
            .find(|item| item.kind != DesktopKind::Folder)
            .cloned(),
        items,
        unreadable_count,
    }
}

/// How many things are directly inside `folder`.
///
/// One level, and it is not a walk: the entries are counted, not opened, not
/// stat-ed and not looked inside. A folder that will not open counts as `0`
/// rather than failing the scan — the row still says what it is, and no action
/// can reach it either way.
fn count_children(folder: &Path) -> usize {
    fs::read_dir(folder)
        .map(|entries| entries.count())
        .unwrap_or(0)
}

/// Whether `metadata` describes a reparse point — a junction, a mount point,
/// a OneDrive placeholder's stand-in, or anything else Windows resolves
/// elsewhere at open time.
///
/// `is_symlink` catches the ordinary symlink on every platform; this catches
/// the Windows-specific rest. A junction on the desktop pointing at
/// `C:\Windows` looks exactly like a folder to `is_dir`, and a tool that
/// treated it as one would be a tool that can be aimed anywhere.
#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    /// `FILE_ATTRIBUTE_REPARSE_POINT`, from `winnt.h`.
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// Off Windows there is no such attribute, and `is_symlink` has already
/// answered the question.
#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

// ---------------------------------------------------------------------------
// Names Windows will not have
// ---------------------------------------------------------------------------

/// The characters Windows reserves in a filename. `/` and `\` are separators,
/// so a "name" containing one is a path being passed off as a name.
const RESERVED_CHARACTERS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// The DOS device names, still reserved. `CON`, `NUL` and friends refer to
/// devices whatever folder they appear to be in, with or without an extension.
const RESERVED_DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Refuses a filename Windows does not allow, before it is ever handed to the
/// filesystem.
///
/// Such a name cannot be the name of a real item on the desktop — the scan
/// could not have produced it, because the file could not have been created —
/// so a path carrying one arrived from somewhere other than a scan. That is
/// worth refusing loudly and by name rather than letting it fall through to a
/// "file not found" that reads like an ordinary stale-list error.
///
/// Checked on every platform, not only Windows: the rule is about what this
/// app will act on, and a build that quietly enforced less would be a build
/// whose tests proved less.
fn refuse_unusable_name(name: &str) -> ServiceResult<()> {
    let refuse = |reason: &str| {
        Err(ServiceError::validation(format!(
            "{name} is not a name Windows allows ({reason}), so it was left alone."
        )))
    };

    if name.is_empty() {
        return refuse("it is empty");
    }
    if name.chars().any(|c| RESERVED_CHARACTERS.contains(&c)) {
        return refuse("it contains one of < > : \" / \\ | ? *");
    }
    if name.chars().any(|c| (c as u32) < 0x20) {
        return refuse("it contains a control character");
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return refuse("it ends with a dot or a space");
    }

    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if RESERVED_DEVICE_NAMES.contains(&stem.as_str()) {
        return refuse("it is a reserved device name");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// The guard every action goes through
// ---------------------------------------------------------------------------

/// Re-reads `path` and answers with it only if it is still a plain file
/// sitting directly on a desktop this app is allowed to write to.
///
/// Seven ways this says no, and each is a way an action could otherwise touch
/// something it was never shown:
///
/// * the name is not one Windows would accept, so it did not come from a scan;
/// * the item is gone (deleted, or moved, since the scan);
/// * it is a folder — this utility never acts on folder trees;
/// * it is a symlink or a reparse point, which would let a link on the desktop
///   stand in for anything anywhere on the disk;
/// * it is not an ordinary file at all;
/// * it does not sit directly in one of the desktop folders that were scanned,
///   which is what stops `..` and an absolute path from somewhere else;
/// * it is on the public desktop, which needs elevation this app does not ask
///   for and so is read-only here by policy as well as by permission.
pub fn resolve_item(roots: &[DesktopRoot], path: &str) -> ServiceResult<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(ServiceError::validation("No file was named."));
    }

    let candidate = PathBuf::from(trimmed);

    refuse_unusable_name(&file_name_of(trimmed))?;

    let metadata = fs::symlink_metadata(&candidate).map_err(|_| {
        ServiceError::not_found(format!("{trimmed} is no longer there — run the scan again."))
    })?;

    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(ServiceError::validation(format!(
            "{trimmed} is a link to something elsewhere, not a file on your desktop, so it was left alone."
        )));
    }

    if metadata.is_dir() {
        return Err(ServiceError::validation(format!(
            "{trimmed} is a folder. Desktop Cleanup lists folders but never acts on them — move or delete it in Explorer if that is what you want."
        )));
    }

    if !metadata.is_file() {
        return Err(ServiceError::validation(format!(
            "{trimmed} is not an ordinary file, so it was left alone."
        )));
    }

    // Canonicalising both sides is what makes the comparison meaningful:
    // `C:\Users\me\Desktop\..\Documents\tax.pdf` and a short 8.3 path both
    // become the real location before they are compared.
    let resolved = fs::canonicalize(&candidate)
        .map_err(|_| ServiceError::not_found(format!("{trimmed} is no longer there.")))?;
    let parent = resolved.parent().map(Path::to_path_buf);

    for root in roots {
        let Ok(root_path) = fs::canonicalize(&root.path) else {
            continue;
        };
        if parent.as_deref() != Some(root_path.as_path()) {
            continue;
        }

        if !root.kind.is_actionable() {
            return Err(ServiceError::validation(format!(
                "{trimmed} is on the {} and is shared with everyone who uses this computer. Changing it needs administrator rights this app does not ask for, so it was left alone.",
                root.label
            )));
        }

        return Ok(resolved);
    }

    Err(ServiceError::validation(format!(
        "{trimmed} is not on your desktop — it was left alone."
    )))
}

/// Checks the folder a move is aimed at: it has to exist, be a directory, not
/// be one of the desktops themselves, and not be anywhere on the public one.
///
/// A subfolder of the user's own Desktop is allowed on purpose — "move these
/// into Desktop\Archive" is the most common desktop tidy there is, and
/// refusing it would push the user back into Explorer for the one case the
/// tool is best at.
fn resolve_destination(roots: &[DesktopRoot], destination: &str) -> ServiceResult<PathBuf> {
    let trimmed = destination.trim();
    if trimmed.is_empty() {
        return Err(ServiceError::validation(
            "Choose a folder to move the items into.",
        ));
    }

    let resolved = fs::canonicalize(trimmed)
        .map_err(|_| ServiceError::not_found(format!("{trimmed} is not a folder that exists.")))?;

    if !resolved.is_dir() {
        return Err(ServiceError::validation(format!(
            "{trimmed} is a file, not a folder."
        )));
    }

    for root in roots {
        let Ok(root_path) = fs::canonicalize(&root.path) else {
            continue;
        };

        if resolved == root_path {
            return Err(ServiceError::validation(format!(
                "Those items are already on the {}. Pick a different folder.",
                root.label
            )));
        }

        if !root.kind.is_actionable() && resolved.starts_with(&root_path) {
            return Err(ServiceError::validation(format!(
                "{trimmed} is inside the {}, which needs administrator rights this app does not ask for. Pick a folder of your own.",
                root.label
            )));
        }
    }

    Ok(resolved)
}

/// Refuses an empty selection and drops duplicates.
///
/// The empty check matters more than it looks: it is the difference between
/// "the user selected nothing and nothing happens" and a future caller
/// discovering that an empty list means everything.
fn selected_paths(paths: &[String]) -> ServiceResult<Vec<String>> {
    let mut seen = BTreeSet::new();
    let unique: Vec<String> = paths
        .iter()
        .map(|path| path.trim().to_owned())
        .filter(|path| !path.is_empty())
        .filter(|path| seen.insert(path.clone()))
        .collect();

    if unique.is_empty() {
        return Err(ServiceError::validation(
            "Select at least one item first — nothing was changed.",
        ));
    }

    Ok(unique)
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

/// Moves the selected items into `destination`.
///
/// The safe half of the pair, and the one the UI puts first: something that
/// turned out to be wanted after all is still there to be moved back.
///
/// Every item is attempted even if an earlier one failed, and the report names
/// each result — a locked file part-way down the list should not silently
/// abandon the rest of a selection the user made deliberately.
pub fn move_items(
    roots: &[DesktopRoot],
    paths: &[String],
    destination: &str,
) -> ServiceResult<ActionReport> {
    let paths = selected_paths(paths)?;
    let destination = resolve_destination(roots, destination)?;

    let mut outcomes = Vec::with_capacity(paths.len());
    let mut bytes = 0u64;

    for path in paths {
        let name = file_name_of(&path);

        let resolved = match resolve_item(roots, &path) {
            Ok(resolved) => resolved,
            Err(error) => {
                outcomes.push(failure(path, name, error.to_string()));
                continue;
            }
        };

        let size = fs::metadata(&resolved)
            .map(|metadata| metadata.len())
            .unwrap_or(0);

        let target = match unique_destination(&destination, &name) {
            Ok(target) => target,
            Err(error) => {
                outcomes.push(failure(path, name, error.to_string()));
                continue;
            }
        };

        match move_one(&resolved, &target) {
            Ok(()) => {
                bytes += size;
                outcomes.push(ItemActionOutcome {
                    path,
                    name,
                    ok: true,
                    error: None,
                    moved_to: Some(target.to_string_lossy().into_owned()),
                });
            }
            Err(error) => outcomes.push(failure(path, name, error)),
        }
    }

    Ok(ActionReport::from_outcomes(outcomes, bytes))
}

/// Renames, and copies-then-removes when a rename cannot cross the boundary
/// between two volumes — which is the ordinary case for "move this to the
/// external drive".
///
/// If the copy lands but the original will not go, the item is reported as a
/// failure and the copy is left in place. That is deliberate: the user now has
/// both, which is recoverable, whereas removing a copy we are not certain of
/// would not be.
fn move_one(source: &Path, target: &Path) -> Result<(), String> {
    if fs::rename(source, target).is_ok() {
        return Ok(());
    }

    fs::copy(source, target).map_err(|error| format!("Could not move it: {error}"))?;

    fs::remove_file(source).map_err(|error| {
        format!(
            "Copied to {} but the original could not be removed: {error}",
            target.to_string_lossy()
        )
    })
}

/// Picks a filename in `directory` that is not taken, appending ` (1)`,
/// ` (2)` … before the extension the way a browser's download does.
///
/// A move must never overwrite something already in the destination: the file
/// standing in the way was not part of what the user selected, so it is not
/// something this tool may touch.
fn unique_destination(directory: &Path, name: &str) -> ServiceResult<PathBuf> {
    let candidate = directory.join(name);
    if !candidate.exists() {
        return Ok(candidate);
    }

    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_owned());
    let extension = path
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();

    for suffix in 1..=1000 {
        let candidate = directory.join(format!("{stem} ({suffix}){extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(ServiceError::validation(format!(
        "{name} already exists in that folder, and so do a thousand renamed copies of it."
    )))
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/// Deletes the selected items, permanently.
///
/// The end of section 67's chain. It is reachable from exactly one place — the
/// confirmation step of the review flow, with a list the user ticked — and it
/// has no scheduled, quest-driven or "tidy up automatically" caller, by design.
///
/// A shortcut deleted here is the shortcut, never its target: [`resolve_item`]
/// hands back a plain file and `remove_file` unlinks that file, so removing a
/// `.lnk` for an app leaves the app exactly where it was.
///
/// There is no undo, which is why the UI says so on the confirmation and why
/// Move is offered beside it.
pub fn delete_items(roots: &[DesktopRoot], paths: &[String]) -> ServiceResult<ActionReport> {
    let paths = selected_paths(paths)?;

    let mut outcomes = Vec::with_capacity(paths.len());
    let mut bytes = 0u64;

    for path in paths {
        let name = file_name_of(&path);

        let resolved = match resolve_item(roots, &path) {
            Ok(resolved) => resolved,
            Err(error) => {
                outcomes.push(failure(path, name, error.to_string()));
                continue;
            }
        };

        let size = fs::metadata(&resolved)
            .map(|metadata| metadata.len())
            .unwrap_or(0);

        match fs::remove_file(&resolved) {
            Ok(()) => {
                bytes += size;
                outcomes.push(ItemActionOutcome {
                    path,
                    name,
                    ok: true,
                    error: None,
                    moved_to: None,
                });
            }
            Err(error) => outcomes.push(failure(path, name, format!("Could not delete it: {error}"))),
        }
    }

    Ok(ActionReport::from_outcomes(outcomes, bytes))
}

/// One refused or failed item, said the same way wherever it happened.
fn failure(path: String, name: String, error: String) -> ItemActionOutcome {
    ItemActionOutcome {
        path,
        name,
        ok: false,
        error: Some(error),
        moved_to: None,
    }
}

/// The trailing component of a path, for reporting on something that may not
/// resolve. Falls back to the whole string rather than to an empty one, so an
/// error message always names something.
fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A clock at UTC, so every timestamp in these tests is the number it
    /// looks like. The offset itself is `screenshots`' business and is tested
    /// there.
    fn clock() -> LocalClock {
        LocalClock::new(0)
    }

    /// Midday, so "yesterday" and "today" are a clear half-day apart rather
    /// than a rounding error either side of midnight.
    const NOW: i64 = 1_780_000_000;

    const DAY: i64 = 86_400;

    #[test]
    fn categorizes_by_extension_case_insensitively() {
        assert_eq!(categorize(Some("LNK")), DesktopKind::Shortcut);
        assert_eq!(categorize(Some("url")), DesktopKind::Shortcut);
        assert_eq!(categorize(Some("PNG")), DesktopKind::Image);
        assert_eq!(categorize(Some("pdf")), DesktopKind::Document);
        assert_eq!(categorize(Some("zip")), DesktopKind::Archive);
        assert_eq!(categorize(Some("msi")), DesktopKind::Installer);
        assert_eq!(categorize(Some("weird")), DesktopKind::Other);
        assert_eq!(categorize(None), DesktopKind::Other);
    }

    #[test]
    fn only_folders_are_unactionable_by_kind() {
        assert!(!DesktopKind::Folder.is_actionable());
        assert!(DesktopKind::Shortcut.is_actionable());
        assert!(DesktopKind::Other.is_actionable());
    }

    #[test]
    fn ages_bucket_into_the_narrowest_window_that_holds_them() {
        let windows = clock().windows(NOW);

        assert_eq!(bucket_age(windows, NOW), AgeBucket::Today);
        assert_eq!(bucket_age(windows, windows.today_start), AgeBucket::Today);
        assert_eq!(bucket_age(windows, windows.today_start - 1), AgeBucket::ThisWeek);
        assert_eq!(bucket_age(windows, windows.week_start - 1), AgeBucket::ThisMonth);
        assert_eq!(bucket_age(windows, windows.month_start - 1), AgeBucket::Older);
        // A filesystem that would not say buckets as Older rather than as
        // "recent", which is the only safe direction to be wrong in.
        assert_eq!(bucket_age(windows, 0), AgeBucket::Older);
    }

    #[test]
    fn an_empty_selection_is_refused() {
        assert!(selected_paths(&[]).is_err());
        assert!(selected_paths(&["  ".to_string()]).is_err());
    }

    #[test]
    fn duplicate_paths_are_collapsed() {
        let paths = vec!["a.lnk".to_string(), "a.lnk".to_string(), "b.lnk".to_string()];
        assert_eq!(selected_paths(&paths).unwrap().len(), 2);
    }

    #[test]
    fn names_windows_does_not_allow_are_named_as_such() {
        assert!(refuse_unusable_name("notes.txt").is_ok());
        assert!(refuse_unusable_name("a: b.txt").is_err());
        assert!(refuse_unusable_name("what?.txt").is_err());
        assert!(refuse_unusable_name("pipe|d").is_err());
        assert!(refuse_unusable_name("trailing.").is_err());
        assert!(refuse_unusable_name("trailing ").is_err());
        assert!(refuse_unusable_name("CON").is_err());
        assert!(refuse_unusable_name("nul.txt").is_err());
        assert!(refuse_unusable_name("").is_err());
    }

    // -----------------------------------------------------------------------
    // The tests below work on real files, in temporary folders of their own,
    // because everything worth being sure about here is what happens on disk:
    // that a scan describes both desktops correctly, that a shortcut and a
    // folder are reported as themselves, that an action touches what it was
    // given and nothing else, and — most of all — that a path from outside,
    // from the public desktop, or with a name that could not exist, is refused
    // rather than acted on.
    // -----------------------------------------------------------------------

    /// A private temp folder, removed when the test ends however it ends.
    struct TempFolder(PathBuf);

    impl TempFolder {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "routine-launcher-desktop-{}-{name}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("could not create the test folder");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn file(&self, name: &str, bytes: usize) -> String {
            let path = self.0.join(name);
            fs::write(&path, vec![b'x'; bytes]).expect("could not write the test file");
            path.to_string_lossy().into_owned()
        }

        /// A file with its last-modified time set to `epoch`, which is how the
        /// age buckets get something real to bucket.
        fn aged_file(&self, name: &str, bytes: usize, epoch: i64) -> String {
            let path = self.file(name, bytes);
            let handle = fs::File::options()
                .write(true)
                .open(&path)
                .expect("could not reopen the test file");
            let when = UNIX_EPOCH + std::time::Duration::from_secs(epoch as u64);
            handle
                .set_times(fs::FileTimes::new().set_modified(when))
                .expect("could not set the test file's modified time");
            path
        }

        fn dir(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(&path).expect("could not create the test sub-folder");
            path
        }
    }

    impl Drop for TempFolder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn user_root(folder: &TempFolder) -> DesktopRoot {
        DesktopRoot::new("Desktop", folder.path().to_path_buf(), DesktopRootKind::User)
    }

    fn public_root(folder: &TempFolder) -> DesktopRoot {
        DesktopRoot::new(
            "Public Desktop",
            folder.path().to_path_buf(),
            DesktopRootKind::Public,
        )
    }

    #[test]
    fn a_scan_buckets_by_kind_and_by_age_and_orders_by_size() {
        let folder = TempFolder::new("scan");
        folder.aged_file("app.lnk", 1_200, NOW);
        folder.aged_file("holiday.png", 9_000, NOW - 3 * DAY);
        folder.aged_file("invoice.pdf", 4_000, NOW - 12 * DAY);
        folder.aged_file("backup.zip", 20_000, NOW - 200 * DAY);
        folder.aged_file("setup.exe", 6_000, NOW - 200 * DAY);
        folder.aged_file("mystery.qqq", 500, NOW - 200 * DAY);
        let projects = folder.dir("Projects");
        fs::write(projects.join("one.txt"), b"a").expect("could not fill the sub-folder");
        fs::write(projects.join("two.txt"), b"b").expect("could not fill the sub-folder");

        let scan = scan(&[user_root(&folder)], clock(), NOW);

        assert_eq!(scan.item_count, 7);
        assert_eq!(scan.shortcut_count, 1);
        assert_eq!(scan.folder_count, 1);
        assert_eq!(scan.file_count, 5);
        assert_eq!(
            scan.total_bytes,
            40_700,
            "the folder contributes nothing, because it was never measured"
        );
        assert_eq!(scan.kinds.len(), 7, "all seven buckets, empty ones included");
        assert_eq!(scan.ages.len(), 4);

        let kind = |kind: DesktopKind| {
            scan.kinds
                .iter()
                .find(|entry| entry.kind == kind)
                .expect("every bucket is present")
                .count
        };
        assert_eq!(kind(DesktopKind::Shortcut), 1);
        assert_eq!(kind(DesktopKind::Folder), 1);
        assert_eq!(kind(DesktopKind::Image), 1);
        assert_eq!(kind(DesktopKind::Document), 1);
        assert_eq!(kind(DesktopKind::Archive), 1);
        assert_eq!(kind(DesktopKind::Installer), 1);
        assert_eq!(kind(DesktopKind::Other), 1);

        let age = |age: AgeBucket| {
            scan.ages
                .iter()
                .find(|entry| entry.age == age)
                .expect("every window is present")
                .count
        };
        // The shortcut was written now; the folder's own timestamp is now too,
        // because it was created during the test.
        assert_eq!(age(AgeBucket::Today), 2);
        assert_eq!(age(AgeBucket::ThisWeek), 1);
        assert_eq!(age(AgeBucket::ThisMonth), 1);
        assert_eq!(age(AgeBucket::Older), 3);

        assert_eq!(scan.largest.expect("a largest item").name, "backup.zip");
        assert_eq!(scan.items.first().expect("a first item").name, "backup.zip");
        assert_eq!(
            scan.items.last().expect("a last item").name,
            "Projects",
            "a folder carries no size and settles at the end"
        );
    }

    #[test]
    fn a_shortcut_is_reported_at_its_own_size_and_never_followed() {
        let folder = TempFolder::new("shortcut");
        // A `.lnk` is a small file whose contents happen to name something
        // enormous. Nothing here reads those contents.
        folder.file("Huge Game.lnk", 1_100);
        folder.file("Docs.url", 90);

        let scan = scan(&[user_root(&folder)], clock(), NOW);

        let shortcut = scan
            .items
            .iter()
            .find(|item| item.name == "Huge Game.lnk")
            .expect("the shortcut is listed");
        assert_eq!(shortcut.kind, DesktopKind::Shortcut);
        assert_eq!(shortcut.size_bytes, 1_100, "its own size, not its target's");
        assert!(shortcut.actionable, "a shortcut can be tidied away");
        assert_eq!(scan.shortcut_count, 2);
        assert_eq!(scan.total_bytes, 1_190);
    }

    #[test]
    fn a_folder_is_counted_never_descended_into_and_never_acted_on() {
        let folder = TempFolder::new("folder");
        let projects = folder.dir("Projects");
        fs::write(projects.join("a.png"), vec![b'x'; 5_000]).expect("could not fill it");
        fs::write(projects.join("b.png"), vec![b'x'; 5_000]).expect("could not fill it");
        fs::create_dir_all(projects.join("nested")).expect("could not nest");

        let scan = scan(&[user_root(&folder)], clock(), NOW);

        assert_eq!(scan.item_count, 1, "what is inside is not part of the scan");
        let listed = &scan.items[0];
        assert_eq!(listed.kind, DesktopKind::Folder);
        assert_eq!(listed.item_count, Some(3));
        assert_eq!(listed.size_bytes, 0);
        assert!(!listed.actionable);
        assert_eq!(
            scan.kinds
                .iter()
                .find(|entry| entry.kind == DesktopKind::Image)
                .expect("the images bucket is present")
                .count,
            0,
            "the images inside are never bucketed"
        );

        let report = delete_items(&[user_root(&folder)], std::slice::from_ref(&listed.path))
            .expect("the call still reports");
        assert_eq!(report.failed, 1);
        assert!(projects.is_dir(), "the folder is still there");
    }

    #[test]
    fn both_desktops_are_read_and_only_the_users_can_be_acted_on() {
        let user = TempFolder::new("user-desktop");
        let public = TempFolder::new("public-desktop");
        let mine = user.file("mine.txt", 10);
        let shared = public.file("Company Portal.lnk", 20);

        let roots = vec![user_root(&user), public_root(&public)];
        let scan = scan(&roots, clock(), NOW);

        assert_eq!(scan.item_count, 2, "both desktops are one desktop here");
        assert_eq!(scan.sources.len(), 2);
        assert_eq!(scan.sources[0].label, "Desktop");
        assert!(scan.sources[0].actionable);
        assert_eq!(scan.sources[1].label, "Public Desktop");
        assert!(!scan.sources[1].actionable);

        let listed = |name: &str| {
            scan.items
                .iter()
                .find(|item| item.name == name)
                .expect("the item is listed")
        };
        assert!(listed("mine.txt").actionable);
        assert_eq!(listed("mine.txt").source, "Desktop");
        assert!(!listed("Company Portal.lnk").actionable);
        assert_eq!(listed("Company Portal.lnk").source, "Public Desktop");

        let report = delete_items(&roots, std::slice::from_ref(&shared)).expect("the call still reports");
        assert_eq!(report.succeeded, 0);
        assert_eq!(report.failed, 1);
        assert!(
            report.outcomes[0]
                .error
                .as_deref()
                .expect("a refusal says why")
                .contains("administrator"),
            "the refusal explains the elevation this app does not ask for"
        );
        assert!(Path::new(&shared).exists(), "the public desktop is untouched");

        // The user's own desktop still works, in the same call shape.
        let report = delete_items(&roots, std::slice::from_ref(&mine)).expect("the delete should run");
        assert_eq!(report.succeeded, 1);
        assert!(!Path::new(&mine).exists());
    }

    #[test]
    fn a_delete_removes_only_what_was_selected() {
        let folder = TempFolder::new("delete");
        let doomed = folder.file("old-installer.exe", 40);
        let kept = folder.file("wanted.pdf", 10);

        let report = delete_items(&[user_root(&folder)], std::slice::from_ref(&doomed))
            .expect("the delete should run");

        assert_eq!(report.succeeded, 1);
        assert_eq!(report.failed, 0);
        assert_eq!(report.bytes, 40);
        assert!(!Path::new(&doomed).exists());
        assert!(Path::new(&kept).exists(), "an unselected item is untouched");
    }

    #[test]
    fn a_delete_of_a_file_outside_the_desktop_touches_nothing() {
        let desktop = TempFolder::new("guard-desktop");
        let elsewhere = TempFolder::new("guard-elsewhere");
        let outsider = elsewhere.file("payslip.pdf", 10);

        let report = delete_items(&[user_root(&desktop)], std::slice::from_ref(&outsider))
            .expect("the call still reports");

        assert_eq!(report.succeeded, 0);
        assert_eq!(report.failed, 1);
        assert!(
            Path::new(&outsider).exists(),
            "a file outside Desktop must survive being asked for by path"
        );
    }

    #[test]
    fn a_path_reached_by_dot_dot_is_refused() {
        let desktop = TempFolder::new("dotdot-desktop");
        let elsewhere = TempFolder::new("dotdot-elsewhere");
        let outsider = elsewhere.file("tax.pdf", 10);
        let sideways = desktop
            .path()
            .join("..")
            .join(
                Path::new(&outsider)
                    .parent()
                    .and_then(Path::file_name)
                    .expect("the neighbour has a name"),
            )
            .join("tax.pdf");

        let report = delete_items(
            &[user_root(&desktop)],
            &[sideways.to_string_lossy().into_owned()],
        )
        .expect("the call still reports");

        assert_eq!(report.failed, 1);
        assert!(Path::new(&outsider).exists(), "`..` reaches nothing");
    }

    #[test]
    fn a_name_windows_does_not_allow_is_refused_before_the_filesystem_sees_it() {
        let desktop = TempFolder::new("bad-name");
        let impossible = desktop.path().join("quarterly<report>.txt");

        let report = delete_items(
            &[user_root(&desktop)],
            &[impossible.to_string_lossy().into_owned()],
        )
        .expect("the call still reports");

        assert_eq!(report.failed, 1);
        assert!(
            report.outcomes[0]
                .error
                .as_deref()
                .expect("a refusal says why")
                .contains("not a name Windows allows"),
            "the refusal names the real reason rather than 'file not found'"
        );

        // And the reserved device names, which look ordinary and are not.
        let device = desktop.path().join("CON");
        assert!(resolve_item(&[user_root(&desktop)], &device.to_string_lossy()).is_err());
    }

    #[test]
    fn an_empty_selection_changes_nothing() {
        let folder = TempFolder::new("empty-selection");
        let kept = folder.file("keep.lnk", 10);

        assert!(delete_items(&[user_root(&folder)], &[]).is_err());
        assert!(move_items(&[user_root(&folder)], &[], "anywhere").is_err());
        assert!(Path::new(&kept).exists());
    }

    #[test]
    fn a_move_relocates_the_item_and_never_overwrites() {
        let folder = TempFolder::new("move-source");
        let destination = TempFolder::new("move-target");
        let source = folder.file("report.pdf", 25);
        // Something of the same name is already waiting in the destination.
        fs::write(destination.path().join("report.pdf"), b"existing")
            .expect("could not seed the destination");

        let report = move_items(
            &[user_root(&folder)],
            std::slice::from_ref(&source),
            &destination.path().to_string_lossy(),
        )
        .expect("the move should run");

        assert_eq!(report.succeeded, 1);
        assert!(!Path::new(&source).exists(), "the original is gone");

        let landed = report.outcomes[0]
            .moved_to
            .clone()
            .expect("a successful move names where it went");
        assert!(landed.ends_with("report (1).pdf"), "got {landed}");
        assert_eq!(
            fs::read(destination.path().join("report.pdf")).expect("the original is readable"),
            b"existing",
            "the item already in the destination is left exactly as it was"
        );
    }

    #[test]
    fn a_move_into_a_desktop_subfolder_is_allowed() {
        let folder = TempFolder::new("move-into-subfolder");
        let archive = folder.dir("Archive");
        let source = folder.file("old.png", 30);

        let report = move_items(
            &[user_root(&folder)],
            std::slice::from_ref(&source),
            &archive.to_string_lossy(),
        )
        .expect("the move should run");

        assert_eq!(report.succeeded, 1);
        assert!(archive.join("old.png").exists());
    }

    #[test]
    fn a_move_onto_a_desktop_itself_is_refused() {
        let folder = TempFolder::new("move-onto-self");
        let public = TempFolder::new("move-onto-public");
        let source = folder.file("thing.zip", 10);
        let roots = vec![user_root(&folder), public_root(&public)];

        assert!(move_items(
            &roots,
            std::slice::from_ref(&source),
            &folder.path().to_string_lossy()
        )
        .is_err());
        assert!(
            move_items(
                &roots,
                std::slice::from_ref(&source),
                &public.path().to_string_lossy()
            )
            .is_err(),
            "the public desktop is not a place this app may write to"
        );
        assert!(Path::new(&source).exists());
    }
}
