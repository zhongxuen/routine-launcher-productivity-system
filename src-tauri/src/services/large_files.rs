//! The Large File Finder (development-plan.md sections 38, 41, 67).
//!
//! Scans a folder tree the user chose, reports every file above a size
//! threshold largest-first, and carries out the five actions section 41 asks
//! for — Open, Move, Archive, Delete, Ignore — one file at a time, each one
//! called by a command the user pressed a button to reach.
//!
//! # Nothing here runs on its own
//!
//! Section 67 draws the order explicitly: scan -> show results -> user selects
//! -> confirm -> perform action. This module is built so that order is the
//! only one expressible. [`scan`] is read-only — it opens directories and
//! reads metadata and touches nothing else — and each of [`move_to`],
//! [`archive`] and [`delete`] takes exactly one path and does exactly one
//! thing to it. There is no "clean up everything above 1 GB" entry point, no
//! batch, and nothing that decides on the user's behalf which files a scan
//! result deserves. A quest, a routine or a background thread has nothing to
//! call here that could remove a file.
//!
//! # What the scan will not let you delete
//!
//! A large-file scan of `C:\` finds `pagefile.sys` and `hiberfil.sys` before
//! it finds anything the user put there, and a scan of `C:\Program Files`
//! finds the halves of installed applications. Those are exactly the results
//! a size-ranked list surfaces first and exactly the ones that must not be
//! one confirmation away from deletion, so every result carries
//! [`LargeFile::protected`] and the three destructive functions refuse a
//! protected path outright (section 66, "restrict dangerous operations").
//! Open and Ignore still work on them: looking is safe, and hiding a result
//! the user does not want to keep being shown is the *opposite* of dangerous.
//!
//! # Deleting means the Recycle Bin
//!
//! [`delete`] moves the file to the platform's trash rather than unlinking
//! it. A 2.4 GB video is precisely the kind of file a user is unsure about,
//! and the confirmation dialog can honestly say the file is recoverable —
//! which a permanent delete behind a single "Are you sure?" could not.
//!
//! # Why the filesystem half takes no `Connection`
//!
//! A scan of a large tree can run for many seconds and the app shares one
//! SQLite connection behind a mutex, so a scan holding that lock would freeze
//! the tray menu, the reminder scheduler and every other window with it.
//! [`scan`] therefore takes a plain path and a set of ignored keys; reading
//! the ignore list and remembering the user's choices are separate,
//! short-lived functions at the bottom of this file, and `commands/
//! large_files.rs` releases the lock before it starts walking. It is the same
//! split `services::routine_exec` makes for the same reason.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf, MAIN_SEPARATOR, MAIN_SEPARATOR_STR};
use std::time::{Instant, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;

use super::error::{ServiceError, ServiceResult};
use super::settings;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/// Bytes in a megabyte, as the UI means it. Binary rather than decimal so the
/// figures match what Windows Explorer shows for the same file.
pub const BYTES_PER_MB: u64 = 1024 * 1024;

/// The threshold a first-time scan uses, in MB. Big enough that a Downloads
/// folder returns a readable handful rather than everything in it.
pub const DEFAULT_THRESHOLD_MB: u64 = 100;

/// Threshold bounds. The floor keeps a mis-typed `0` from turning the finder
/// into "list every file on the disk"; the ceiling is past any single file a
/// desktop is likely to hold and only exists so the multiplication below
/// cannot overflow.
pub const MIN_THRESHOLD_MB: u64 = 1;
pub const MAX_THRESHOLD_MB: u64 = 1_048_576; // 1 TiB

/// How many files the scan reports. The list is a thing to read and act on
/// one row at a time, so a cap this size costs nothing real — and when it
/// bites, [`LargeFileScan::truncated`] says so and the answer is to raise the
/// threshold, which is the more useful correction anyway.
pub const MAX_RESULTS: usize = 200;

/// How many directory entries the walk will look at before it stops. A guard
/// against being pointed at a drive root and never coming back, not a limit
/// anyone should meet in normal use.
pub const MAX_ENTRIES: u64 = 400_000;

/// How long the walk will run before it stops. Cheaper than the entry cap on
/// a slow or network drive, where the limit that matters is time rather than
/// count.
pub const MAX_SCAN_SECONDS: u64 = 45;

/// Unreadable directories are reported so the user can tell "there is nothing
/// big in here" apart from "we could not look", but only the first few — the
/// point is to say *that* it happened, and a permission-denied sweep of a
/// system tree would otherwise produce thousands of identical lines.
const MAX_REPORTED_SKIPS: usize = 12;

/// How many paths the ignore list will hold. It lives in one `settings` row
/// as JSON, and a list longer than this has stopped being "the handful of
/// files I know about and want to keep".
pub const MAX_IGNORED: usize = 500;

// ---------------------------------------------------------------------------
// Settings keys (section 52's key/value table)
// ---------------------------------------------------------------------------

/// The folder the last scan ran over, so the view opens where it left off.
const KEY_ROOT: &str = "large_files.root";
/// The threshold the last scan used, in MB.
const KEY_THRESHOLD_MB: &str = "large_files.threshold_mb";
/// Paths the user pressed Ignore on, as a JSON array.
const KEY_IGNORED: &str = "large_files.ignored";
/// Where Archive puts things. Unset until the user picks one, at which point
/// the command layer's default is what was already being used.
const KEY_ARCHIVE_ROOT: &str = "large_files.archive_root";

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One file worth showing — a row of section 41's list.
///
/// `camelCase` on the wire, like `services::xp`, because none of this mirrors
/// a database row: it is computed from the filesystem at the moment of the
/// scan and stored nowhere.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFile {
    /// Absolute path, and the identity every action takes.
    pub path: String,
    /// File name with extension — the bold half of a row.
    pub name: String,
    /// The containing folder, shown under the name so two `backup.zip`s are
    /// tellable apart.
    pub parent: String,
    /// Where the file sits relative to the scanned root (`videos/old`), or
    /// empty when it is directly inside it. Shorter and more useful than the
    /// absolute parent when the root is deep.
    pub relative_parent: String,
    pub size_bytes: u64,
    /// Lower-case extension without the dot, or `None` for a file that has
    /// none.
    pub extension: Option<String>,
    /// Last-modified time as milliseconds since the Unix epoch. Epoch millis
    /// rather than one of the database's UTC strings because nothing here
    /// came out of SQLite — the frontend formats it with `date-fns` like any
    /// other instant.
    pub modified_ms: Option<i64>,
    /// True when the file lives somewhere the app refuses to move or delete
    /// from. See [`is_protected`] for what counts and the module docs for
    /// why.
    pub protected: bool,
}

