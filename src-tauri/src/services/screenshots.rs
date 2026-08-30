//! Screenshot Organizer — development-plan.md sections 38, 42 and 67.
//!
//! Two halves, and the order between them is the feature:
//!
//! 1. [`scan`] walks the folders screenshots actually land in, decides which
//!    files are screenshots, and buckets them by Today / This week / This
//!    month — section 42's mockup, one number per line.
//! 2. [`organize`] moves files the user has explicitly picked into a folder
//!    the user has explicitly chosen.
//!
//! Nothing here deletes anything, and nothing here moves anything the caller
//! did not name. Section 67's rule is *scan -> show results -> user selects ->
//! confirm -> perform action*, so the scan is pure reading and the move is the
//! only thing that touches the disk — separate commands, so there is no code
//! path where finding a screenshot can lead to relocating one.
//!
//! # What counts as a screenshot
//!
//! Two independent signals, because either one alone is wrong:
//!
//! * **Location** — everything image-shaped inside a folder whose entire
//!   purpose is screenshots (`Pictures/Screenshots`, the Xbox Game Bar's
//!   `Videos/Captures`, ...). Capture tools let users rename freely, so a
//!   name rule alone would miss the tidy user's whole library.
//! * **Name** — the filename patterns the common tools produce, used in
//!   folders that hold other things too (Desktop, Downloads, `Pictures`
//!   itself). A location rule alone would either miss those or sweep in every
//!   holiday photo.
//!
//! The name rules are deliberately conservative (see [`name_marks_screenshot`]):
//! a bare timestamp like `2024-01-05_14-30-22.png` is a screenshot in a
//! screenshot folder and a phone photo everywhere else, so it only ever
//! matches by location. A false positive is not destructive — the user still
//! selects and confirms — but it is noise in a list whose whole value is that
//! everything in it is worth moving.
//!
//! # Time, without a date library
//!
//! The crate has no `chrono`/`time` dependency and `std` cannot tell us the
//! local UTC offset, so [`LocalClock`] reads it once from SQLite (the same
//! source as the `date('now', 'localtime')` comparisons every other feature
//! uses) and does the rest — day boundaries, month keys — as plain
//! arithmetic. One query per scan, and every decision after it is pure and
//! testable against a fixed offset.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::error::{ServiceError, ServiceResult};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/// How deep a screenshot folder is walked. Users file screenshots into
/// subfolders (`Screenshots/2024/`), which is exactly the state this tool
/// exists to reach, so one or two levels have to be visible — but a screenshot
/// folder is not a place to go looking for a whole drive.
const MAX_DEPTH: usize = 2;

/// A ceiling on directory entries looked at across the whole scan, so a folder
/// that turns out to hold a hundred thousand files cannot make the button that
/// started it appear to hang. Reaching it sets [`ScreenshotScan::truncated`].
const MAX_ENTRIES: usize = 50_000;

/// How many matched files are sent to the UI. The counts in section 42's
/// mockup are always the true totals; this only caps the reviewable list,
/// because a list is something a person reads and 20,000 rows is not.
const LIST_LIMIT: usize = 2_000;

/// A ceiling on one [`organize`] call. Far above any realistic selection —
/// it is here so a malformed request cannot turn into an unbounded loop over
/// the filesystem.
const MAX_MOVES: usize = 5_000;

/// The image extensions a screenshot can plausibly have. Video is left out on
/// purpose: `Screen Recording 2024-01-05.mov` is a screen *recording*, and
/// moving it around with a pile of PNGs is not what section 42 is asking for.
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif", "avif",
];

/// Substrings that identify a screenshot on their own, checked against the
/// lowercased file stem. Between them these cover the Windows Snipping Tool
/// and Print Screen, macOS's built-in capture (both the current and the old
/// `Screen Shot` wording), GNOME, KDE Spectacle, Flameshot, ShareX,
/// Greenshot, Lightshot and CleanShot X.
const SCREENSHOT_MARKERS: &[&str] = &[
    "screenshot",
    "screen shot",
    "screen_shot",
    "screen-shot",
    "screencapture",
    "screen capture",
    "screen_capture",
    "screen-capture",
    "cleanshot",
    "snipaste",
    "lightshot",
    "greenshot",
    "flameshot",
    "sharex",
];

/// Prefixes that only mean "screenshot" when a capture timestamp follows —
/// `Annotation 2020-01-01 120000.png` from Snip & Sketch, `Snip_20240105.png`,
/// `Spectacle_2024...`. Each needs a separator and then four digits, so
/// `annotations.png`, `sniper.png` and `capture ideas.png` are left alone.
const DATED_PREFIXES: &[&str] = &["annotation", "snip", "capture", "spectacle"];

// ---------------------------------------------------------------------------
// The local clock
// ---------------------------------------------------------------------------

/// The local timezone, reduced to the one number every date decision here
/// needs: seconds to add to a UTC timestamp to get local wall time.
///
/// Read from SQLite rather than guessed, so "today" means the same day here as
/// it does in the task views, which compare against `date('now', 'localtime')`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalClock {
    utc_offset: i64,
}

impl LocalClock {
    /// A clock at a fixed offset. Used by tests; production goes through
    /// [`LocalClock::from_db`].
    pub fn new(utc_offset: i64) -> Self {
        Self { utc_offset }
    }

