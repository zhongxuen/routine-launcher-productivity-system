//! Downloads Cleanup (development-plan.md sections 38-39).
//!
//! ```text
//! DOWNLOADS
//!
//! Files:
//! 147
//!
//! Categories:
//!
//! Images       53
//! Documents    31
//! ZIP          12
//! Installers   18
//! Other        33
//!
//! Largest:
//! 2.4 GB
//!
//! [ Review Downloads ]
//! ```
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
//! only function the UI calls without being asked to. [`move_files`] and
//! [`delete_files`] each take an explicit list of paths, refuse an empty one,
//! and are only ever reached from a confirmation the user clicked through.
//! There is deliberately no "clean up everything" entry point for a quest, a
//! routine or a schedule to call: section 67's "destructive actions must
//! always be user initiated" is kept by there being no other way in.
//!
//! ---------------------------------------------------------------------------
//! WHY THE PATHS ARE CHECKED AGAIN HERE
//!
//! The frontend hands back the same paths [`scan`] gave it, so it is tempting
//! to trust them. This module does not. Every path an action touches goes
//! through [`resolve_file`] first, which re-reads it from disk and refuses
//! anything that is not a plain file sitting directly in the folder that was
//! scanned — no folders, no symlinks, nothing reached by `..`, nothing
//! outside Downloads at all.
//!
//! That is section 66 applied to filesystem calls rather than to shell
//! commands: a bug in a React component, or a stale list from a scan taken
//! ten minutes ago, must not be able to turn "delete these four installers"
//! into a delete somewhere else on the disk. The check costs one `stat` per
//! file and removes the entire class of mistake.
//!
//! ---------------------------------------------------------------------------
//! WHAT A SCAN LOOKS AT
//!
//! The top level of the folder, and only files. Sub-folders are counted and
//! reported so the summary can say they were left alone, but they are never
//! descended into and never actionable — a cleanup tool that could delete a
//! folder tree from a checkbox is a different, much more dangerous tool than
//! the one section 39 describes. Anything that cannot be read (a permission
//! error, a file that vanished mid-scan) is counted rather than raised: one
//! locked file is not a reason to refuse to show the other hundred.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use super::error::{ServiceError, ServiceResult};

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/// The five buckets of section 39's mockup.
///
/// The wire values are the lowercase names, and `src/types/downloads.ts`
/// declares exactly the same five strings — a category is called the same
/// thing here, across `invoke`, and in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileCategory {
    Images,
    Documents,
    Zip,
    Installers,
    Other,
}

impl FileCategory {
    /// The label section 39 prints, so the summary reads the same in the UI
    /// as it does in the plan.
    pub fn label(self) -> &'static str {
        match self {
            Self::Images => "Images",
            Self::Documents => "Documents",
            Self::Zip => "ZIP",
            Self::Installers => "Installers",
            Self::Other => "Other",
        }
    }
}

/// Mockup order. The summary always lists all five, including the empty ones,
/// so the shape of the panel does not change between scans.
const CATEGORY_ORDER: [FileCategory; 5] = [
    FileCategory::Images,
    FileCategory::Documents,
    FileCategory::Zip,
    FileCategory::Installers,
    FileCategory::Other,
];

const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "heic", "heif", "tif", "tiff", "ico",
    "avif", "raw", "cr2", "nef", "psd",
];

const DOCUMENT_EXTENSIONS: &[&str] = &[
    "pdf", "doc", "docx", "odt", "rtf", "txt", "md", "xls", "xlsx", "ods", "csv", "ppt", "pptx",
    "odp", "epub", "mobi", "pages", "numbers", "key", "tex",
];

/// Archives. Named "ZIP" in the mockup because that is what the pile in a
/// Downloads folder is called; the bucket covers the other archive formats
/// too, since they are the same thing to somebody deciding what to keep.
const ARCHIVE_EXTENSIONS: &[&str] = &[
    "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz", "xz", "zst", "lz", "lzma", "cab", "arj",
];