/// Why a walk stopped before it had seen the whole tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanStop {
    /// [`MAX_ENTRIES`] entries were visited.
    EntryLimit,
    /// [`MAX_SCAN_SECONDS`] elapsed.
    TimeLimit,
}

/// Everything the Large Files view draws itself from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileScan {
    /// The folder that was walked, as given.
    pub root: String,
    pub threshold_bytes: u64,
    /// The files, largest first. At most [`MAX_RESULTS`] of them.
    pub files: Vec<LargeFile>,
    /// How many files were over the threshold in total, which is larger than
    /// `files.len()` exactly when `truncated` is true.
    pub matched: u64,
    /// Bytes held by the files in `files` — the "18.4 GB in 12 files" figure.
    /// Deliberately the total of what is *shown* rather than of everything
    /// matched, so it always adds up to the list underneath it.
    pub shown_bytes: u64,
    pub files_seen: u64,
    pub folders_seen: u64,
    /// Files that were over the threshold but are on the ignore list. Shown
    /// as "3 ignored" so a hidden result is never silently hidden.
    pub ignored_matches: u64,
    /// Folders that could not be opened, usually for want of permission. Cut
    /// off at [`MAX_REPORTED_SKIPS`]; `skipped_folders_total` is the real
    /// count.
    pub skipped_folders: Vec<String>,
    pub skipped_folders_total: u64,
    /// True when more files matched than the list can hold.
    pub truncated: bool,
    /// Set when the walk gave up early, in which case the tree was only
    /// partly seen and the view says so.
    pub stopped: Option<ScanStop>,
    pub duration_ms: u64,
}

/// What the view needs before it can offer a scan: where to start, how big
/// counts as big, what is hidden and where Archive would put things.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFilePreferences {
    /// The last scanned folder, or `None` on a first run.
    pub root: Option<String>,
    pub threshold_mb: u64,
    /// Ignored paths as the user typed them, newest last.
    pub ignored: Vec<String>,
    /// Where Archive moves files to. Always present — the command layer
    /// supplies the default when nothing is stored.
    pub archive_root: String,
    /// True when `archive_root` is the app's default rather than a folder the
    /// user chose, so the view can say which it is.
    pub archive_root_is_default: bool,
}

/// The result of a Move, an Archive or a Delete: enough for the toast to say
/// what happened to which file and where it went.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileActionResult {
    /// Where the file was.
    pub from: String,
    /// Where it is now. `None` for a delete.
    pub to: Option<String>,
    /// The name it ended up with, which differs from the original only when
    /// the destination already held a file of that name.
    pub name: String,
    /// True when the name had to be disambiguated, so the toast can mention
    /// it rather than leaving the user to wonder where `backup.zip` went.
    pub renamed: bool,
    pub size_bytes: u64,
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// An entry in the "biggest so far" heap.
///
/// Ordered by size and then by path so the ranking is total and stable: two
/// files of exactly the same size (very common — copies) would otherwise
/// swap places between scans of an unchanged folder.
#[derive(PartialEq, Eq)]
struct Ranked {
    size: u64,
    path: PathBuf,
}

impl Ord for Ranked {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.size
            .cmp(&other.size)
            .then_with(|| other.path.cmp(&self.path))
    }
}