    /// Asks SQLite what the local offset is.
    ///
    /// `strftime('%s', 'now', 'localtime')` formats local wall time *as if* it
    /// were UTC, so subtracting the real epoch leaves exactly the offset —
    /// including whichever side of a DST change today is on.
    pub fn from_db(conn: &Connection) -> ServiceResult<Self> {
        let offset: i64 = conn.query_row(
            "SELECT CAST(strftime('%s', 'now', 'localtime') AS INTEGER) \
                  - CAST(strftime('%s', 'now') AS INTEGER)",
            [],
            |row| row.get(0),
        )?;
        Ok(Self::new(offset))
    }

    /// Days since 1970-01-01 *in local time*, which is the unit day
    /// boundaries are counted in.
    fn local_day(self, epoch: i64) -> i64 {
        floor_div(epoch + self.utc_offset, 86_400)
    }

    /// The UTC timestamp local midnight fell at, `days` whole days ago.
    fn local_midnight(self, now: i64, days_ago: i64) -> i64 {
        (self.local_day(now) - days_ago) * 86_400 - self.utc_offset
    }

    /// Section 42's three lines as timestamps, measured back from `now`.
    pub fn windows(self, now: i64) -> DateWindows {
        DateWindows {
            today_start: self.local_midnight(now, 0),
            week_start: self.local_midnight(now, WEEK_DAYS - 1),
            month_start: self.local_midnight(now, MONTH_DAYS - 1),
        }
    }

    /// `"2026-08"` — the folder name [`Grouping::ByMonth`] files into.
    pub fn month_key(self, epoch: i64) -> String {
        let (year, month, _) = civil_from_days(self.local_day(epoch));
        format!("{year:04}-{month:02}")
    }
}

/// Days in "This week", counting today as the first.
const WEEK_DAYS: i64 = 7;
/// Days in "This month", counting today as the first.
const MONTH_DAYS: i64 = 30;

/// Where the three buckets begin, as UTC timestamps.
///
/// Rolling windows anchored on local midnight, not calendar weeks and months.
/// Section 42's mockup reads `Today 12 / This week 38 / This month 97` out of
/// 147 — figures that only make sense nested, each containing the one above
/// it. Calendar boundaries break that: on the 1st of a month "This month"
/// would be smaller than "This week", and a panel whose second line is bigger
/// than its third reads as a bug rather than as a definition. The UI says
/// which it means ("last 7 days") rather than leaving the user to guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DateWindows {
    pub today_start: i64,
    pub week_start: i64,
    pub month_start: i64,
}

impl DateWindows {
    fn bucket(self, modified: i64) -> ScreenshotBucket {
        if modified >= self.today_start {
            ScreenshotBucket::Today
        } else if modified >= self.week_start {
            ScreenshotBucket::ThisWeek
        } else if modified >= self.month_start {
            ScreenshotBucket::ThisMonth
        } else {
            ScreenshotBucket::Older
        }
    }
}

/// Integer division that rounds towards negative infinity, so days before
/// 1970 and negative UTC offsets land on the right day rather than one late.
fn floor_div(value: i64, divisor: i64) -> i64 {
    let quotient = value / divisor;
    if value % divisor < 0 {
        quotient - 1
    } else {
        quotient
    }
}

/// Days-since-epoch to `(year, month, day)`, by Howard Hinnant's civil
/// calendar algorithm — the standard proleptic-Gregorian conversion, and the
/// whole reason this file needs no date crate.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    // Shift the epoch to 0000-03-01, which puts the leap day at the end of the
    // year and makes the month arithmetic below exact.
    let shifted = days + 719_468;
    let era = floor_div(shifted, 146_097);
    let day_of_era = shifted - era * 146_097; // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153; // [0, 11], March = 0
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = (if month_prime < 10 { month_prime + 3 } else { month_prime - 9 }) as u32;
    // January and February belong to the year after the shifted one.
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Now, in seconds since the Unix epoch — the instant a scan measures its
/// buckets back from.
pub fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Where to look
// ---------------------------------------------------------------------------

/// How a folder earns a file its place in the results.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RootKind {
    /// A folder that exists to hold screenshots. Every image inside counts,
    /// whatever it is called, and subfolders are walked to [`MAX_DEPTH`].
    ScreenshotFolder,
    /// A folder that holds screenshots among other things. Only names that
    /// match count, and only at the top level — recursing through Desktop or
    /// Downloads would be a disk scan wearing a screenshot tool's hat.
    General,
}

/// One folder to look in. Built by the command layer from Tauri's path
/// resolver, so this module never has to know what a Pictures folder is
/// called on any particular OS.
#[derive(Debug, Clone)]
pub struct ScanRoot {
    /// What the UI calls it: "Screenshots", "Desktop", ...
    pub label: String,
    pub path: PathBuf,
    pub kind: RootKind,
}

impl ScanRoot {
    pub fn new(label: impl Into<String>, path: PathBuf, kind: RootKind) -> Self {
        Self {
            label: label.into(),
            path,
            kind,
        }
    }
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// Which of section 42's lines a file falls on. The *narrowest* one that
/// contains it — the cumulative figures the mockup prints are on
/// [`ScreenshotScan`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenshotBucket {
    Today,
    ThisWeek,
    ThisMonth,
    /// Older than "This month", and still worth listing — a three-year-old
    /// pile is the one most worth organising.
    Older,
}

/// Why a file is in the results, shown per row so the user can judge a match
/// they disagree with rather than having to trust it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchReason {
    /// The filename is one the capture tools produce.
    Name,
    /// It is an image sitting in a folder that only holds screenshots.
    Location,
}