/// Anything whose reason for existing is to install something else. `.iso`
/// and `.img` are here rather than with the archives for the same reason: a
/// disc image in Downloads is almost always an installer someone burned or
/// mounted once.
const INSTALLER_EXTENSIONS: &[&str] = &[
    "exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "dmg", "pkg", "deb", "rpm",
    "appimage", "apk", "iso", "img", "snap", "flatpak",
];

/// Buckets a file by its extension, case-insensitively. A file with no
/// extension at all is `Other`.
pub fn categorize(extension: Option<&str>) -> FileCategory {
    let Some(extension) = extension else {
        return FileCategory::Other;
    };
    let extension = extension.to_ascii_lowercase();
    let extension = extension.as_str();

    if IMAGE_EXTENSIONS.contains(&extension) {
        FileCategory::Images
    } else if DOCUMENT_EXTENSIONS.contains(&extension) {
        FileCategory::Documents
    } else if ARCHIVE_EXTENSIONS.contains(&extension) {
        FileCategory::Zip
    } else if INSTALLER_EXTENSIONS.contains(&extension) {
        FileCategory::Installers
    } else {
        FileCategory::Other
    }
}

// ---------------------------------------------------------------------------
// What a scan produces
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ScannedFile {
    /// Absolute path. This is the handle the UI sends back for an action, and
    /// it is re-checked by [`resolve_file`] before anything happens to it.
    pub path: String,
    pub name: String,
    /// Lowercased, without the dot. `None` for a file that has none.
    pub extension: Option<String>,
    pub size_bytes: u64,
    pub category: FileCategory,
    /// Last-modified time in seconds since the Unix epoch, or `None` on a
    /// filesystem that would not say. The UI uses it to show age, which is
    /// most of how somebody decides whether a download is still wanted.
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CategoryCount {
    pub category: FileCategory,
    /// Section 39's label, sent along so the UI does not keep a second copy
    /// of the same five words.
    pub label: &'static str,
    pub count: usize,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadsScan {
    /// The folder that was read, so the UI can name it rather than assume it.
    pub folder: String,
    pub file_count: usize,
    pub total_bytes: u64,
    /// All five buckets, in mockup order, including empty ones.
    pub categories: Vec<CategoryCount>,
    /// The "Largest: 2.4 GB" line of the mockup. `None` for an empty folder.
    pub largest: Option<ScannedFile>,
    /// Every file found, largest first — which is the order somebody
    /// reviewing a Downloads folder wants to read it in.
    pub files: Vec<ScannedFile>,
    /// Sub-folders seen and stepped over, so the summary can say so.
    pub folder_count: usize,
    /// Entries that could not be read. Reported, never fatal.
    pub unreadable_count: usize,
}

// ---------------------------------------------------------------------------
// What an action produces
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct FileActionOutcome {
    pub path: String,
    pub name: String,
    pub ok: bool,
    /// A sentence worth showing the user. `None` when `ok`.
    pub error: Option<String>,
    /// Where the file ended up, for a move that worked. The destination
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
    /// partial failure can name the files it could not touch.
    pub outcomes: Vec<FileActionOutcome>,
}

impl ActionReport {
    fn from_outcomes(outcomes: Vec<FileActionOutcome>, bytes: u64) -> Self {
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

/// Reads the top level of `folder` and describes what is in it.
///
/// Pure reading: nothing is opened, changed, moved or removed. This is step
/// one of section 67's order and the only step that happens without the user
/// having selected anything.
pub fn scan(folder: &Path) -> ServiceResult<DownloadsScan> {
    let entries = fs::read_dir(folder).map_err(|error| {
        ServiceError::not_found(format!(
            "Could not read {}: {error}",
            folder.to_string_lossy()
        ))
    })?;

    let mut files: Vec<ScannedFile> = Vec::new();
    let mut folder_count = 0usize;
    let mut unreadable_count = 0usize;

    for entry in entries {
        let Ok(entry) = entry else {
            unreadable_count += 1;
            continue;
        };

        // `DirEntry::metadata` does not follow links, so a shortcut is
        // described as a shortcut rather than as whatever it points at —
        // which keeps a link to a 40 GB folder out of the file list, and out
        // of the "Largest" line.
        let Ok(metadata) = entry.metadata() else {
            unreadable_count += 1;
            continue;
        };

        if metadata.is_dir() {
            folder_count += 1;
            continue;
        }

        if !metadata.is_file() {
            // A symlink or something stranger. Counted, not listed: it is not
            // a download, and it is not something this tool should offer to
            // delete.
            unreadable_count += 1;
            continue;
        }

        let path = entry.path();
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let extension = path
            .extension()
            .map(|extension| extension.to_string_lossy().to_ascii_lowercase());

        files.push(ScannedFile {
            path: path.to_string_lossy().into_owned(),
            name,
            category: categorize(extension.as_deref()),
            extension,
            size_bytes: metadata.len(),
            modified_at: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|since| since.as_secs()),
        });
    }

    // Largest first, then by name so two files of the same size do not swap
    // places between scans.
    files.sort_by(|left, right| {
        right
            .size_bytes
            .cmp(&left.size_bytes)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    let categories = CATEGORY_ORDER
        .iter()
        .map(|&category| {
            let matching = files.iter().filter(|file| file.category == category);
            let (count, size_bytes) = matching.fold((0usize, 0u64), |(count, bytes), file| {
                (count + 1, bytes + file.size_bytes)
            });
            CategoryCount {
                category,
                label: category.label(),
                count,
                size_bytes,
            }
        })
        .collect();

    Ok(DownloadsScan {
        folder: folder.to_string_lossy().into_owned(),
        file_count: files.len(),
        total_bytes: files.iter().map(|file| file.size_bytes).sum(),
        categories,
        // Sorted largest first, so the first entry is the mockup's "Largest".
        largest: files.first().cloned(),
        files,
        folder_count,
        unreadable_count,
    })
}

// ---------------------------------------------------------------------------
// The guard every action goes through
// ---------------------------------------------------------------------------

/// Re-reads `path` and answers with it only if it is still a plain file
/// sitting directly inside `folder`.
///
/// Five ways this says no, and each is a way an action could otherwise touch
/// something it was never shown:
///
/// * the file is gone (deleted, or moved, since the scan);
/// * it is a folder — this utility never acts on folder trees;
/// * it is a symlink, which would let a link in Downloads stand in for a file
///   anywhere on the disk;
/// * it does not resolve to something inside `folder`, which is what stops
///   `..` and an absolute path from somewhere else;
/// * it is nested deeper than the top level, which the scan never listed.
pub fn resolve_file(folder: &Path, path: &str) -> ServiceResult<PathBuf> {
    let candidate = PathBuf::from(path);

    let metadata = fs::symlink_metadata(&candidate).map_err(|_| {
        ServiceError::not_found(format!("{path} is no longer there — run the scan again."))
    })?;

    if metadata.file_type().is_symlink() {
        return Err(ServiceError::validation(format!(
            "{path} is a shortcut, not a downloaded file, so it was left alone."
        )));
    }

    if metadata.is_dir() {
        return Err(ServiceError::validation(format!(
            "{path} is a folder. Downloads Cleanup only ever acts on files."
        )));
    }

    if !metadata.is_file() {
        return Err(ServiceError::validation(format!(
            "{path} is not an ordinary file, so it was left alone."
        )));
    }

    // Canonicalising both sides is what makes the comparison meaningful:
    // `C:\Users\me\Downloads\..\Documents\tax.pdf` and a short 8.3 path both
    // become the real location before they are compared.
    let folder = fs::canonicalize(folder).map_err(|error| {
        ServiceError::not_found(format!(
            "Could not read {}: {error}",
            folder.to_string_lossy()
        ))
    })?;
    let resolved = fs::canonicalize(&candidate)
        .map_err(|_| ServiceError::not_found(format!("{path} is no longer there.")))?;

    if resolved.parent() != Some(folder.as_path()) {
        return Err(ServiceError::validation(format!(
            "{path} is not in {} — it was left alone.",
            folder.to_string_lossy()
        )));
    }

    Ok(resolved)
}

/// Checks the folder a move is aimed at: it has to exist, be a directory, and
/// not be the folder the files are already in.
fn resolve_destination(folder: &Path, destination: &str) -> ServiceResult<PathBuf> {
    let trimmed = destination.trim();
    if trimmed.is_empty() {
        return Err(ServiceError::validation(
            "Choose a folder to move the files into.",
        ));
    }

    let resolved = fs::canonicalize(trimmed).map_err(|_| {
        ServiceError::not_found(format!("{trimmed} is not a folder that exists."))
    })?;

    if !resolved.is_dir() {
        return Err(ServiceError::validation(format!(
            "{trimmed} is a file, not a folder."
        )));
    }

    let source = fs::canonicalize(folder).map_err(|error| {
        ServiceError::not_found(format!(
            "Could not read {}: {error}",
            folder.to_string_lossy()
        ))
    })?;

    if resolved == source {
        return Err(ServiceError::validation(
            "Those files are already in that folder. Pick a different one.",
        ));
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
            "Select at least one file first — nothing was changed.",
        ));
    }

    Ok(unique)
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

/// Moves the selected files into `destination`.
///
/// The safe half of the pair, and the one the UI puts first: a file that
/// turned out to be wanted after all is still there to be moved back.
///
/// Every file is attempted even if an earlier one failed, and the report
/// names each result — a locked file part-way down the list should not
/// silently abandon the rest of a selection the user made deliberately.
pub fn move_files(
    folder: &Path,
    paths: &[String],
    destination: &str,
) -> ServiceResult<ActionReport> {
    let paths = selected_paths(paths)?;
    let destination = resolve_destination(folder, destination)?;

    let mut outcomes = Vec::with_capacity(paths.len());
    let mut bytes = 0u64;

    for path in paths {
        let name = file_name_of(&path);

        let resolved = match resolve_file(folder, &path) {
            Ok(resolved) => resolved,
            Err(error) => {
                outcomes.push(FileActionOutcome {
                    path,
                    name,
                    ok: false,
                    error: Some(error.to_string()),
                    moved_to: None,
                });
                continue;
            }
        };

        let size = fs::metadata(&resolved).map(|metadata| metadata.len()).unwrap_or(0);
        let target = match unique_destination(&destination, &name) {
            Ok(target) => target,
            Err(error) => {
                outcomes.push(FileActionOutcome {
                    path,
                    name,
                    ok: false,
                    error: Some(error.to_string()),
                    moved_to: None,
                });
                continue;
            }
        };

        match move_one(&resolved, &target) {
            Ok(()) => {
                bytes += size;
                outcomes.push(FileActionOutcome {
                    path,
                    name,
                    ok: true,
                    error: None,
                    moved_to: Some(target.to_string_lossy().into_owned()),
                });
            }
            Err(error) => outcomes.push(FileActionOutcome {
                path,
                name,
                ok: false,
                error: Some(error),
                moved_to: None,
            }),
        }
    }

    Ok(ActionReport::from_outcomes(outcomes, bytes))
}

/// Renames, and copies-then-removes when a rename cannot cross the boundary
/// between two volumes — which is the ordinary case for "move this to the
/// external drive".
///
/// If the copy lands but the original will not go, the file is reported as a
/// failure and the copy is left in place. That is deliberate: the user now
/// has both, which is recoverable, whereas removing a copy we are not certain
/// of would not be.
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

/// Deletes the selected files, permanently.
///
/// The end of section 67's chain and the only function in the app that
/// removes a user's file. It is reachable from exactly one place — the
/// confirmation step of the review flow, with a list the user ticked — and it
/// has no scheduled, quest-driven or "clean up automatically" caller, by
/// design.
///
/// There is no undo, which is why the UI says so on the confirmation and why
/// Move is offered beside it.
pub fn delete_files(folder: &Path, paths: &[String]) -> ServiceResult<ActionReport> {
    let paths = selected_paths(paths)?;

    let mut outcomes = Vec::with_capacity(paths.len());
    let mut bytes = 0u64;

    for path in paths {
        let name = file_name_of(&path);

        let resolved = match resolve_file(folder, &path) {
            Ok(resolved) => resolved,
            Err(error) => {
                outcomes.push(FileActionOutcome {
                    path,
                    name,
                    ok: false,
                    error: Some(error.to_string()),
                    moved_to: None,
                });
                continue;
            }
        };

        let size = fs::metadata(&resolved).map(|metadata| metadata.len()).unwrap_or(0);

        match fs::remove_file(&resolved) {
            Ok(()) => {
                bytes += size;
                outcomes.push(FileActionOutcome {
                    path,
                    name,
                    ok: true,
                    error: None,
                    moved_to: None,
                });
            }
            Err(error) => outcomes.push(FileActionOutcome {
                path,
                name,
                ok: false,
                error: Some(format!("Could not delete it: {error}")),
                moved_to: None,
            }),
        }
    }

    Ok(ActionReport::from_outcomes(outcomes, bytes))
}

/// The trailing component of a path, for reporting on a file that may not
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

    #[test]
    fn categorizes_by_extension_case_insensitively() {
        assert_eq!(categorize(Some("PNG")), FileCategory::Images);
        assert_eq!(categorize(Some("pdf")), FileCategory::Documents);
        assert_eq!(categorize(Some("zip")), FileCategory::Zip);
        assert_eq!(categorize(Some("msi")), FileCategory::Installers);
        assert_eq!(categorize(Some("weird")), FileCategory::Other);
        assert_eq!(categorize(None), FileCategory::Other);
    }

    #[test]
    fn an_empty_selection_is_refused() {
        assert!(selected_paths(&[]).is_err());
        assert!(selected_paths(&["  ".to_string()]).is_err());
    }

    #[test]
    fn duplicate_paths_are_collapsed() {
        let paths = vec!["a.zip".to_string(), "a.zip".to_string(), "b.zip".to_string()];
        assert_eq!(selected_paths(&paths).unwrap().len(), 2);
    }

    #[test]
    fn a_path_outside_the_folder_is_refused() {
        let folder = std::env::temp_dir();
        let outside = folder.join("..").join("definitely-not-here.txt");
        assert!(resolve_file(&folder, &outside.to_string_lossy()).is_err());
    }

    // -----------------------------------------------------------------------
    // The tests below work on real files, in a temporary folder of their own,
    // because everything worth being sure about here is what happens on disk:
    // that a scan describes the folder correctly, that an action touches the
    // files it was given and no others, and — most of all — that a path from
    // outside is refused rather than acted on.
    // -----------------------------------------------------------------------

    /// A private temp folder, removed when the test ends however it ends.
    struct TempFolder(PathBuf);

    impl TempFolder {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "routine-launcher-downloads-{}-{name}",
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

        fn dir(&self, name: &str) {
            fs::create_dir_all(self.0.join(name)).expect("could not create the test sub-folder");
        }
    }

    impl Drop for TempFolder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_scan_counts_categorizes_and_orders_by_size() {
        let folder = TempFolder::new("scan");
        folder.file("photo.png", 300);
        folder.file("notes.pdf", 200);
        folder.file("bundle.zip", 900);
        folder.file("setup.exe", 500);
        folder.file("mystery.qqq", 100);
        folder.dir("extracted");

        let scan = scan(folder.path()).expect("the scan should succeed");

        assert_eq!(scan.file_count, 5);
        assert_eq!(scan.total_bytes, 2_000);
        assert_eq!(scan.folder_count, 1, "sub-folders are counted, not listed");
        assert_eq!(scan.categories.len(), 5, "all five buckets, empty ones included");

        let count = |category: FileCategory| {
            scan.categories
                .iter()
                .find(|entry| entry.category == category)
                .expect("every bucket is present")
                .count
        };
        assert_eq!(count(FileCategory::Images), 1);
        assert_eq!(count(FileCategory::Documents), 1);
        assert_eq!(count(FileCategory::Zip), 1);
        assert_eq!(count(FileCategory::Installers), 1);
        assert_eq!(count(FileCategory::Other), 1);

        assert_eq!(scan.largest.expect("a largest file").name, "bundle.zip");
        assert_eq!(scan.files.first().expect("a first file").name, "bundle.zip");
        assert_eq!(scan.files.last().expect("a last file").name, "mystery.qqq");
    }

    #[test]
    fn a_delete_removes_only_what_was_selected() {
        let folder = TempFolder::new("delete");
        let doomed = folder.file("old.zip", 40);
        let kept = folder.file("wanted.pdf", 10);

        let report = delete_files(folder.path(), std::slice::from_ref(&doomed)).expect("the delete should run");

        assert_eq!(report.succeeded, 1);
        assert_eq!(report.failed, 0);
        assert_eq!(report.bytes, 40);
        assert!(!Path::new(&doomed).exists());
        assert!(Path::new(&kept).exists(), "an unselected file is untouched");
    }

    #[test]
    fn a_delete_of_a_file_outside_the_folder_touches_nothing() {
        let downloads = TempFolder::new("delete-guard-downloads");
        let elsewhere = TempFolder::new("delete-guard-elsewhere");
        let outsider = elsewhere.file("payslip.pdf", 10);

        let report =
            delete_files(downloads.path(), std::slice::from_ref(&outsider)).expect("the call still reports");

        assert_eq!(report.succeeded, 0);
        assert_eq!(report.failed, 1);
        assert!(
            Path::new(&outsider).exists(),
            "a file outside Downloads must survive being asked for by path"
        );
    }

    #[test]
    fn an_empty_selection_changes_nothing() {
        let folder = TempFolder::new("empty-selection");
        let kept = folder.file("keep.zip", 10);

        assert!(delete_files(folder.path(), &[]).is_err());
        assert!(Path::new(&kept).exists());
    }

    #[test]
    fn a_move_relocates_the_file_and_never_overwrites() {
        let folder = TempFolder::new("move-source");
        let destination = TempFolder::new("move-target");
        let source = folder.file("report.pdf", 25);
        // Something of the same name is already waiting in the destination.
        fs::write(destination.path().join("report.pdf"), b"existing")
            .expect("could not seed the destination");

        let report = move_files(
            folder.path(),
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
            "the file already in the destination is left exactly as it was"
        );
    }

    #[test]
    fn a_move_into_the_folder_being_scanned_is_refused() {
        let folder = TempFolder::new("move-onto-self");
        let source = folder.file("thing.zip", 10);

        assert!(move_files(
            folder.path(),
            std::slice::from_ref(&source),
            &folder.path().to_string_lossy()
        )
        .is_err());
        assert!(Path::new(&source).exists());
    }

    #[test]
    fn a_folder_is_never_acted_on() {
        let folder = TempFolder::new("folder-guard");
        folder.dir("keep-me");
        let nested = folder.path().join("keep-me");

        let report = delete_files(folder.path(), &[nested.to_string_lossy().into_owned()])
            .expect("the call still reports");

        assert_eq!(report.failed, 1);
        assert!(nested.is_dir(), "the folder is still there");
    }
}