impl PartialOrd for Ranked {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Turns a megabyte threshold into bytes, refusing anything outside
/// [`MIN_THRESHOLD_MB`]..=[`MAX_THRESHOLD_MB`].
pub fn threshold_bytes(threshold_mb: u64) -> ServiceResult<u64> {
    if !(MIN_THRESHOLD_MB..=MAX_THRESHOLD_MB).contains(&threshold_mb) {
        return Err(ServiceError::validation(format!(
            "The size threshold must be between {MIN_THRESHOLD_MB} MB and {MAX_THRESHOLD_MB} MB."
        )));
    }
    Ok(threshold_mb * BYTES_PER_MB)
}

/// Walks `root` and returns the biggest files in it, largest first.
///
/// Read-only from beginning to end: it opens directories and reads metadata,
/// and there is no branch in it that writes, moves or removes anything.
///
/// Three things it deliberately does not do:
///
/// * **Follow symlinks and junctions.** A link into an ancestor would make
///   the walk loop forever, and a link into a folder already visited would
///   report the same file twice under two names — of which the user would
///   then be offered a delete for both.
/// * **Cross into a directory it cannot read.** The folder is counted, named
///   in `skipped_folders`, and the walk goes on. A tree with one locked
///   subfolder still gives a useful answer for the rest of it.
/// * **Run forever.** [`MAX_ENTRIES`] and [`MAX_SCAN_SECONDS`] both stop it,
///   and either one sets `stopped` so the view can say the answer is partial
///   instead of implying the tree is small.
///
/// `ignored` holds the keys from [`ignore_key`], not raw paths — compare with
/// [`ignore_key`] on both sides or the match will be case-sensitive on a
/// filesystem that is not.
pub fn scan(
    root: &Path,
    threshold_bytes: u64,
    ignored: &HashSet<String>,
) -> ServiceResult<LargeFileScan> {
    if !root.exists() {
        return Err(ServiceError::not_found(format!(
            "The folder {} does not exist.",
            root.display()
        )));
    }
    if !root.is_dir() {
        return Err(ServiceError::validation(format!(
            "{} is a file, not a folder. Choose the folder to search.",
            root.display()
        )));
    }

    let started = Instant::now();
    let mut heap: BinaryHeap<Reverse<Ranked>> = BinaryHeap::new();
    let mut pending = vec![root.to_path_buf()];

    let mut entries_seen: u64 = 0;
    let mut files_seen: u64 = 0;
    let mut folders_seen: u64 = 0;
    let mut matched: u64 = 0;
    let mut ignored_matches: u64 = 0;
    let mut skipped_folders: Vec<String> = Vec::new();
    let mut skipped_folders_total: u64 = 0;
    let mut stopped: Option<ScanStop> = None;

    'walk: while let Some(folder) = pending.pop() {
        let listing = match fs::read_dir(&folder) {
            Ok(listing) => listing,
            Err(_) => {
                // Almost always a permission error, and almost always on a
                // folder the user did not mean to include anyway. Recorded
                // rather than raised: one locked folder is not a reason to
                // fail a scan of the other nine hundred.
                skipped_folders_total += 1;
                if skipped_folders.len() < MAX_REPORTED_SKIPS {
                    skipped_folders.push(folder.display().to_string());
                }
                continue;
            }
        };

        for entry in listing {
            let Ok(entry) = entry else { continue };

            entries_seen += 1;
            // Checked per entry for the count and only occasionally for the
            // clock: `Instant::now` is cheap but not free, and a scan that
            // spent its time asking what time it was would be its own
            // problem.
            if entries_seen >= MAX_ENTRIES {
                stopped = Some(ScanStop::EntryLimit);
                break 'walk;
            }
            if entries_seen % 2_048 == 0 && started.elapsed().as_secs() >= MAX_SCAN_SECONDS {
                stopped = Some(ScanStop::TimeLimit);
                break 'walk;
            }

            let Ok(file_type) = entry.file_type() else { continue };

            // Neither followed nor reported. See the doc comment above.
            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();

            if file_type.is_dir() {
                folders_seen += 1;
                pending.push(path);
                continue;
            }

            if !file_type.is_file() {
                continue;
            }

            files_seen += 1;

            let Ok(metadata) = entry.metadata() else { continue };
            let size = metadata.len();
            if size < threshold_bytes {
                continue;
            }

            matched += 1;

            if ignored.contains(&ignore_key(&path)) {
                ignored_matches += 1;
                continue;
            }

            heap.push(Reverse(Ranked { size, path }));
            if heap.len() > MAX_RESULTS {
                // The smallest of the kept files falls out, which is the one
                // the list would have shown last.
                heap.pop();
            }
        }
    }

    // `into_sorted_vec` on a heap of `Reverse` gives descending order, which
    // is the order section 41 asks for and the only order this list is ever
    // shown in.
    let ranked = heap.into_sorted_vec();
    let mut files = Vec::with_capacity(ranked.len());
    let mut shown_bytes: u64 = 0;

    for Reverse(entry) in ranked {
        shown_bytes = shown_bytes.saturating_add(entry.size);
        files.push(describe(root, &entry.path, entry.size));
    }

    Ok(LargeFileScan {
        root: root.display().to_string(),
        threshold_bytes,
        matched,
        shown_bytes,
        files_seen,
        folders_seen,
        ignored_matches,
        skipped_folders,
        skipped_folders_total,
        truncated: matched.saturating_sub(ignored_matches) > files.len() as u64,
        stopped,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        files,
    })
}

/// Builds the row for one file. Metadata is re-read here rather than carried
/// through the heap because only the survivors need it, and the heap may
/// discard ninety-nine entries for every one it keeps.
fn describe(root: &Path, path: &Path, size: u64) -> LargeFile {
    let parent = path.parent().unwrap_or(root);

    LargeFile {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        parent: parent.display().to_string(),
        relative_parent: parent
            .strip_prefix(root)
            .map(|rest| rest.display().to_string())
            .unwrap_or_default(),
        size_bytes: size,
        extension: path
            .extension()
            .map(|ext| ext.to_string_lossy().to_ascii_lowercase()),
        modified_ms: fs::metadata(path).ok().and_then(|meta| modified_ms(&meta)),
        protected: is_protected(path),
        path: path.display().to_string(),
    }
}

/// Last-modified time as epoch milliseconds, or `None` when the platform did
/// not record one (or recorded one before 1970, which nothing sane has).
fn modified_ms(metadata: &fs::Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    let since_epoch = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(since_epoch.as_millis()).ok()
}

// ---------------------------------------------------------------------------
// Protected locations
// ---------------------------------------------------------------------------

/// File names that are always protected, wherever they turn up.
///
/// These are the three files that dominate a size-ranked scan of a Windows
/// system drive. All three are in use by the OS, none of them can be usefully
/// deleted from an application, and all three are the first thing a user sees
/// if they point the finder at `C:\`.
const PROTECTED_NAMES: &[&str] = &["pagefile.sys", "hiberfil.sys", "swapfile.sys", "dumpstack.log.tmp"];