/// One matched file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    /// Absolute path — the identity [`organize`] takes back.
    pub path: String,
    pub name: String,
    /// The folder it sits in, for the second line of a row.
    pub folder: String,
    /// The [`ScanRoot::label`] it was found under.
    pub source: String,
    pub bytes: u64,
    /// Last-modified, in seconds since the Unix epoch. The capture time for
    /// every practical purpose: a screenshot is written once and rarely
    /// touched again. Creation time would be closer in principle and is not
    /// available on every platform and filesystem, and it survives a copy
    /// *worse* — a restored backup would claim every screenshot was taken
    /// today.
    pub modified_epoch: i64,
    pub bucket: ScreenshotBucket,
    pub matched_by: MatchReason,
}

/// One folder's contribution to the scan, reported whether or not it produced
/// anything — a tool that says "0 screenshots" without saying where it looked
/// is impossible to trust or to debug.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotSource {
    pub label: String,
    pub path: String,
    pub kind: RootKind,
    /// False when the folder is simply not there, which is normal: only some
    /// of these exist on any given machine.
    pub exists: bool,
    pub matched: usize,
    /// Why the folder could not be read. `None` when it was read fine, or
    /// when it does not exist.
    pub error: Option<String>,
}

/// Section 42's panel, and the list behind its `[ Review ]` button.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotScan {
    /// "147 screenshots found".
    pub total: usize,
    /// Modified since local midnight.
    pub today: usize,
    /// Modified in the last 7 days, today included — so this is never smaller
    /// than `today`.
    pub this_week: usize,
    /// Modified in the last 30 days, `this_week` included.
    pub this_month: usize,
    /// `total - this_month`.
    pub older: usize,
    pub total_bytes: u64,
    /// Every folder looked in, in the order they were looked in.
    pub sources: Vec<ScreenshotSource>,
    /// The newest [`LIST_LIMIT`] matches, newest first.
    pub screenshots: Vec<Screenshot>,
    /// True when the list is shorter than `total`, either because the list was
    /// capped or because the walk hit [`MAX_ENTRIES`]. The UI says so rather
    /// than quietly showing a subset.
    pub truncated: bool,
    /// When this scan ran, so a stale panel can say how old it is.
    pub scanned_at: i64,
    pub windows: DateWindows,
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// Looks through `roots` and reports what it found. Reads only.
///
/// Never fails as a whole. A folder that is missing, or that the OS refuses to
/// list, becomes a [`ScreenshotSource`] saying so and the rest of the scan
/// carries on — the same rule section 87 applies to routine actions, for the
/// same reason: one unreadable folder is not a reason to tell the user nothing.
pub fn scan(roots: &[ScanRoot], clock: LocalClock, now: i64) -> ScreenshotScan {
    let windows = clock.windows(now);

    let mut found: Vec<Screenshot> = Vec::new();
    let mut sources = Vec::with_capacity(roots.len());
    let mut budget = MAX_ENTRIES;
    let mut truncated = false;
    // Canonical paths already covered, so a root nested inside another root
    // (a `Screenshots` folder the user also keeps on the Desktop) is counted
    // once rather than twice.
    let mut seen_roots: HashSet<PathBuf> = HashSet::new();

    for root in roots {
        let before = found.len();
        let (exists, error) = walk_root(root, windows, &mut found, &mut budget, &mut seen_roots);
        if budget == 0 {
            truncated = true;
        }
        sources.push(ScreenshotSource {
            label: root.label.clone(),
            path: display_path(&root.path),
            kind: root.kind,
            exists,
            matched: found.len() - before,
            error,
        });
    }

    // Newest first, and by path within a second so the order is stable across
    // scans — two files written in the same second must not swap places on a
    // rescan while the user is looking at the list.
    found.sort_by(|a, b| {
        b.modified_epoch
            .cmp(&a.modified_epoch)
            .then_with(|| a.path.cmp(&b.path))
    });

    let total = found.len();
    let today = found.iter().filter(|s| s.modified_epoch >= windows.today_start).count();
    let this_week = found.iter().filter(|s| s.modified_epoch >= windows.week_start).count();
    let this_month = found.iter().filter(|s| s.modified_epoch >= windows.month_start).count();
    let total_bytes = found.iter().map(|s| s.bytes).sum();

    if found.len() > LIST_LIMIT {
        found.truncate(LIST_LIMIT);
        truncated = true;
    }

    ScreenshotScan {
        total,
        today,
        this_week,
        this_month,
        older: total - this_month,
        total_bytes,
        sources,
        screenshots: found,
        truncated,
        scanned_at: now,
        windows,
    }
}

/// Walks one root, appending matches. Returns `(the folder exists, why it
/// could not be read)`.
fn walk_root(
    root: &ScanRoot,
    windows: DateWindows,
    found: &mut Vec<Screenshot>,
    budget: &mut usize,
    seen_roots: &mut HashSet<PathBuf>,
) -> (bool, Option<String>) {
    let canonical = fs::canonicalize(&root.path).unwrap_or_else(|_| root.path.clone());
    if !root.path.is_dir() {
        return (false, None);
    }
    if !seen_roots.insert(canonical) {
        return (true, None);
    }

    // A screenshot folder is walked into its subfolders; a general folder is
    // read at its top level only. See `RootKind`.
    let depth = match root.kind {
        RootKind::ScreenshotFolder => MAX_DEPTH,
        RootKind::General => 0,
    };

    let mut error = None;
    walk_dir(&root.path, root, depth, windows, found, budget, &mut error);
    (true, error)
}

