//! The Storage Overview (development-plan.md sections 38, 66, 67).
//!
//! The sixth of section 38's utilities and the one section 81 does not
//! schedule. It answers two questions and asks none: how much room is left on
//! each fixed drive, and which folders of the user's profile are holding it.
//!
//! # It is the one Cleanup tool that cannot change anything
//!
//! Section 67's sequence — scan, show results, user selects, confirm, perform
//! action — is what the four tools beside this one are built around. This one
//! stops at "show results". There is no move here, no delete, no archive, no
//! ignore list and no confirmation dialog, because there is nothing to
//! confirm: every function in this file opens directories and reads metadata
//! and that is the whole of it. Section 66's "restrict dangerous operations"
//! is kept the strongest way available — by there being no dangerous
//! operation to restrict.
//!
//! What it does instead is *point*. A folder holding 40 GB is a question the
//! Large File Finder and the Duplicate Finder already answer, so the view
//! links into them with the folder pre-filled. That is what makes a read-only
//! page belong under Cleanup rather than under Settings.
//!
//! # Why the sizing is one folder per call
//!
//! Adding up a profile tree takes tens of seconds — `AppData` alone is
//! commonly a hundred thousand files — and a single `size_the_profile`
//! command would have to finish all of it before the user saw anything.
//! [`folder_size`] therefore sizes exactly one top-level folder, and the view
//! calls it once per folder and draws each answer as it lands. Three
//! properties fall out of that shape rather than having to be arranged:
//!
//! * **It reports as it goes.** Every call is a complete answer about one
//!   folder, so there is nothing to stream and no partial state to hold.
//! * **It is cancellable.** [`begin_scan`] hands out a token and
//!   [`cancel_scan`] invalidates it; the walk checks the token as it goes and
//!   stops where it is. The call in flight comes back with what it had, and
//!   the view simply stops asking for the rest.
//! * **It cannot hold anything up.** No `Connection` is taken — the same rule
//!   `large_files` follows, and for the same reason: the app shares one
//!   SQLite connection behind a mutex, and a walk holding it would stop the
//!   tray, the reminder scheduler and every other window with it.
//!
//! # A folder it cannot read is not an error
//!
//! Parts of `AppData` are locked by Windows on every machine, and a scan that
//! failed on the first one would fail on every machine. Unreadable folders
//! are counted into [`FolderSize::skipped_folders`] and the walk carries on,
//! so the answer is "at least this much, and we could not look in 7 places"
//! rather than a red panel. Only a folder that does not exist, or that is not
//! a folder, is refused outright — and that is refused before any walking
//! starts.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use serde::Serialize;

use super::error::{ServiceError, ServiceResult};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/// How many directory entries one folder's walk will look at before it stops.
/// A guard against a profile folder that has become a build cache with a
/// million files in it, not a limit a normal `Documents` will ever meet.
pub const MAX_ENTRIES: u64 = 600_000;

/// How long one folder's walk will run before it stops. Per folder rather
/// than per scan: the point of sizing one folder per call is that each one
/// comes back, and a folder that cannot be finished in this long is reported
/// as "at least" instead of holding the other eleven up behind it.
pub const MAX_FOLDER_SECONDS: u64 = 25;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One fixed drive — a row of the top half of the page.
///
/// `camelCase` on the wire like the other Stage 10 services, because none of
/// this mirrors a database row: it is read from the OS at the moment of the
/// request and stored nowhere.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    /// The drive root as a path — `C:\`.
    pub root: String,
    /// Just the letter, for the badge in the corner of the row.
    pub letter: String,
    /// The volume label, or an empty string when the volume has none. Not
    /// defaulted to "Local Disk" here: what to call an unlabelled drive is
    /// the view's decision, and the service should not invent a name that
    /// looks like it came from the OS.
    pub label: String,
    /// `NTFS`, `exFAT`, and so on. Shown small, because it is the thing that
    /// tells two identical-looking drives apart.
    pub file_system: String,
    pub total_bytes: u64,
    /// Free space as the user may use it. This is the figure Explorer prints,
    /// which is bytes available *to the caller* rather than bytes unused —
    /// they differ on a volume with a quota, and the number in this app has
    /// to agree with the number in the file manager beside it.
    pub free_bytes: u64,
    /// `total_bytes` less the volume's total free space. Derived here so the
    /// bar and the caption cannot disagree about what "used" means.
    pub used_bytes: u64,
    /// True for the drive holding the user's profile, so the view can say
    /// which of three drives the folder list below is about.
    pub holds_profile: bool,
}