/// Environment variables naming folders nothing should be moved or deleted
/// out of. Read from the environment rather than hard-coded because a Windows
/// install is not obliged to be on `C:`.
#[cfg(windows)]
const PROTECTED_ENV_VARS: &[&str] = &[
    "SystemRoot",
    "windir",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "ProgramData",
];

/// The non-Windows equivalents, for a build that ever runs there.
#[cfg(not(windows))]
const PROTECTED_PREFIXES: &[&str] = &[
    "/bin", "/boot", "/dev", "/etc", "/lib", "/proc", "/sbin", "/sys", "/usr", "/var",
    "/System", "/Library", "/Applications",
];

/// Whether the app refuses to move, archive or delete `path`.
///
/// Protection is about *where the file lives*, not about who owns it or
/// whether the OS would allow the write — an application that only found out
/// a file was load-bearing when the delete failed would already have shown
/// the user a confirmation dialog offering to remove it.
///
/// It is a display fact as much as a rule: [`LargeFile::protected`] carries
/// it to the UI, which greys the destructive actions out and says why, so the
/// refusal happens before the click rather than after it. The check is
/// repeated in [`guard_destructive`] regardless, because the command layer is
/// reachable without the UI.
pub fn is_protected(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if PROTECTED_NAMES.contains(&name.as_str()) {
        return true;
    }

    let key = ignore_key(path);

    #[cfg(windows)]
    {
        // A drive root's `$Recycle.Bin` and `System Volume Information` hold
        // large files under names that mean nothing to the user, and are
        // managed by the OS.
        for segment in ["$recycle.bin", "system volume information"] {
            if key.contains(&format!("{MAIN_SEPARATOR}{segment}{MAIN_SEPARATOR}")) {
                return true;
            }
        }

        PROTECTED_ENV_VARS.iter().any(|var| {
            std::env::var_os(var).is_some_and(|root| {
                let root = ignore_key(Path::new(&root));
                !root.is_empty() && is_within(&key, &root)
            })
        })
    }

    #[cfg(not(windows))]
    {
        PROTECTED_PREFIXES
            .iter()
            .any(|prefix| is_within(&key, &ignore_key(Path::new(prefix))))
    }
}

/// Whether `key` names something at or below `root`, both already normalised
/// by [`ignore_key`].
///
/// The separator test is what stops `C:\Program Files Backup` from counting
/// as inside `C:\Program Files`, which a plain `starts_with` would.
fn is_within(key: &str, root: &str) -> bool {
    key == root || key.starts_with(&format!("{root}{MAIN_SEPARATOR}"))
}

/// The check every destructive action starts with.
///
/// Refuses a path that does not exist, is not a file, or lives somewhere
/// [`is_protected`] covers — and returns the metadata, since all three
/// callers want the size for the result they report.
fn guard_destructive(path: &Path, verb: &str) -> ServiceResult<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        ServiceError::not_found(format!(
            "{} is no longer there. It may already have been moved or deleted.",
            display_name(path)
        ))
    })?;

    if metadata.file_type().is_symlink() {
        return Err(ServiceError::validation(format!(
            "{} is a shortcut to another file, so it is not {verb} from here.",
            display_name(path)
        )));
    }

    if !metadata.is_file() {
        return Err(ServiceError::validation(format!(
            "{} is a folder, not a file.",
            display_name(path)
        )));
    }

    if is_protected(path) {
        return Err(ServiceError::validation(format!(
            "{} belongs to Windows or to an installed program, so it is not {verb} from here. \
             Use the program's own uninstaller, or Windows' Storage settings.",
            display_name(path)
        )));
    }

    Ok(metadata)
}

/// The file name for a message, falling back to the whole path for the odd
/// case where there is not one.
fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

// ---------------------------------------------------------------------------
// The actions of section 41
// ---------------------------------------------------------------------------

/// Opens a file with whatever the OS has registered for it.
///
/// The only action here that changes nothing, and the only one the UI offers
/// without a confirmation — because deciding whether a 2.4 GB video is still
/// wanted usually means watching ten seconds of it, and an app that made that
/// awkward would push the user towards guessing instead.
pub fn open(path: &Path) -> ServiceResult<()> {
    if !path.exists() {
        return Err(ServiceError::not_found(format!(
            "{} is no longer there. It may already have been moved or deleted.",
            display_name(path)
        )));
    }

    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|error| {
        ServiceError::validation(format!("{} could not be opened: {error}", display_name(path)))
    })
}

/// Moves a file into `destination`, which must be an existing folder.
///
/// Never overwrites. If `destination` already holds a file of that name the
/// incoming one is given a `" (1)"` suffix and [`FileActionResult::renamed`]
/// says so — the alternative, refusing, would leave the user to rename by
/// hand, and the alternative to *that* would be destroying a file they never
/// mentioned.
pub fn move_to(path: &Path, destination: &Path) -> ServiceResult<FileActionResult> {
    let metadata = guard_destructive(path, "moved")?;

    if !destination.is_dir() {
        return Err(ServiceError::validation(format!(
            "{} is not a folder to move files into.",
            destination.display()
        )));
    }

    let parent = path.parent().unwrap_or(Path::new(""));
    if ignore_key(parent) == ignore_key(destination) {
        return Err(ServiceError::validation(format!(
            "{} is already in that folder.",
            display_name(path)
        )));
    }

    relocate(path, destination, metadata.len())
}