/// The recursive half of [`walk_root`]. `error` keeps only the first failure:
/// one line saying the folder could not be read is the useful message, and a
/// list of every unreadable subfolder is not.
fn walk_dir(
    dir: &Path,
    root: &ScanRoot,
    depth: usize,
    windows: DateWindows,
    found: &mut Vec<Screenshot>,
    budget: &mut usize,
    error: &mut Option<String>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            error.get_or_insert_with(|| format!("Could not read this folder: {err}"));
            return;
        }
    };

    let mut subdirectories = Vec::new();

    for entry in entries {
        if *budget == 0 {
            return;
        }
        *budget -= 1;

        let Ok(entry) = entry else { continue };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // Symlinks are stepped over rather than followed: a link pointing back
        // up the tree would make the walk loop, and a link pointing at someone
        // else's folder would put files in the list that are not really there.
        if file_type.is_symlink() {
            continue;
        }

        if file_type.is_dir() {
            if depth > 0 {
                subdirectories.push(entry.path());
            }
            continue;
        }

        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(matched_by) = match_reason(&name, root.kind) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };

        let modified_epoch = modified_epoch(&metadata);
        let path = entry.path();
        found.push(Screenshot {
            folder: display_path(dir),
            path: display_path(&path),
            name,
            source: root.label.clone(),
            bytes: metadata.len(),
            modified_epoch,
            bucket: windows.bucket(modified_epoch),
            matched_by,
        });
    }

    for subdirectory in subdirectories {
        if *budget == 0 {
            return;
        }
        walk_dir(&subdirectory, root, depth - 1, windows, found, budget, error);
    }
}

/// Last-modified as a Unix timestamp, or 0 for the filesystems and files that
/// will not say. Zero sorts to the bottom and buckets as `Older`, which is
/// the honest answer for a file whose age is unknown — it is certainly not
/// today's.
fn modified_epoch(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| match time.duration_since(UNIX_EPOCH) {
            Ok(since) => i64::try_from(since.as_secs()).ok(),
            // Before 1970. Vanishingly rare, and representable.
            Err(err) => i64::try_from(err.duration().as_secs()).ok().map(|s| -s),
        })
        .unwrap_or(0)
}

/// Decides whether `file_name` counts, given the kind of folder it is in, and
/// says which rule let it in.
///
/// The name rule is checked first in both kinds of folder so that a file in a
/// screenshot folder that *also* has a screenshot name is reported as a name
/// match — the stronger of the two claims.
pub fn match_reason(file_name: &str, kind: RootKind) -> Option<MatchReason> {
    if !is_image(file_name) {
        return None;
    }
    if name_marks_screenshot(file_name) {
        return Some(MatchReason::Name);
    }
    match kind {
        RootKind::ScreenshotFolder => Some(MatchReason::Location),
        RootKind::General => None,
    }
}

/// Whether the extension is one a screenshot is saved with.
pub fn is_image(file_name: &str) -> bool {
    Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .is_some_and(|extension| IMAGE_EXTENSIONS.contains(&extension.as_str()))
}

/// Whether the filename itself says "screenshot".
///
/// Conservative on purpose. Every rule here needs an actual word from a
/// capture tool; none of them fire on a date alone, because `2024-01-05_14-30-22.png`
/// is a ShareX capture in a screenshot folder and a phone photo in
/// Downloads, and only the folder can tell those apart.
pub fn name_marks_screenshot(file_name: &str) -> bool {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if SCREENSHOT_MARKERS
        .iter()
        .any(|marker| stem.contains(marker))
    {
        return true;
    }

    DATED_PREFIXES.iter().any(|prefix| {
        let Some(rest) = stem.strip_prefix(prefix) else {
            return false;
        };
        let after_separator = rest.trim_start_matches([' ', '_', '-', '.']);
        // A separator has to have been there — `snipping` must not read as
        // `snip` — and four digits have to follow it, which is a year rather
        // than the `1` in `capture 1.png`.
        after_separator.len() < rest.len()
            && after_separator
                .as_bytes()
                .iter()
                .take(4)
                .filter(|byte| byte.is_ascii_digit())
                .count()
                == 4
    })
}

/// A path as a string for the UI. Lossy so a name with unpaired surrogates
/// still shows something rather than disappearing from a list of files the
/// user can see in their own file manager.
fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// Organising
// ---------------------------------------------------------------------------

/// How the chosen files are laid out inside the chosen folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Grouping {
    /// All of them straight into it.
    Single,
    /// Into `YYYY-MM` subfolders, created as needed.
    ByMonth,
}

/// What the user confirmed: these files, into that folder, laid out like this.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeRequest {
    /// Absolute paths, exactly as [`scan`] reported them. Nothing is inferred
    /// or expanded — this list is the whole of what may be touched.
    pub paths: Vec<String>,
    /// An existing folder the user picked. Not created: a typo that silently
    /// created a folder somewhere unexpected is worse than a refusal.
    pub destination: String,
    pub grouping: Grouping,
}

/// What happened to one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MoveStatus {
    Moved,
    /// Deliberately not attempted — it is already there, or it is not a file
    /// this tool will move.
    Skipped,
    Failed,
}

/// One file's outcome, ready to render as a line of the result panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    pub path: String,
    pub name: String,
    pub status: MoveStatus,
    /// Where it ended up. Set only when it moved — and worth showing, because
    /// a name collision means it may not be the name it went in with.
    pub new_path: Option<String>,
    /// Why it was skipped, or why it failed. `None` when it moved.
    pub message: Option<String>,
}

/// The result of one confirmed organise.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeResult {
    pub destination: String,
    pub moved: usize,
    pub skipped: usize,
    pub failed: usize,
    /// Every file considered, in the order they were given.
    pub outcomes: Vec<MoveOutcome>,
    /// A sentence for the panel: `"12 screenshots moved"`.
    pub summary: String,
}