/// One top-level folder of the profile, before anything has been added up.
///
/// Returned by [`overview`] so the view can draw the whole list at once and
/// then fill sizes in. Listing a directory is instantaneous; sizing one is
/// not, and the gap between those two facts is the whole design of this
/// feature.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileFolder {
    /// Absolute path, and the identity [`folder_size`] is called with.
    pub path: String,
    /// The folder name alone — `Downloads`.
    pub name: String,
    /// True for a folder Windows hides, which `AppData` is. Shown as a quiet
    /// marker rather than a warning: it is usually the largest row on the
    /// page and the user has every right to know why they have never seen it.
    pub hidden: bool,
}

/// Why a walk stopped before it had seen the whole folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanStop {
    /// [`MAX_ENTRIES`] entries were visited.
    EntryLimit,
    /// [`MAX_FOLDER_SECONDS`] elapsed.
    TimeLimit,
    /// The scan token was invalidated — the user pressed Stop, or started a
    /// new scan over this one.
    Cancelled,
}

/// What one folder came to.
///
/// Every field is an "at least" when `stopped` is set, and the view says so
/// rather than printing a partial total as if it were final.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSize {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub file_count: u64,
    pub folder_count: u64,
    /// How many folders could not be opened. A count and not a list: on a
    /// profile scan these are nearly all inside `AppData`, they are locked on
    /// every Windows machine there has ever been, and naming them would read
    /// as a list of problems rather than as the footnote it is.
    pub skipped_folders: u64,
    /// Set when the walk gave up early, in which case `size_bytes` is a floor
    /// rather than a total.
    pub stopped: Option<ScanStop>,
    pub duration_ms: u64,
}

/// Everything the page can draw before any sizing has happened: the drives,
/// where the profile is, and what is directly inside it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOverview {
    pub drives: Vec<Drive>,
    /// The profile directory itself — `C:\Users\Ada`.
    pub profile: String,
    /// Its top-level folders, alphabetically. The order they are *sized* in,
    /// which is not the order they end up displayed in.
    pub folders: Vec<ProfileFolder>,
    /// The token every [`folder_size`] call for this overview must carry. See
    /// [`begin_scan`].
    pub token: u64,
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/// The generation of the current scan.
///
/// A counter rather than a flag because there is no moment at which a scan
/// "ends": the view makes a dozen separate calls, and a flag would have to be
/// cleared by whichever of them finished last. A monotonic token has no such
/// moment — a call carrying a stale one is stale, and starting a new scan
/// invalidates the old one for free.
///
/// `static` rather than Tauri state so a service test can drive it without a
/// runtime, and because there is exactly one storage page in one window.
static GENERATION: AtomicU64 = AtomicU64::new(1);

/// Starts a scan and returns its token, invalidating any scan already
/// running.
pub fn begin_scan() -> u64 {
    GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

/// Stops whatever is walking now. The call in flight returns what it has with
/// [`ScanStop::Cancelled`] set; nothing is left behind, because nothing was
/// ever held.
pub fn cancel_scan() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// True while `token` is still the scan the user is looking at.
pub fn is_current(token: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) == token
}

// ---------------------------------------------------------------------------
// Drives
// ---------------------------------------------------------------------------