/// Moves a file into the archive, under a `YYYY-MM` folder for the month it
/// was last changed.
///
/// The dated subfolder is what makes Archive worth having beside Move: Move
/// is "put this exactly there", Archive is one click that always lands
/// somewhere predictable and stays organised after the fiftieth file. A file
/// whose modified time is unreadable goes to `undated` rather than being
/// refused. The full destination is returned, and the UI shows it in the
/// confirmation before anything happens, so "predictable" does not have to
/// mean "guessable".
pub fn archive(
    path: &Path,
    archive_root: &Path,
    modified_ms: Option<i64>,
) -> ServiceResult<FileActionResult> {
    let metadata = guard_destructive(path, "archived")?;

    let bucket = archive_root.join(month_folder(modified_ms));

    // The one place this module creates anything. Creating the folder the
    // user is about to be shown is not a change to their files, and the
    // alternative is an Archive button that fails until they have made the
    // folder themselves.
    fs::create_dir_all(&bucket).map_err(|error| {
        ServiceError::validation(format!(
            "The archive folder {} could not be created: {error}",
            bucket.display()
        ))
    })?;

    if ignore_key(path.parent().unwrap_or(Path::new(""))) == ignore_key(&bucket) {
        return Err(ServiceError::validation(format!(
            "{} is already archived.",
            display_name(path)
        )));
    }

    relocate(path, &bucket, metadata.len())
}

/// `YYYY-MM` for an epoch-millisecond timestamp, or `undated`.
///
/// Done by hand rather than with a date crate: the backend has no date
/// dependency, and civil-from-days for a folder name is a dozen lines of
/// arithmetic. UTC, so the same file always lands in the same folder
/// regardless of where the machine is when it is archived.
fn month_folder(modified_ms: Option<i64>) -> String {
    let Some(ms) = modified_ms else {
        return "undated".to_owned();
    };

    // Days since 1970-01-01, floored so that pre-epoch times (a wrong clock,
    // a restored archive) land in the right month rather than a year out.
    let days = ms.div_euclid(86_400_000);
    let (year, month) = civil_from_days(days);
    format!("{year:04}-{month:02}")
}

/// Howard Hinnant's `civil_from_days`, reduced to the year and month.
///
/// Shifts the epoch to 0000-03-01 so leap days fall at the end of the
/// 400-year era and the whole thing becomes integer division.
fn civil_from_days(days: i64) -> (i64, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    // March-based month number, 0 = March.
    let march_month = (5 * day_of_year + 2) / 153;
    let month = if march_month < 10 {
        march_month + 3
    } else {
        march_month - 9
    };

    (if month <= 2 { year + 1 } else { year }, month as u32)
}

/// Sends a file to the platform's Recycle Bin / Trash.
///
/// Not `fs::remove_file`. Section 67's whole subject is that the user, not
/// the app, decides what goes — and a decision is only really the user's if
/// it can be taken back. It also lets the confirmation dialog make a true
/// promise about where the file went, which is the difference between a
/// dialog people read and one they click through.
pub fn delete(path: &Path) -> ServiceResult<FileActionResult> {
    let metadata = guard_destructive(path, "deleted")?;

    trash::delete(path).map_err(|error| {
        ServiceError::validation(format!(
            "{} could not be moved to the Recycle Bin: {error}",
            display_name(path)
        ))
    })?;

    Ok(FileActionResult {
        from: path.display().to_string(),
        to: None,
        name: display_name(path),
        renamed: false,
        size_bytes: metadata.len(),
    })
}

/// The move both [`move_to`] and [`archive`] end in.
///
/// `fs::rename` first, because within a volume it is instant and atomic. It
/// fails across volumes — and moving a 4 GB video off the system drive onto
/// an external disk is the single most likely thing anyone does with this
/// feature — so the fallback copies and then removes the original, in that
/// order: a copy that fails halfway leaves the user with the file they
/// started with, and a partial file at the destination that is cleaned up
/// below.
fn relocate(path: &Path, destination: &Path, size: u64) -> ServiceResult<FileActionResult> {
    let (target, renamed) = unique_target(destination, &display_name(path))?;

    if fs::rename(path, &target).is_err() {
        fs::copy(path, &target).map_err(|error| {
            let _ = fs::remove_file(&target);
            ServiceError::validation(format!(
                "{} could not be copied to {}: {error}",
                display_name(path),
                destination.display()
            ))
        })?;

        if let Err(error) = fs::remove_file(path) {
            // The copy landed, so the file *is* at the destination — saying
            // "moved" would be wrong and saying "failed" would be worse,
            // because the user would then have two copies and be told they
            // had none.
            return Err(ServiceError::validation(format!(
                "{} was copied to {} but the original could not be removed: {error}. \
                 There are now two copies.",
                display_name(path),
                target.display()
            )));
        }
    }

    Ok(FileActionResult {
        from: path.display().to_string(),
        name: display_name(&target),
        to: Some(target.display().to_string()),
        renamed,
        size_bytes: size,
    })
}

/// A path inside `destination` that nothing is using yet.
///
/// `report.pdf` -> `report (1).pdf` -> `report (2).pdf`, which is Explorer's
/// convention and therefore the one the user will not have to think about.
/// The loop is bounded: a hundred collisions on one name is not a folder
/// anyone is filing into, and looping forever on a destination that keeps
/// answering "exists" would be worse than an error.
fn unique_target(destination: &Path, name: &str) -> ServiceResult<(PathBuf, bool)> {
    let candidate = destination.join(name);
    if !candidate.exists() {
        return Ok((candidate, false));
    }

    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or(name)
        .to_owned();
    let extension = path.extension().and_then(OsStr::to_str).unwrap_or_default();

    for suffix in 1..=99 {
        let candidate = destination.join(if extension.is_empty() {
            format!("{stem} ({suffix})")
        } else {
            format!("{stem} ({suffix}).{extension}")
        });

        if !candidate.exists() {
            return Ok((candidate, true));
        }
    }

    Err(ServiceError::validation(format!(
        "{} already holds {name} and 99 renamed copies of it. Choose another folder.",
        destination.display()
    )))
}