/// Moves the named files into the chosen folder. The only function here that
/// writes to disk.
///
/// Three rules, all of them section 66 and 67:
///
/// * **Only files this tool would have found.** Every path is put back through
///   the same match test the scan used, against the same roots. A path that
///   arrives from anywhere else — a bug, a stale list, a console — is skipped
///   rather than moved, so "the user picked these from the results" is
///   enforced here and not merely assumed.
/// * **Nothing is overwritten.** A name already taken in the destination gets
///   ` (1)`, ` (2)`, ... appended, so an organise can never cost the user a
///   file that was already there.
/// * **Nothing is deleted.** Files are renamed. Across volumes, where a
///   rename cannot work, they are copied and the source removed only after
///   the copy succeeds — and if that removal fails, the copy is undone so the
///   file exists in exactly one place either way.
pub fn organize(
    roots: &[ScanRoot],
    clock: LocalClock,
    request: &OrganizeRequest,
) -> ServiceResult<OrganizeResult> {
    let destination = Path::new(request.destination.trim());
    if request.destination.trim().is_empty() {
        return Err(ServiceError::validation("Choose a folder to move them into."));
    }
    if !destination.is_dir() {
        return Err(ServiceError::validation(format!(
            "{} is not a folder that exists.",
            display_path(destination)
        )));
    }
    if request.paths.is_empty() {
        return Err(ServiceError::validation("Select at least one screenshot."));
    }
    if request.paths.len() > MAX_MOVES {
        return Err(ServiceError::validation(format!(
            "That is {} files at once. Organise up to {MAX_MOVES} at a time.",
            request.paths.len()
        )));
    }

    let mut outcomes = Vec::with_capacity(request.paths.len());
    for path in &request.paths {
        outcomes.push(move_one(roots, clock, Path::new(path), destination, request.grouping));
    }

    let moved = outcomes.iter().filter(|o| o.status == MoveStatus::Moved).count();
    let skipped = outcomes.iter().filter(|o| o.status == MoveStatus::Skipped).count();
    let failed = outcomes.iter().filter(|o| o.status == MoveStatus::Failed).count();

    Ok(OrganizeResult {
        destination: display_path(destination),
        moved,
        skipped,
        failed,
        outcomes,
        summary: summarize(moved, skipped, failed),
    })
}

/// One file, start to finish. Never panics and never propagates: a failure is
/// a line in the result, so the rest of a 300-file organise still happens.
fn move_one(
    roots: &[ScanRoot],
    clock: LocalClock,
    source: &Path,
    destination: &Path,
    grouping: Grouping,
) -> MoveOutcome {
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| display_path(source));

    let outcome = |status: MoveStatus, message: Option<String>, new_path: Option<String>| MoveOutcome {
        path: display_path(source),
        name: name.clone(),
        status,
        new_path,
        message,
    };

    let metadata = match fs::metadata(source) {
        Ok(metadata) => metadata,
        Err(err) => {
            return outcome(
                MoveStatus::Failed,
                Some(format!("Could not be read: {err}")),
                None,
            )
        }
    };
    if !metadata.is_file() {
        return outcome(
            MoveStatus::Skipped,
            Some("Not a file.".to_owned()),
            None,
        );
    }
    if !is_known_screenshot(roots, source, &name) {
        return outcome(
            MoveStatus::Skipped,
            Some("Not one of the screenshots that were found.".to_owned()),
            None,
        );
    }

    let target_dir = match grouping {
        Grouping::Single => destination.to_path_buf(),
        Grouping::ByMonth => destination.join(clock.month_key(modified_epoch(&metadata))),
    };

    if source.parent() == Some(target_dir.as_path()) {
        return outcome(
            MoveStatus::Skipped,
            Some("Already in that folder.".to_owned()),
            None,
        );
    }

    if let Err(err) = fs::create_dir_all(&target_dir) {
        return outcome(
            MoveStatus::Failed,
            Some(format!("Could not create {}: {err}", display_path(&target_dir))),
            None,
        );
    }

    let target = match unique_destination(&target_dir, &name) {
        Some(target) => target,
        None => {
            return outcome(
                MoveStatus::Failed,
                Some("Too many files there are already called that.".to_owned()),
                None,
            )
        }
    };

    match move_file(source, &target) {
        Ok(()) => outcome(MoveStatus::Moved, None, Some(display_path(&target))),
        Err(err) => outcome(MoveStatus::Failed, Some(format!("Could not move it: {err}")), None),
    }
}

/// Whether this exact path is something [`scan`] would have produced.
///
/// The name test alone is not enough — a screenshot folder's files match by
/// location, and those are most of them — so a path under a
/// [`RootKind::ScreenshotFolder`] passes if it is an image. Ancestry is
/// checked on canonicalised paths so `..` and a symlinked home directory
/// cannot be used to dress an arbitrary path up as one inside a root.
fn is_known_screenshot(roots: &[ScanRoot], source: &Path, name: &str) -> bool {
    if name_marks_screenshot(name) {
        return true;
    }
    if !is_image(name) {
        return false;
    }

    let Ok(canonical) = fs::canonicalize(source) else {
        return false;
    };
    roots.iter().any(|root| {
        root.kind == RootKind::ScreenshotFolder
            && fs::canonicalize(&root.path).is_ok_and(|root_path| canonical.starts_with(root_path))
    })
}