/// Every fixed drive, with what is on it.
///
/// Fixed only — section 38 asks where the user's disk went, and a memory
/// stick that happens to be plugged in is not an answer to that. Network
/// drives are left out for the additional reason that measuring one can block
/// for as long as the share takes to answer.
///
/// A drive that cannot be measured is left out rather than shown as zero: a
/// row reading "0 B free" is a lie the user might act on, and a missing row
/// is merely incomplete.
#[cfg(windows)]
pub fn fixed_drives(profile: &Path) -> Vec<Drive> {
    /// The `kernel32` surface this needs. Declared here rather than pulled in
    /// from the `windows` crate for the same reason `services::logging`
    /// declares `MessageBoxW`: it is four functions, and they have not
    /// changed since Windows 2000.
    mod win32 {
        #[link(name = "kernel32")]
        extern "system" {
            pub fn GetLogicalDrives() -> u32;
            pub fn GetDriveTypeW(root: *const u16) -> u32;
            pub fn GetDiskFreeSpaceExW(
                directory: *const u16,
                free_bytes_available_to_caller: *mut u64,
                total_number_of_bytes: *mut u64,
                total_number_of_free_bytes: *mut u64,
            ) -> i32;
            pub fn GetVolumeInformationW(
                root: *const u16,
                volume_name: *mut u16,
                volume_name_size: u32,
                serial_number: *mut u32,
                max_component_length: *mut u32,
                file_system_flags: *mut u32,
                file_system_name: *mut u16,
                file_system_name_size: u32,
            ) -> i32;
        }

        /// `DRIVE_FIXED`. The one type this page is about.
        pub const FIXED: u32 = 3;
    }

    fn wide(text: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// A NUL-terminated UTF-16 buffer as a `String`.
    fn from_wide(buffer: &[u16]) -> String {
        let end = buffer.iter().position(|&unit| unit == 0).unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..end])
    }

    let profile_letter = drive_letter(profile);
    // SAFETY: no arguments, no pointers, and the return is a plain bitmask of
    // which letters are in use.
    let mask = unsafe { win32::GetLogicalDrives() };
    let mut drives = Vec::new();

    for bit in 0..26u32 {
        if mask & (1 << bit) == 0 {
            continue;
        }

        let letter = char::from(b'A' + bit as u8);
        let root = format!("{letter}:\\");
        let root_wide = wide(&root);

        // SAFETY: `root_wide` is a NUL-terminated UTF-16 buffer owned by this
        // loop iteration, so it outlives every call it is passed to below.
        if unsafe { win32::GetDriveTypeW(root_wide.as_ptr()) } != win32::FIXED {
            continue;
        }

        let mut free_to_caller: u64 = 0;
        let mut total: u64 = 0;
        let mut total_free: u64 = 0;

        // SAFETY: three out-parameters, each a live `u64` on this stack frame
        // for the whole call. A zero return means the drive could not be
        // measured, in which case none of them has been written.
        let measured = unsafe {
            win32::GetDiskFreeSpaceExW(
                root_wide.as_ptr(),
                &mut free_to_caller,
                &mut total,
                &mut total_free,
            )
        } != 0;

        if !measured || total == 0 {
            continue;
        }

        // `MAX_PATH + 1`, which is what both buffers are documented to need.
        let mut label_buffer = [0u16; 261];
        let mut fs_buffer = [0u16; 261];

        // SAFETY: both buffers are stack arrays whose length is passed
        // alongside them, and the three out-parameters this does not want are
        // null, which the function documents as allowed. A zero return leaves
        // the buffers as they were — all zeroes, which reads back as "".
        let named = unsafe {
            win32::GetVolumeInformationW(
                root_wide.as_ptr(),
                label_buffer.as_mut_ptr(),
                label_buffer.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                fs_buffer.as_mut_ptr(),
                fs_buffer.len() as u32,
            )
        } != 0;

        drives.push(Drive {
            letter: letter.to_string(),
            label: if named { from_wide(&label_buffer) } else { String::new() },
            file_system: if named { from_wide(&fs_buffer) } else { String::new() },
            total_bytes: total,
            free_bytes: free_to_caller,
            used_bytes: total.saturating_sub(total_free),
            holds_profile: profile_letter == Some(letter.to_ascii_uppercase()),
            root,
        });
    }

    drives
}

/// Everywhere else there are no drive letters and nothing to enumerate. The
/// page still works — the profile folders below are the half that is not
/// Windows-specific — and says that drive space was unavailable rather than
/// implying the machine has no disks.
#[cfg(not(windows))]
pub fn fixed_drives(_profile: &Path) -> Vec<Drive> {
    Vec::new()
}

/// The upper-case drive letter a path is on, or `None` for a path that is not
/// on a lettered drive (a UNC share, or anything on a platform without them).
fn drive_letter(path: &Path) -> Option<char> {
    let text = path.to_string_lossy();
    let mut characters = text.chars();
    let letter = characters.next()?.to_ascii_uppercase();

    (letter.is_ascii_alphabetic() && characters.next() == Some(':')).then_some(letter)
}

// ---------------------------------------------------------------------------
// The profile's folders
// ---------------------------------------------------------------------------

/// The drives, plus the top-level folders of `profile` and a fresh scan
/// token.
///
/// Fast: one `read_dir` of one directory and a handful of OS calls, so the
/// page is on screen before any sizing has started. Beginning a scan here
/// rather than in the first [`folder_size`] call is what makes re-opening the
/// page abandon the walk the last visit left running.
pub fn overview(profile: &Path) -> ServiceResult<StorageOverview> {
    if !profile.is_dir() {
        return Err(ServiceError::not_found(format!(
            "Your user folder ({}) could not be read.",
            profile.display()
        )));
    }

    Ok(StorageOverview {
        drives: fixed_drives(profile),
        profile: profile.display().to_string(),
        folders: profile_folders(profile)?,
        token: begin_scan(),
    })
}