// ---------------------------------------------------------------------------
// The ignore list, and what the view remembers
// ---------------------------------------------------------------------------

/// The comparison form of a path.
///
/// Windows filesystems are case-insensitive and accept both separators, so
/// `C:/Users/me/Big.ISO` and `C:\Users\me\big.iso` are one file and an ignore
/// list that could not tell would keep re-showing a file the user had hidden.
/// Elsewhere the path is left exactly as it is, because elsewhere those are
/// two different files.
///
/// Not `fs::canonicalize`: that resolves to a `\\?\C:\...` verbatim path on
/// Windows, which would be stored in the ignore list and shown back to the
/// user in the "Ignored" panel.
pub fn ignore_key(path: &Path) -> String {
    let text = path
        .to_string_lossy()
        .replace('/', MAIN_SEPARATOR_STR)
        .trim_end_matches(MAIN_SEPARATOR)
        .to_owned();

    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// The stored ignore list, as the user's own paths.
pub fn ignored(conn: &Connection) -> ServiceResult<Vec<String>> {
    let Some(raw) = settings::get(conn, KEY_IGNORED)? else {
        return Ok(Vec::new());
    };

    // A row that will not parse is treated as an empty list rather than as an
    // error: the ignore list is a convenience, and refusing to scan because
    // of a corrupted preference would be the wrong trade every time.
    Ok(serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default())
}

/// The same list as comparison keys, which is what [`scan`] wants.
pub fn ignored_keys(conn: &Connection) -> ServiceResult<HashSet<String>> {
    Ok(ignored(conn)?
        .iter()
        .map(|path| ignore_key(Path::new(path)))
        .collect())
}

/// Adds a path to the ignore list and returns the list as it now stands.
///
/// Idempotent, and the only "action" in section 41 that has no confirmation
/// step: nothing on disk changes and one click undoes it from the Ignored
/// panel, so a dialog would be ceremony over a decision that costs nothing.
pub fn ignore(conn: &Connection, path: &str) -> ServiceResult<Vec<String>> {
    let path = path.trim();
    if path.is_empty() {
        return Err(ServiceError::validation("There is no file to ignore."));
    }

    let mut list = ignored(conn)?;
    let key = ignore_key(Path::new(path));

    if !list.iter().any(|held| ignore_key(Path::new(held)) == key) {
        if list.len() >= MAX_IGNORED {
            return Err(ServiceError::validation(format!(
                "The ignore list is full at {MAX_IGNORED} files. Clear some of it from the \
                 Ignored panel, or raise the size threshold so fewer files come back."
            )));
        }
        list.push(path.to_owned());
        save_ignored(conn, &list)?;
    }

    Ok(list)
}

/// Removes a path from the ignore list, so the next scan shows it again.
pub fn unignore(conn: &Connection, path: &str) -> ServiceResult<Vec<String>> {
    let key = ignore_key(Path::new(path));
    let mut list = ignored(conn)?;
    let before = list.len();

    list.retain(|held| ignore_key(Path::new(held)) != key);

    if list.len() != before {
        save_ignored(conn, &list)?;
    }

    Ok(list)
}

/// Empties the ignore list.
pub fn clear_ignored(conn: &Connection) -> ServiceResult<Vec<String>> {
    save_ignored(conn, &[])?;
    Ok(Vec::new())
}

fn save_ignored(conn: &Connection, list: &[String]) -> ServiceResult<()> {
    let encoded = serde_json::to_string(list)
        .map_err(|error| ServiceError::validation(format!("The ignore list is not storable: {error}")))?;
    settings::set(conn, KEY_IGNORED, &encoded)
}

/// Everything the view opens with. `default_archive_root` is supplied by the
/// command layer, which is the half that can ask Tauri where Documents is.
pub fn preferences(conn: &Connection, default_archive_root: &str) -> ServiceResult<LargeFilePreferences> {
    let stored_archive = settings::get(conn, KEY_ARCHIVE_ROOT)?.filter(|value| !value.is_empty());

    Ok(LargeFilePreferences {
        root: settings::get(conn, KEY_ROOT)?.filter(|value| !value.is_empty()),
        threshold_mb: settings::get(conn, KEY_THRESHOLD_MB)?
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|mb| (MIN_THRESHOLD_MB..=MAX_THRESHOLD_MB).contains(mb))
            .unwrap_or(DEFAULT_THRESHOLD_MB),
        ignored: ignored(conn)?,
        archive_root_is_default: stored_archive.is_none(),
        archive_root: stored_archive.unwrap_or_else(|| default_archive_root.to_owned()),
    })
}

/// Remembers what the last scan was of, so the view reopens on it.
///
/// Written after the scan rather than before it, so a folder that turned out
/// not to exist is not the one the user is returned to next time.
pub fn remember_scan(conn: &Connection, root: &str, threshold_mb: u64) -> ServiceResult<()> {
    settings::set(conn, KEY_ROOT, root)?;
    settings::set(conn, KEY_THRESHOLD_MB, &threshold_mb.to_string())
}

/// Points Archive at a folder of the user's choosing.
pub fn set_archive_root(conn: &Connection, root: &str) -> ServiceResult<()> {
    let root = root.trim();
    if root.is_empty() {
        return Err(ServiceError::validation("Choose a folder to archive into."));
    }
    if !Path::new(root).is_dir() {
        return Err(ServiceError::validation(format!(
            "{root} is not a folder."
        )));
    }

    settings::set(conn, KEY_ARCHIVE_ROOT, root)
}