/// Checks that `path` is a screenshot this tool found, and hands back the
/// file itself.
///
/// The guard shared by the two commands that hand a path to the OS — Open and
/// Show in folder. Neither changes anything, but both hand a path to
/// something outside the app, and section 66 is clear that "the frontend sent
/// it" is not a reason to. Same test as the move: a path that no scan would
/// have produced is refused.
pub fn resolve(roots: &[ScanRoot], path: &str) -> ServiceResult<PathBuf> {
    let source = Path::new(path);
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    if !source.is_file() {
        return Err(ServiceError::not_found(format!(
            "{name} is no longer there. Rescan to see what is."
        )));
    }
    if !is_known_screenshot(roots, source, &name) {
        return Err(ServiceError::validation(format!(
            "{name} is not one of the screenshots that were found."
        )));
    }

    Ok(source.to_path_buf())
}

/// A free path in `dir` for `name`: the name itself, else `stem (1).ext`,
/// `stem (2).ext`, ... Gives up rather than looping forever.
///
/// This is the whole of the no-overwrite guarantee, and it is a check rather
/// than a lock: two organises running at once could in principle both see the
/// same name free. Nothing in the app can produce that — there is one user and
/// one confirm dialog — and the OS rename that follows is the real arbiter.
fn unique_destination(dir: &Path, name: &str) -> Option<PathBuf> {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return Some(candidate);
    }

    let path = Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let extension = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    (1..=999).find_map(|n| {
        let candidate = dir.join(format!("{stem} ({n}){extension}"));
        (!candidate.exists()).then_some(candidate)
    })
}

/// Renames, falling back to copy-then-remove when the two paths are on
/// different volumes — the one case `rename` cannot serve, and the common one
/// here, because "organise onto the external drive" is a thing people do.
///
/// The fallback undoes its own copy if the source cannot be removed, so the
/// file is never left in two places. That is the direction to fail in: a
/// duplicate is a file the user now has to find and delete, which is exactly
/// the work this tool exists to save.
fn move_file(source: &Path, target: &Path) -> std::io::Result<()> {
    if fs::rename(source, target).is_ok() {
        return Ok(());
    }

    fs::copy(source, target)?;
    if let Err(err) = fs::remove_file(source) {
        let _ = fs::remove_file(target);
        return Err(err);
    }
    Ok(())
}