/// The real directories directly inside `profile`, alphabetically.
///
/// Two things are left out, and both matter on a Windows profile:
///
/// * **Reparse points.** `Application Data`, `My Documents`, `Local Settings`
///   and their friends are junctions Windows keeps for programs written
///   before Vista. Following them would count `AppData` three times over and,
///   for the ones that point at an ancestor, would not terminate.
/// * **Loose files.** `NTUSER.DAT` and the rest are not folders and are not
///   the user's to move. Section 38's question is which *folder* is holding
///   the disk.
///
/// Hidden folders are kept. `AppData` is hidden and is very often the biggest
/// thing in the profile, so hiding it would leave the page unable to answer
/// the question it exists to answer.
fn profile_folders(profile: &Path) -> ServiceResult<Vec<ProfileFolder>> {
    let listing = fs::read_dir(profile).map_err(|error| {
        ServiceError::not_found(format!(
            "Your user folder ({}) could not be read: {error}",
            profile.display()
        ))
    })?;

    let mut folders = Vec::new();

    for entry in listing.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        // True for junctions as well as symlinks on Windows — both are
        // name-surrogate reparse points, which is exactly the set to skip.
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }

        let path = entry.path();
        folders.push(ProfileFolder {
            name: entry.file_name().to_string_lossy().into_owned(),
            hidden: is_hidden(&entry),
            path: path.display().to_string(),
        });
    }

    // Alphabetical, case-insensitively, because this is the order the folders
    // are *sized* in and it should not depend on what the filesystem happens
    // to hand back. The order they are *shown* in is largest-first, which is
    // the view's job since it is the only one that knows which have landed.
    folders.sort_by_key(|folder| folder.name.to_lowercase());
    Ok(folders)
}

/// Whether Windows hides this entry. Everywhere else, the Unix convention.
fn is_hidden(entry: &fs::DirEntry) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        /// `FILE_ATTRIBUTE_HIDDEN`.
        const HIDDEN: u32 = 0x0000_0002;

        entry
            .metadata()
            .map(|meta| meta.file_attributes() & HIDDEN != 0)
            .unwrap_or(false)
    }

    #[cfg(not(windows))]
    {
        entry.file_name().to_string_lossy().starts_with('.')
    }
}

// ---------------------------------------------------------------------------
// Sizing one folder
// ---------------------------------------------------------------------------