/// Goes back to the default archive folder.
pub fn reset_archive_root(conn: &Connection) -> ServiceResult<()> {
    settings::set(conn, KEY_ARCHIVE_ROOT, "")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    /// A scratch directory that removes itself. The scan tests need real
    /// files on a real filesystem — that is the whole subject — so they build
    /// a small tree under the OS temp directory instead of mocking one.
    struct TempTree(PathBuf);

    impl TempTree {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("rl-large-files-{name}"));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn file(&self, relative: &str, bytes: usize) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, vec![b'x'; bytes]).unwrap();
            path
        }

        fn dir(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn scan_bytes(root: &Path, threshold: u64) -> LargeFileScan {
        scan(root, threshold, &HashSet::new()).unwrap()
    }

    #[test]
    fn reports_files_over_the_threshold_largest_first() {
        let tree = TempTree::new("order");
        tree.file("small.txt", 10);
        tree.file("medium.bin", 400);
        tree.file("nested/large.bin", 900);

        let result = scan_bytes(tree.path(), 100);

        let names: Vec<&str> = result.files.iter().map(|file| file.name.as_str()).collect();
        assert_eq!(names, ["large.bin", "medium.bin"]);
        assert_eq!(result.matched, 2);
        assert_eq!(result.shown_bytes, 1_300);
        assert_eq!(result.files_seen, 3);
        assert!(!result.truncated);
        assert!(result.stopped.is_none());
    }

    #[test]
    fn describes_where_a_file_sits_relative_to_the_root() {
        let tree = TempTree::new("relative");
        tree.file("videos/old/clip.mp4", 500);
        tree.file("top.bin", 500);

        let result = scan_bytes(tree.path(), 100);
        let nested = result.files.iter().find(|f| f.name == "clip.mp4").unwrap();
        let top = result.files.iter().find(|f| f.name == "top.bin").unwrap();

        assert_eq!(nested.relative_parent, format!("videos{MAIN_SEPARATOR}old"));
        assert_eq!(nested.extension.as_deref(), Some("mp4"));
        assert!(nested.modified_ms.is_some());
        // Directly inside the root, so there is no relative part to show.
        assert_eq!(top.relative_parent, "");
    }

    #[test]
    fn ignored_files_are_counted_but_not_listed() {
        let tree = TempTree::new("ignored");
        let hidden = tree.file("keep-me.iso", 900);
        tree.file("other.iso", 800);

        let ignored = HashSet::from([ignore_key(&hidden)]);
        let result = scan(tree.path(), 100, &ignored).unwrap();

        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].name, "other.iso");
        // Still counted as matching, so the view can say "1 ignored" rather
        // than quietly showing one row where there were two files.
        assert_eq!(result.matched, 2);
        assert_eq!(result.ignored_matches, 1);
    }

    #[test]
    fn a_root_that_is_missing_or_a_file_is_refused() {
        let tree = TempTree::new("bad-root");
        let file = tree.file("a.bin", 10);

        assert!(matches!(
            scan(&tree.path().join("nope"), 100, &HashSet::new()),
            Err(ServiceError::NotFound(_))
        ));
        assert!(matches!(
            scan(&file, 100, &HashSet::new()),
            Err(ServiceError::Validation(_))
        ));
    }

    #[test]
    fn thresholds_outside_the_bounds_are_refused() {
        assert_eq!(threshold_bytes(100).unwrap(), 100 * BYTES_PER_MB);
        assert!(threshold_bytes(0).is_err());
        assert!(threshold_bytes(MAX_THRESHOLD_MB + 1).is_err());
    }

    #[test]
    fn moving_a_file_leaves_one_copy_at_the_destination() {
        let tree = TempTree::new("move");
        let source = tree.file("from/report.pdf", 200);
        let destination = tree.dir("to");

        let result = move_to(&source, &destination).unwrap();

        assert!(!source.exists());
        assert!(destination.join("report.pdf").exists());
        assert!(!result.renamed);
        assert_eq!(result.size_bytes, 200);
        assert_eq!(result.to.unwrap(), destination.join("report.pdf").display().to_string());
    }

    #[test]
    fn a_move_never_overwrites_what_is_already_there() {
        let tree = TempTree::new("collide");
        let source = tree.file("from/report.pdf", 200);
        let destination = tree.dir("to");
        fs::write(destination.join("report.pdf"), b"the file that was already there").unwrap();

        let result = move_to(&source, &destination).unwrap();

        assert!(result.renamed);
        assert_eq!(result.name, "report (1).pdf");
        assert!(destination.join("report (1).pdf").exists());
        // The original occupant is untouched.
        assert_eq!(
            fs::read(destination.join("report.pdf")).unwrap(),
            b"the file that was already there"
        );
    }

    #[test]
    fn moving_into_the_folder_a_file_is_already_in_is_refused() {
        let tree = TempTree::new("same-folder");
        let source = tree.file("here/a.bin", 10);

        assert!(move_to(&source, &tree.path().join("here")).is_err());
        assert!(source.exists());
    }

    #[test]
    fn a_missing_file_is_reported_rather_than_ignored() {
        let tree = TempTree::new("missing");
        let destination = tree.dir("to");

        let err = move_to(&tree.path().join("gone.bin"), &destination).unwrap_err();
        assert!(matches!(err, ServiceError::NotFound(_)));
    }

    #[test]
    fn archiving_files_them_under_the_month_they_were_changed() {
        let tree = TempTree::new("archive");
        let source = tree.file("big.mp4", 300);
        let archive_root = tree.dir("archive");

        // 2024-03-15T00:00:00Z.
        let result = archive(&source, &archive_root, Some(1_710_460_800_000)).unwrap();

        assert!(archive_root.join("2024-03").join("big.mp4").exists());
        assert!(!source.exists());
        assert!(result.to.unwrap().ends_with("big.mp4"));
    }

    #[test]
    fn a_file_with_no_modified_time_is_archived_as_undated() {
        let tree = TempTree::new("undated");
        let source = tree.file("big.mp4", 300);
        let archive_root = tree.dir("archive");

        archive(&source, &archive_root, None).unwrap();

        assert!(archive_root.join("undated").join("big.mp4").exists());
    }

    #[test]
    fn month_folders_are_computed_for_the_dates_that_matter() {
        assert_eq!(month_folder(Some(0)), "1970-01");
        assert_eq!(month_folder(Some(1_709_164_800_000)), "2024-02"); // 29 Feb 2024
        assert_eq!(month_folder(Some(1_735_689_599_000)), "2024-12"); // 31 Dec 2024
        assert_eq!(month_folder(Some(1_735_689_600_000)), "2025-01"); // 1 Jan 2025
        assert_eq!(month_folder(None), "undated");
    }

    #[test]
    fn protected_locations_are_refused_by_every_destructive_action() {
        // Built from the environment rather than hard-coded, for the same
        // reason `is_protected` reads it: Windows need not be on `C:`.
        let Some(system_root) = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("windir"))
        else {
            return;
        };

        let inside = Path::new(&system_root).join("System32").join("ntoskrnl.exe");
        assert!(is_protected(&inside));
        assert!(is_protected(Path::new("C:\\pagefile.sys")));
        assert!(!is_protected(&std::env::temp_dir().join("holiday.mp4")));

        // A neighbouring folder whose name merely starts the same way is not
        // inside it.
        let neighbour = format!("{} Backup", Path::new(&system_root).display());
        assert!(!is_protected(&Path::new(&neighbour).join("big.bin")));
    }

    #[test]
    fn ignore_keys_fold_separators_and_windows_case() {
        let mixed = ignore_key(Path::new("C:/Users/me/Big.ISO"));
        let native = ignore_key(Path::new("C:\\Users\\me\\Big.ISO"));
        assert_eq!(mixed, native);
        // A trailing separator on a folder must not make it a different path.
        assert_eq!(
            ignore_key(Path::new("C:\\Users\\me\\")),
            ignore_key(Path::new("C:\\Users\\me"))
        );

        if cfg!(windows) {
            assert_eq!(ignore_key(Path::new("C:\\A\\B.txt")), "c:\\a\\b.txt");
        }
    }

    #[test]
    fn the_ignore_list_round_trips_and_does_not_duplicate() {
        let conn = init_memory_db().unwrap();

        assert!(ignored(&conn).unwrap().is_empty());

        ignore(&conn, "C:\\Users\\me\\big.iso").unwrap();
        // The same file said a second way. Windows folds case, so it is the
        // same entry there and a distinct one elsewhere.
        let list = ignore(&conn, "C:/Users/me/BIG.ISO").unwrap();
        assert_eq!(list.len(), if cfg!(windows) { 1 } else { 2 });

        let after = unignore(&conn, "C:\\Users\\me\\big.iso").unwrap();
        assert_eq!(after.len(), if cfg!(windows) { 0 } else { 1 });

        ignore(&conn, "C:\\a.bin").unwrap();
        assert!(clear_ignored(&conn).unwrap().is_empty());
        assert!(ignored(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_corrupt_ignore_list_reads_as_empty_rather_than_failing() {
        let conn = init_memory_db().unwrap();
        settings::set(&conn, KEY_IGNORED, "not json").unwrap();

        assert!(ignored(&conn).unwrap().is_empty());
        assert!(ignored_keys(&conn).unwrap().is_empty());
    }

    #[test]
    fn preferences_default_until_a_scan_has_been_remembered() {
        let conn = init_memory_db().unwrap();

        let first = preferences(&conn, "C:\\default").unwrap();
        assert_eq!(first.root, None);
        assert_eq!(first.threshold_mb, DEFAULT_THRESHOLD_MB);
        assert_eq!(first.archive_root, "C:\\default");
        assert!(first.archive_root_is_default);

        remember_scan(&conn, "C:\\Users\\me\\Videos", 500).unwrap();
        let second = preferences(&conn, "C:\\default").unwrap();
        assert_eq!(second.root.as_deref(), Some("C:\\Users\\me\\Videos"));
        assert_eq!(second.threshold_mb, 500);
    }

    #[test]
    fn an_out_of_range_stored_threshold_falls_back_to_the_default() {
        let conn = init_memory_db().unwrap();
        settings::set(&conn, KEY_THRESHOLD_MB, "0").unwrap();
        assert_eq!(
            preferences(&conn, "C:\\default").unwrap().threshold_mb,
            DEFAULT_THRESHOLD_MB
        );

        settings::set(&conn, KEY_THRESHOLD_MB, "nonsense").unwrap();
        assert_eq!(
            preferences(&conn, "C:\\default").unwrap().threshold_mb,
            DEFAULT_THRESHOLD_MB
        );
    }

    #[test]
    fn the_archive_root_can_be_chosen_and_given_back() {
        let conn = init_memory_db().unwrap();
        let tree = TempTree::new("archive-root");
        let chosen = tree.dir("my-archive");
        let chosen = chosen.display().to_string();

        set_archive_root(&conn, &chosen).unwrap();
        let prefs = preferences(&conn, "C:\\default").unwrap();
        assert_eq!(prefs.archive_root, chosen);
        assert!(!prefs.archive_root_is_default);

        // A folder that is not there is refused, so Archive cannot be pointed
        // at nothing.
        assert!(set_archive_root(&conn, &tree.path().join("nope").display().to_string()).is_err());
        assert!(set_archive_root(&conn, "   ").is_err());

        reset_archive_root(&conn).unwrap();
        assert!(preferences(&conn, "C:\\default").unwrap().archive_root_is_default);
    }
}