/// `"12 screenshots moved"`, plus whatever else happened.
fn summarize(moved: usize, skipped: usize, failed: usize) -> String {
    let mut parts = vec![format!(
        "{moved} {} moved",
        if moved == 1 { "screenshot" } else { "screenshots" }
    )];
    if skipped > 0 {
        parts.push(format!("{skipped} skipped"));
    }
    if failed > 0 {
        parts.push(format!("{failed} failed"));
    }
    parts.join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// UTC+8, the offset the app is developed at — chosen because it makes
    /// "local midnight is not UTC midnight" visible in every day-boundary
    /// test below.
    const PLUS_EIGHT: i64 = 8 * 3600;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("routine-launcher-screenshots-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, b"png").unwrap();
        path
    }

    // -- naming -------------------------------------------------------------

    #[test]
    fn recognises_what_the_capture_tools_actually_produce() {
        for name in [
            "Screenshot 2026-08-29 143022.png",             // Windows
            "Screenshot (12).png",                          // Windows, Print Screen
            "Screenshot 2026-08-29 at 14.30.22.png",        // macOS
            "Screen Shot 2019-01-05 at 2.30.22 PM.png",     // macOS, older
            "Screenshot from 2026-08-29 14-30-22.png",      // GNOME
            "Screenshot_20260829_143022.png",               // KDE Spectacle
            "Spectacle_20260829_143022.png",
            "Annotation 2020-01-01 120000.png",             // Snip & Sketch
            "Snip_20260829143022.jpg",
            "CleanShot 2026-08-29 at 14.30.22@2x.png",
            "my great screenshot.PNG",
        ] {
            assert!(name_marks_screenshot(name), "{name} should match");
        }
    }

    #[test]
    fn leaves_ordinary_files_alone() {
        for name in [
            "IMG_20260829_143022.jpg",   // a phone photo
            "2026-08-29_14-30-22.png",   // a bare timestamp: only location can tell
            "annotations.png",           // not `annotation <date>`
            "sniper.png",                // not `snip <date>`
            "snipping tool notes.png",
            "capture 1.png",             // one digit is not a year
            "holiday.jpg",
            "diagram.svg",               // not an image extension we accept
        ] {
            assert!(!name_marks_screenshot(name), "{name} should not match");
        }
    }

    #[test]
    fn location_matches_only_inside_a_screenshot_folder() {
        assert_eq!(
            match_reason("anything.png", RootKind::ScreenshotFolder),
            Some(MatchReason::Location)
        );
        assert_eq!(match_reason("anything.png", RootKind::General), None);
        // A screenshot name is reported as a name match even in a screenshot
        // folder — the stronger claim wins.
        assert_eq!(
            match_reason("Screenshot (1).png", RootKind::ScreenshotFolder),
            Some(MatchReason::Name)
        );
        // Not an image, so neither rule applies.
        assert_eq!(match_reason("Screenshot notes.txt", RootKind::ScreenshotFolder), None);
        assert_eq!(match_reason("Screen Recording.mov", RootKind::ScreenshotFolder), None);
    }

    // -- the clock ----------------------------------------------------------

    #[test]
    fn day_boundaries_are_local_midnight_not_utc_midnight() {
        let clock = LocalClock::new(PLUS_EIGHT);
        // 2026-08-29 02:00 UTC is 10:00 on the 29th locally.
        let now = 1_787_968_800;
        let windows = clock.windows(now);

        // Local midnight on the 29th is 16:00 UTC on the 28th.
        assert_eq!(clock.month_key(windows.today_start), "2026-08");
        assert_eq!(windows.today_start, now - 10 * 3600);
        assert_eq!(windows.week_start, windows.today_start - 6 * 86_400);
        assert_eq!(windows.month_start, windows.today_start - 29 * 86_400);

        assert_eq!(windows.bucket(now), ScreenshotBucket::Today);
        assert_eq!(windows.bucket(windows.today_start), ScreenshotBucket::Today);
        assert_eq!(windows.bucket(windows.today_start - 1), ScreenshotBucket::ThisWeek);
        assert_eq!(windows.bucket(windows.week_start - 1), ScreenshotBucket::ThisMonth);
        assert_eq!(windows.bucket(windows.month_start - 1), ScreenshotBucket::Older);
    }

    #[test]
    fn the_windows_nest_so_the_panel_reads_downwards() {
        let clock = LocalClock::new(PLUS_EIGHT);
        let now = 1_787_968_800;
        let windows = clock.windows(now);
        assert!(windows.month_start < windows.week_start);
        assert!(windows.week_start < windows.today_start);
        assert!(windows.today_start <= now);
    }

    #[test]
    fn month_keys_survive_leap_years_and_negative_offsets() {
        let utc = LocalClock::new(0);
        assert_eq!(utc.month_key(0), "1970-01");
        assert_eq!(utc.month_key(1_709_164_800), "2024-02"); // 2024-02-29
        assert_eq!(utc.month_key(1_735_689_600), "2025-01"); // 2025-01-01 00:00
        assert_eq!(utc.month_key(1_735_689_599), "2024-12"); // one second earlier

        // New York in winter: the last five hours of the UTC day are still the
        // previous local day, and the month key has to follow the local one.
        let new_york = LocalClock::new(-5 * 3600);
        assert_eq!(new_york.month_key(1_735_689_600), "2024-12");
    }

    // -- scanning -----------------------------------------------------------

    #[test]
    fn scans_both_kinds_of_root_and_reports_every_folder() {
        let base = temp_dir("scan");
        let shots = base.join("Screenshots");
        let desktop = base.join("Desktop");
        fs::create_dir_all(shots.join("2026")).unwrap();
        fs::create_dir_all(&desktop).unwrap();

        write(&shots, "anything.png");
        write(&shots, "notes.txt");
        write(&shots.join("2026"), "holiday.jpg");
        write(&desktop, "Screenshot 2026-08-29 143022.png");
        write(&desktop, "budget.xlsx");
        write(&desktop, "holiday.jpg");

        let roots = vec![
            ScanRoot::new("Screenshots", shots.clone(), RootKind::ScreenshotFolder),
            ScanRoot::new("Desktop", desktop.clone(), RootKind::General),
            ScanRoot::new("Nowhere", base.join("Nowhere"), RootKind::General),
        ];

        let result = scan(&roots, LocalClock::new(PLUS_EIGHT), 1_787_968_800);

        // The screenshot folder contributes both images (including the one in
        // its subfolder); the desktop contributes only the matching name.
        assert_eq!(result.total, 3);
        assert_eq!(result.sources[0].matched, 2);
        assert_eq!(result.sources[1].matched, 1);
        assert!(!result.sources[2].exists);
        assert_eq!(result.sources[2].matched, 0);
        assert!(!result.truncated);

        let names: HashSet<&str> = result.screenshots.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains("anything.png"));
        assert!(names.contains("holiday.jpg"));
        assert!(names.contains("Screenshot 2026-08-29 143022.png"));
        assert!(!names.contains("notes.txt"));
        assert!(!names.contains("budget.xlsx"));

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_general_root_is_not_walked_into_its_subfolders() {
        let base = temp_dir("shallow");
        let nested = base.join("archive");
        fs::create_dir_all(&nested).unwrap();
        write(&base, "Screenshot top.png");
        write(&nested, "Screenshot nested.png");

        let roots = vec![ScanRoot::new("Desktop", base.clone(), RootKind::General)];
        let result = scan(&roots, LocalClock::new(0), 1_787_968_800);

        assert_eq!(result.total, 1);
        assert_eq!(result.screenshots[0].name, "Screenshot top.png");

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn counts_are_cumulative_and_add_up() {
        let base = temp_dir("counts");
        write(&base, "Screenshot a.png");
        write(&base, "Screenshot b.png");

        let roots = vec![ScanRoot::new("Desktop", base.clone(), RootKind::General)];
        // Files were written just now, so both land in Today — and Today's
        // members have to appear in every wider window too.
        let result = scan(&roots, LocalClock::new(PLUS_EIGHT), now_epoch());

        assert_eq!(result.total, 2);
        assert_eq!(result.today, 2);
        assert_eq!(result.this_week, 2);
        assert_eq!(result.this_month, 2);
        assert_eq!(result.older, 0);
        // The invariant section 42's panel depends on: each line contains the
        // one above it, and `older` is whatever is left.
        assert!(result.today <= result.this_week);
        assert!(result.this_week <= result.this_month);
        assert_eq!(result.this_month + result.older, result.total);

        fs::remove_dir_all(&base).unwrap();
    }

    // -- organising ---------------------------------------------------------

    fn scan_root_for(dir: &Path) -> Vec<ScanRoot> {
        vec![ScanRoot::new("Screenshots", dir.to_path_buf(), RootKind::ScreenshotFolder)]
    }

    #[test]
    fn moves_only_what_was_asked_for_and_never_overwrites() {
        let base = temp_dir("organize");
        let shots = base.join("Screenshots");
        let target = base.join("Archive");
        fs::create_dir_all(&shots).unwrap();
        fs::create_dir_all(&target).unwrap();

        let first = write(&shots, "Screenshot one.png");
        let second = write(&shots, "anything.png");
        write(&shots, "left alone.png");
        // A file already in the destination under the name the first one wants.
        fs::write(target.join("Screenshot one.png"), b"older").unwrap();

        let request = OrganizeRequest {
            paths: vec![display_path(&first), display_path(&second)],
            destination: display_path(&target),
            grouping: Grouping::Single,
        };

        let result = organize(&scan_root_for(&shots), LocalClock::new(0), &request).unwrap();

        assert_eq!(result.moved, 2);
        assert_eq!(result.failed, 0);
        assert_eq!(result.summary, "2 screenshots moved");
        // The file that was already there is untouched, and the incoming one
        // was renamed around it.
        assert_eq!(fs::read(target.join("Screenshot one.png")).unwrap(), b"older");
        assert!(target.join("Screenshot one (1).png").exists());
        assert!(target.join("anything.png").exists());
        // Nothing the user did not name was moved.
        assert!(shots.join("left alone.png").exists());
        assert!(!first.exists());

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn refuses_a_path_the_scan_would_not_have_found() {
        let base = temp_dir("refuse");
        let shots = base.join("Screenshots");
        let elsewhere = base.join("Documents");
        let target = base.join("Archive");
        fs::create_dir_all(&shots).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        fs::create_dir_all(&target).unwrap();

        let taxes = write(&elsewhere, "taxes.png");

        let request = OrganizeRequest {
            paths: vec![display_path(&taxes)],
            destination: display_path(&target),
            grouping: Grouping::Single,
        };

        let result = organize(&scan_root_for(&shots), LocalClock::new(0), &request).unwrap();

        assert_eq!(result.moved, 0);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.outcomes[0].status, MoveStatus::Skipped);
        assert!(taxes.exists(), "a refused file must stay where it is");

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn by_month_files_into_folders_named_for_the_local_month() {
        let base = temp_dir("by-month");
        let shots = base.join("Screenshots");
        let target = base.join("Archive");
        fs::create_dir_all(&shots).unwrap();
        fs::create_dir_all(&target).unwrap();

        let shot = write(&shots, "Screenshot one.png");
        let request = OrganizeRequest {
            paths: vec![display_path(&shot)],
            destination: display_path(&target),
            grouping: Grouping::ByMonth,
        };

        let clock = LocalClock::new(PLUS_EIGHT);
        let expected = clock.month_key(modified_epoch(&fs::metadata(&shot).unwrap()));

        let result = organize(&scan_root_for(&shots), clock, &request).unwrap();

        assert_eq!(result.moved, 1);
        assert!(target.join(&expected).join("Screenshot one.png").exists());
        assert!(result.outcomes[0].new_path.as_deref().unwrap().contains(&expected));

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_file_already_in_the_destination_is_skipped_rather_than_shuffled() {
        let base = temp_dir("already-there");
        let target = base.join("Screenshots");
        fs::create_dir_all(&target).unwrap();
        let shot = write(&target, "Screenshot one.png");

        let request = OrganizeRequest {
            paths: vec![display_path(&shot)],
            destination: display_path(&target),
            grouping: Grouping::Single,
        };

        let result = organize(&scan_root_for(&target), LocalClock::new(0), &request).unwrap();

        assert_eq!(result.skipped, 1);
        assert_eq!(result.moved, 0);
        assert!(shot.exists());

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn rejects_a_destination_that_is_not_a_folder() {
        let base = temp_dir("bad-destination");
        let shot = write(&base, "Screenshot one.png");

        for destination in ["", "   ", "definitely/not/here"] {
            let request = OrganizeRequest {
                paths: vec![display_path(&shot)],
                destination: destination.to_owned(),
                grouping: Grouping::Single,
            };
            assert!(organize(&scan_root_for(&base), LocalClock::new(0), &request).is_err());
        }

        // And an empty selection is refused before anything is touched.
        let request = OrganizeRequest {
            paths: Vec::new(),
            destination: display_path(&base),
            grouping: Grouping::Single,
        };
        assert!(organize(&scan_root_for(&base), LocalClock::new(0), &request).is_err());
        assert!(shot.exists());

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn reports_a_missing_file_without_giving_up_on_the_rest() {
        let base = temp_dir("missing");
        let shots = base.join("Screenshots");
        let target = base.join("Archive");
        fs::create_dir_all(&shots).unwrap();
        fs::create_dir_all(&target).unwrap();
        let real = write(&shots, "Screenshot real.png");

        let request = OrganizeRequest {
            paths: vec![
                display_path(&shots.join("Screenshot gone.png")),
                display_path(&real),
            ],
            destination: display_path(&target),
            grouping: Grouping::Single,
        };

        let result = organize(&scan_root_for(&shots), LocalClock::new(0), &request).unwrap();

        assert_eq!(result.failed, 1);
        assert_eq!(result.moved, 1);
        assert_eq!(result.summary, "1 screenshot moved, 1 failed");
        assert!(target.join("Screenshot real.png").exists());

        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn reads_the_local_offset_from_sqlite() {
        let conn = crate::db::init_memory_db().unwrap();
        let clock = LocalClock::from_db(&conn).unwrap();
        // Whatever the machine's timezone, the offset has to be a whole number
        // of minutes inside the range real timezones use.
        assert!(clock.utc_offset.abs() <= 14 * 3600);
        assert_eq!(clock.utc_offset % 60, 0);
    }
}