/// Adds up everything under `folder`, which must be a top-level folder of
/// `profile`.
///
/// Read-only from beginning to end: it opens directories and reads metadata,
/// and there is no branch in it that writes, moves or removes anything.
/// Section 66's rule about restricting dangerous operations has nothing to
/// bite on here, so the only thing worth guarding is the read itself — hence
/// the check that the folder really is one of the profile's own. A stray
/// `invoke` cannot use this page to measure `C:\Windows`, not because
/// measuring would hurt but because a command should only do the thing it is
/// named for.
///
/// Three things it deliberately does not do, all three the same as
/// `large_files::scan`:
///
/// * **Follow symlinks and junctions**, which on a profile would loop.
/// * **Fail on a folder it cannot open.** It is counted and the walk carries
///   on; a locked `AppData` subfolder is normal.
/// * **Run forever.** [`MAX_ENTRIES`] and [`MAX_FOLDER_SECONDS`] both stop it
///   and set `stopped`, so a partial total is never printed as a final one.
///
/// `token` is what makes it cancellable: it is checked as the walk goes, and
/// the moment it stops being the current scan the walk returns what it has.
pub fn folder_size(profile: &Path, folder: &Path, token: u64) -> ServiceResult<FolderSize> {
    if folder.parent() != Some(profile) {
        return Err(ServiceError::validation(format!(
            "{} is not one of the folders in {}.",
            folder.display(),
            profile.display()
        )));
    }
    if !folder.is_dir() {
        return Err(ServiceError::not_found(format!(
            "{} is no longer there.",
            folder.display()
        )));
    }

    let started = Instant::now();
    let mut pending: Vec<PathBuf> = vec![folder.to_path_buf()];

    let mut size_bytes: u64 = 0;
    let mut entries_seen: u64 = 0;
    let mut file_count: u64 = 0;
    let mut folder_count: u64 = 0;
    let mut skipped_folders: u64 = 0;
    let mut stopped: Option<ScanStop> = None;

    'walk: while let Some(current) = pending.pop() {
        let listing = match fs::read_dir(&current) {
            Ok(listing) => listing,
            Err(_) => {
                // Almost always a permission error, and on a profile scan
                // almost always inside `AppData`. Counted, not raised.
                skipped_folders += 1;
                continue;
            }
        };

        for entry in listing {
            let Ok(entry) = entry else { continue };

            entries_seen += 1;
            if entries_seen >= MAX_ENTRIES {
                stopped = Some(ScanStop::EntryLimit);
                break 'walk;
            }
            // The clock and the token are both checked on a cadence rather
            // than per entry: `Instant::now` and an atomic load are cheap but
            // not free, and 2048 entries is a few milliseconds — far below
            // the point where a Stop button feels unresponsive.
            if entries_seen % 2_048 == 0 {
                if !is_current(token) {
                    stopped = Some(ScanStop::Cancelled);
                    break 'walk;
                }
                if started.elapsed().as_secs() >= MAX_FOLDER_SECONDS {
                    stopped = Some(ScanStop::TimeLimit);
                    break 'walk;
                }
            }

            let Ok(file_type) = entry.file_type() else { continue };

            // Neither followed nor counted: a junction's contents belong to
            // wherever they really live, and counting them here would put the
            // same bytes in two rows of the same list.
            if file_type.is_symlink() {
                continue;
            }

            if file_type.is_dir() {
                folder_count += 1;
                pending.push(entry.path());
                continue;
            }

            if !file_type.is_file() {
                continue;
            }

            let Ok(metadata) = entry.metadata() else { continue };
            file_count += 1;
            size_bytes = size_bytes.saturating_add(metadata.len());
        }
    }

    // Checked once more at the end so a cancel that arrived during the last
    // directory is still reported as a cancel rather than as a complete
    // answer the view would then keep.
    if stopped.is_none() && !is_current(token) {
        stopped = Some(ScanStop::Cancelled);
    }

    Ok(FolderSize {
        path: folder.display().to_string(),
        name: folder
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size_bytes,
        file_count,
        folder_count,
        skipped_folders,
        stopped,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch profile that removes itself. The tests here are about real
    /// directories — that is the whole subject — so they build a small one
    /// under the OS temp directory rather than mocking a filesystem.
    struct TempProfile(PathBuf);

    impl TempProfile {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("rl-storage-{name}"));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn file(&self, relative: &str, bytes: usize) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, vec![b'x'; bytes]).unwrap();
        }

        fn dir(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for TempProfile {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Cargo runs tests on several threads and [`GENERATION`] is one counter
    /// for the whole process, so any test that asserts about a token has to
    /// have it to itself — otherwise a neighbour calling [`begin_scan`] would
    /// cancel this one's walk and the failure would look like a bug in the
    /// walk. Held for the body of the test; a poisoned lock is taken anyway,
    /// since the only thing it guards is a number.
    fn scan_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn the_overview_lists_folders_and_leaves_loose_files_out() {
        let profile = TempProfile::new("listing");
        profile.dir("Documents");
        profile.dir("Downloads");
        profile.file("NTUSER.DAT", 16);

        let overview = overview(profile.path()).unwrap();
        let names: Vec<_> = overview.folders.iter().map(|f| f.name.as_str()).collect();

        assert_eq!(names, vec!["Documents", "Downloads"]);
        assert_eq!(overview.profile, profile.path().display().to_string());
    }

    #[test]
    fn folders_are_listed_alphabetically_whatever_order_they_were_made_in() {
        let profile = TempProfile::new("order");
        for name in ["Videos", "appdata", "Documents"] {
            profile.dir(name);
        }

        let overview = overview(profile.path()).unwrap();
        let names: Vec<_> = overview.folders.iter().map(|f| f.name.as_str()).collect();

        assert_eq!(names, vec!["appdata", "Documents", "Videos"]);
    }

    #[test]
    fn a_folder_size_is_everything_underneath_it() {
        let _scans = scan_lock();
        let profile = TempProfile::new("sizing");
        profile.file("Documents/notes.txt", 1_000);
        profile.file("Documents/work/report.pdf", 2_500);
        profile.file("Documents/work/deep/scan.png", 500);
        // In a sibling folder, so it must not be counted.
        profile.file("Downloads/installer.exe", 9_000);

        let token = begin_scan();
        let sized = folder_size(profile.path(), &profile.path().join("Documents"), token).unwrap();

        assert_eq!(sized.size_bytes, 4_000);
        assert_eq!(sized.file_count, 3);
        assert_eq!(sized.folder_count, 2);
        assert_eq!(sized.skipped_folders, 0);
        assert!(sized.stopped.is_none());
        assert_eq!(sized.name, "Documents");
    }

    #[test]
    fn an_empty_folder_is_zero_rather_than_an_error() {
        let _scans = scan_lock();
        let profile = TempProfile::new("empty");
        let empty = profile.dir("Music");

        let sized = folder_size(profile.path(), &empty, begin_scan()).unwrap();

        assert_eq!(sized.size_bytes, 0);
        assert_eq!(sized.file_count, 0);
        assert!(sized.stopped.is_none());
    }

    #[test]
    fn a_cancelled_walk_comes_back_with_what_it_had() {
        let _scans = scan_lock();
        let profile = TempProfile::new("cancelled");
        profile.file("AppData/cache.bin", 4_096);

        let token = begin_scan();
        // Cancelled before the walk starts, which is the same condition the
        // walk sees mid-way through a large tree.
        cancel_scan();

        let sized = folder_size(profile.path(), &profile.path().join("AppData"), token).unwrap();

        assert_eq!(sized.stopped, Some(ScanStop::Cancelled));
        assert!(!is_current(token), "the token should no longer be the current scan");
    }

    #[test]
    fn a_new_overview_invalidates_the_scan_before_it() {
        let _scans = scan_lock();
        let profile = TempProfile::new("generations");
        profile.dir("Documents");

        let first = overview(profile.path()).unwrap().token;
        let second = overview(profile.path()).unwrap().token;

        assert_ne!(first, second);
        assert!(!is_current(first), "the first scan should have been abandoned");
        assert!(is_current(second));
    }

    #[test]
    fn sizing_is_refused_for_anything_that_is_not_a_folder_of_the_profile() {
        let profile = TempProfile::new("scope");
        profile.file("Documents/notes.txt", 10);
        let token = begin_scan();

        // A folder one level deeper is not one of the profile's own.
        let nested = profile.path().join("Documents").join("work");
        fs::create_dir_all(&nested).unwrap();
        assert!(folder_size(profile.path(), &nested, token).is_err());

        // Nor is somewhere else entirely.
        assert!(folder_size(profile.path(), Path::new("C:\\Windows"), token).is_err());

        // Nor is a file, even one sitting directly inside the profile.
        profile.file("NTUSER.DAT", 16);
        assert!(folder_size(profile.path(), &profile.path().join("NTUSER.DAT"), token).is_err());

        // Nor is a folder that is not there at all.
        assert!(folder_size(profile.path(), &profile.path().join("gone"), token).is_err());
    }

    #[test]
    fn a_missing_profile_is_an_error_rather_than_an_empty_page() {
        let missing = std::env::temp_dir().join("rl-storage-does-not-exist");
        let _ = fs::remove_dir_all(&missing);

        assert!(overview(&missing).is_err());
    }

    /// The FFI, against whatever drives this machine has.
    ///
    /// It cannot assert that there is a `C:` — a build machine may have
    /// anything — so it asserts the things that have to hold of any drive it
    /// *does* report. That is enough to catch the failures worth catching
    /// here: an out-parameter left unwritten, the three figures swapped, or a
    /// letter derived from the wrong bit of the mask.
    #[cfg(windows)]
    #[test]
    fn every_drive_reported_is_one_that_could_exist() {
        let profile = std::env::temp_dir();

        for drive in fixed_drives(&profile) {
            assert!(drive.total_bytes > 0, "{} was reported with no size", drive.root);
            assert!(
                drive.used_bytes <= drive.total_bytes,
                "{} claims to use more than it holds",
                drive.root
            );
            assert!(
                drive.free_bytes <= drive.total_bytes,
                "{} claims more free space than it holds",
                drive.root
            );
            assert_eq!(drive.letter.len(), 1, "{} has no single letter", drive.root);
            assert_eq!(drive.root, format!("{}:\\", drive.letter));
        }
    }

    #[test]
    fn drive_letters_are_read_off_a_path_and_only_a_real_one() {
        assert_eq!(drive_letter(Path::new("c:\\Users\\Ada")), Some('C'));
        assert_eq!(drive_letter(Path::new("D:\\")), Some('D'));
        assert_eq!(drive_letter(Path::new("\\\\server\\share")), None);
        assert_eq!(drive_letter(Path::new("/home/ada")), None);
    }
}
