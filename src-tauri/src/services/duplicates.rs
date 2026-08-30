//! Duplicate Finder — development-plan.md sections 38, 40 and 67.
//!
//! # Deterministic, and only deterministic
//!
//! Section 40 is unusually prescriptive about *how* to decide two files are
//! the same: "Use deterministic file comparison. Compare: filename, file size,
//! hash." Nothing here guesses. Two files are reported as identical when their
//! bytes are identical, full stop; two files are reported as *likely* related
//! when their names are the same once the copy markers a file manager adds
//! (`photo (1).png`, `photo - Copy.png`) are taken off. Those are the only two
//! claims this module makes, they are labelled differently on the way out, and
//! neither of them is "this file looks unimportant".
//!
//! The comparison runs in that order because it gets cheaper to be sure and
//! more expensive to check as it goes:
//!
//! 1. **Size.** Files of different lengths cannot be identical, so a size that
//!    only one file has is the end of the question — and that is most files.
//! 2. **Head hash.** Within a size, the first [`HEAD_HASH_BYTES`] are hashed.
//!    Two videos of exactly the same length that differ at all almost always
//!    differ early, and this settles them without reading the other gigabyte.
//! 3. **Full hash.** Only for files that survived both, and it is what the
//!    `Identical` verdict actually rests on.
//! 4. **Filename.** Applied to whatever is left over, and reported as its own
//!    weaker kind — see [`DuplicateGroupKind::SimilarName`].
//!
//! # Nothing here deletes anything on its own
//!
//! Section 67's order is `scan -> show results -> user selects -> confirm ->
//! perform action`, and this module is split along it. [`scan`] only reads: it
//! opens files to hash them and never writes, moves or removes one. The three
//! functions that do touch the disk — [`delete_files`], [`move_files`],
//! [`open_containing_folder`] — take an explicit list of paths and act on
//! exactly that list. There is no path from a scan result to a deletion that
//! does not go through the frontend handing those paths back, which is what
//! makes "destructive actions must always be user initiated" a property of the
//! code rather than a promise about the UI.
//!
//! That is also why nothing is auto-selected and why the module never picks a
//! winner. [`ScannedFile::suggested_keep`] marks the oldest copy in a group as
//! *a* reasonable one to keep, because the original is normally the one the
//! copies came from — it is a hint the user can act on with one click, not a
//! decision, and a scan in which the user does nothing changes nothing.
//!
//! # Bounds
//!
//! A scan walks folders the user chose, and "the user chose their home
//! directory" has to be survivable. [`MAX_DEPTH`], [`MAX_FILES`] and the
//! [`SKIPPED_DIRECTORIES`] deny-list keep a walk finite; when a limit is what
//! stopped it, [`DuplicateScan::truncated`] says so rather than letting a
//! partial answer look complete.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::services::error::{ServiceError, ServiceResult};

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/// How far below a chosen folder the walk goes.
///
/// Deep enough for the nested export/backup trees duplicates actually hide in,
/// shallow enough that pointing the scan at a home directory full of
/// checked-out repositories terminates.
const MAX_DEPTH: usize = 12;

/// How many files one scan will look at before it stops and admits it.
const MAX_FILES: usize = 60_000;

/// The smallest file a scan considers by default.
///
/// One kilobyte, because the alternative is a result page led by fifty
/// identical empty `.gitkeep`s and desktop shortcuts. Nothing is reclaimed by
/// removing those and finding them buries the 4.2 MB photo in section 40's
/// mockup, which is the case the tool exists for. Callers can lower it.
pub const DEFAULT_MIN_SIZE_BYTES: u64 = 1024;

/// Bytes read from the front of a file for the cheap pass described in the
/// module docs. 64 KiB is a handful of disk reads and is past the header of
/// every container format that would otherwise collide.
const HEAD_HASH_BYTES: u64 = 64 * 1024;

/// Read buffer for the full hash.
const HASH_BUFFER_BYTES: usize = 64 * 1024;

/// Directory names never descended into.
///
/// Two different reasons, and both matter. `node_modules`, `.git` and
/// `target` are *supposed* to contain thousands of byte-identical files —
/// reporting them as duplicates would be reporting that a package manager
/// works. `$RECYCLE.BIN`, `System Volume Information` and `AppData` are the
/// OS's, and a cleanup tool that offers to delete out of them is a cleanup
/// tool that breaks the machine.
const SKIPPED_DIRECTORIES: &[&str] = &[
    "$recycle.bin",
    ".git",
    ".svn",
    "appdata",
    "node_modules",
    "system volume information",
    "target",
    "venv",
    "__pycache__",
];

/// How many paths a single destructive call may carry. Large enough for "every
/// copy in a long result", small enough that a malformed payload cannot ask the
/// app to spend a minute deleting.
const MAX_ACTION_PATHS: usize = 2_000;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// What the frontend asks a scan to do.
///
/// Every field has a default, so `{}` is a valid request meaning "the folders
/// the app suggests, recursively, over 1 KiB". The command layer is what turns
/// an empty `folders` into Downloads + Desktop, because those paths come from
/// the OS through Tauri's path resolver and this module stays free of the
/// runtime.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateScanRequest {
    /// Absolute paths to scan. Overlapping and repeated entries are collapsed.
    #[serde(default)]
    pub folders: Vec<String>,
    /// Whether to descend into subfolders (to [`MAX_DEPTH`]).
    #[serde(default = "default_true")]
    pub include_subfolders: bool,
    /// Files smaller than this are not considered. See
    /// [`DEFAULT_MIN_SIZE_BYTES`].
    #[serde(default = "default_min_size")]
    pub min_size_bytes: u64,
}

impl Default for DuplicateScanRequest {
    fn default() -> Self {
        Self {
            folders: Vec::new(),
            include_subfolders: true,
            min_size_bytes: DEFAULT_MIN_SIZE_BYTES,
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_min_size() -> u64 {
    DEFAULT_MIN_SIZE_BYTES
}

/// One file inside a duplicate group.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    /// Absolute path, as the action commands expect it back.
    pub path: String,
    /// File name with extension — `photo (1).png`.
    pub name: String,
    /// The containing directory, so the UI can say where a copy lives without
    /// re-parsing the path.
    pub folder: String,
    pub size_bytes: u64,
    /// Last-modified time as Unix epoch milliseconds, or `null` where the
    /// filesystem would not say. Milliseconds rather than a formatted string
    /// because `new Date(ms)` is the frontend's own clock and every other
    /// timestamp in this app is rendered in local time.
    pub modified_ms: Option<i64>,
    /// Hex SHA-256 of the whole file, present only on
    /// [`DuplicateGroupKind::Identical`] groups — it is the evidence for that
    /// verdict, and a same-name group has, by construction, no shared hash.
    pub hash: Option<String>,
    /// The copy this module would keep if it had to choose: the oldest, which
    /// is normally the one the others were made from. A hint behind an
    /// explicit button, never a pre-selection — see the module docs.
    pub suggested_keep: bool,
}

/// Which of section 40's two comparisons put a group together.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DuplicateGroupKind {
    /// Same size and same SHA-256. These files are the same file; keeping one
    /// loses nothing.
    Identical,
    /// Same name once copy markers are stripped, but *different* contents.
    /// Worth showing — it is how a half-finished edit and its original end up
    /// side by side — but the user has to look, so the UI says so plainly.
    SimilarName,
}

/// A set of files section 40 would print under one heading.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    /// Stable identity for React keys and for selection state that has to
    /// survive a re-scan: the content hash for an identical group, the
    /// normalised name for a same-name one.
    pub id: String,
    pub kind: DuplicateGroupKind,
    /// What to call the group — the shortest file name in it, which is the
    /// original rather than the `- Copy` in every case a file manager creates.
    pub name: String,
    /// The shared size of an identical group; the largest member's size for a
    /// same-name one, where the sizes differ by definition.
    pub size_bytes: u64,
    /// What removing every copy but one would free. Zero for a same-name
    /// group: nothing there is known to be redundant, so nothing is promised.
    pub reclaimable_bytes: u64,
    /// Always at least two, ordered oldest first so the suggested keep leads.
    pub files: Vec<ScannedFile>,
}

/// A folder the walk could not read, and why.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFolder {
    pub path: String,
    pub reason: String,
}

/// Everything one scan found. The whole of what the Duplicates view renders.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateScan {
    /// The folders actually walked, after overlapping and missing ones were
    /// dropped — so the UI reports where the results came from rather than
    /// where they were requested from.
    pub roots: Vec<String>,
    pub include_subfolders: bool,
    pub min_size_bytes: u64,
    /// Files considered (size at or above the minimum, not skipped).
    pub scanned_files: u64,
    /// Of those, how many had to be read. Worth showing: it is the honest
    /// answer to "why did that take a while".
    pub hashed_files: u64,
    /// Redundant copies — every grouped file beyond the first in its group.
    pub duplicate_files: u64,
    /// Sum of every group's `reclaimable_bytes`.
    pub reclaimable_bytes: u64,
    /// Identical groups first, then same-name; each block largest saving
    /// first. Ties break on name and then id, so two scans of an unchanged
    /// folder produce the same order.
    pub groups: Vec<DuplicateGroup>,
    pub skipped: Vec<SkippedFolder>,
    /// A limit stopped the walk, so absence of a duplicate proves nothing.
    pub truncated: bool,
    pub elapsed_ms: u64,
}

/// What happened to one path in a delete or move.
///
/// Per path rather than per call because a partial failure is the normal case
/// — one file is open in another program, the rest go — and a single `Err`
/// would leave the UI unable to say which of the twelve it just asked about
/// is still there.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileActionResult {
    pub path: String,
    pub ok: bool,
    /// Where the file ended up, for a move that succeeded.
    pub new_path: Option<String>,
    /// User-presentable reason, for anything that did not.
    pub error: Option<String>,
}

impl FileActionResult {
    fn ok(path: &Path, new_path: Option<String>) -> Self {
        Self {
            path: display_path(path),
            ok: true,
            new_path,
            error: None,
        }
    }

    fn failed(path: &Path, error: impl Into<String>) -> Self {
        Self {
            path: display_path(path),
            ok: false,
            new_path: None,
            error: Some(error.into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// A file as the walk saw it, before anything has been compared.
struct Candidate {
    path: PathBuf,
    size: u64,
    modified_ms: Option<i64>,
}

/// Walks `request.folders` and groups what is in them (sections 38, 40).
///
/// Read-only. See the module docs for the order the comparisons run in and for
/// why the expensive one is last.
pub fn scan(request: &DuplicateScanRequest) -> ServiceResult<DuplicateScan> {
    let started = Instant::now();

    let roots = resolve_roots(&request.folders)?;
    let mut skipped = Vec::new();
    let mut truncated = false;

    let candidates = collect_candidates(&roots, request, &mut skipped, &mut truncated);
    let scanned_files = candidates.len() as u64;

    let (identical, leftovers, hashed_files) = group_identical(candidates, &mut skipped);
    let similar = group_by_name(leftovers);

    let mut groups = identical;
    groups.extend(similar);
    sort_groups(&mut groups);

    let duplicate_files = groups
        .iter()
        .map(|group| group.files.len() as u64 - 1)
        .sum();
    let reclaimable_bytes = groups.iter().map(|group| group.reclaimable_bytes).sum();

    Ok(DuplicateScan {
        roots: roots.iter().map(|root| display_path(root)).collect(),
        include_subfolders: request.include_subfolders,
        min_size_bytes: request.min_size_bytes,
        scanned_files,
        hashed_files,
        duplicate_files,
        reclaimable_bytes,
        groups,
        skipped,
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Turns requested folders into the set actually walked.
///
/// Three things happen here, and all three exist to stop one file being seen
/// twice — which would otherwise report it as a duplicate of itself:
/// non-directories are rejected, paths are canonicalised so `Downloads` and
/// `downloads\..\Downloads` collapse, and a folder nested inside another
/// requested folder is dropped in favour of its ancestor.
fn resolve_roots(folders: &[String]) -> ServiceResult<Vec<PathBuf>> {
    if folders.is_empty() {
        return Err(ServiceError::validation(
            "Choose at least one folder to scan.",
        ));
    }

    let mut resolved: Vec<PathBuf> = Vec::new();
    for folder in folders {
        let trimmed = folder.trim();
        if trimmed.is_empty() {
            continue;
        }

        let path = PathBuf::from(trimmed);
        let canonical = fs::canonicalize(&path).map_err(|err| {
            ServiceError::validation(format!("{trimmed} could not be opened: {err}"))
        })?;

        if !canonical.is_dir() {
            return Err(ServiceError::validation(format!(
                "{trimmed} is a file, not a folder."
            )));
        }

        if !resolved.contains(&canonical) {
            resolved.push(canonical);
        }
    }

    if resolved.is_empty() {
        return Err(ServiceError::validation(
            "Choose at least one folder to scan.",
        ));
    }

    // Drop anything already covered by another root. Compared after
    // canonicalisation so this is a genuine ancestor test and not string
    // matching on whatever the caller typed.
    let nested: Vec<PathBuf> = resolved
        .iter()
        .filter(|candidate| {
            resolved
                .iter()
                .any(|other| other != *candidate && candidate.starts_with(other))
        })
        .cloned()
        .collect();
    resolved.retain(|root| !nested.contains(root));
    resolved.sort();

    Ok(resolved)
}

/// Breadth-first walk of every root, collecting files worth comparing.
///
/// Failures are collected rather than raised: one unreadable folder in a home
/// directory is a normal Windows fact, and a scan that refused to report the
/// other nine thousand files because of it would be useless. `truncated` is
/// set when [`MAX_FILES`] is what ended the walk, so the caller can tell "no
/// duplicates" from "stopped looking".
fn collect_candidates(
    roots: &[PathBuf],
    request: &DuplicateScanRequest,
    skipped: &mut Vec<SkippedFolder>,
    truncated: &mut bool,
) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut queue: Vec<(PathBuf, usize)> = roots.iter().map(|root| (root.clone(), 0)).collect();

    while let Some((directory, depth)) = queue.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(err) => {
                skipped.push(SkippedFolder {
                    path: display_path(&directory),
                    reason: format!("could not be read: {err}"),
                });
                continue;
            }
        };

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    skipped.push(SkippedFolder {
                        path: display_path(&directory),
                        reason: format!("could not be read fully: {err}"),
                    });
                    break;
                }
            };

            let path = entry.path();

            // `symlink_metadata` rather than `metadata`, so a link is seen as
            // a link. Following one is how a walk leaves the folders the user
            // chose, and how it finds the same file under two names.
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.file_type().is_symlink() {
                continue;
            }

            if metadata.is_dir() {
                if !request.include_subfolders || depth + 1 > MAX_DEPTH {
                    continue;
                }
                if is_skipped_directory(&path) {
                    continue;
                }
                queue.push((path, depth + 1));
                continue;
            }

            if !metadata.is_file() || metadata.len() < request.min_size_bytes.max(1) {
                continue;
            }
            if is_hidden(&path) {
                continue;
            }

            if candidates.len() >= MAX_FILES {
                *truncated = true;
                return candidates;
            }

            // Canonicalising every file is the belt to `resolve_roots`'
            // braces: junctions and hard links can still put one file under
            // two paths, and a file compared with itself is a duplicate of
            // itself.
            let canonical = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if !seen.insert(canonical) {
                continue;
            }

            candidates.push(Candidate {
                size: metadata.len(),
                modified_ms: modified_ms(&metadata),
                path,
            });
        }
    }

    candidates
}

/// Size -> head hash -> full hash, exactly as the module docs describe.
///
/// Returns the identical groups, the files that did not end up in one (which
/// [`group_by_name`] then gets a look at), and how many files had to be read.
fn group_identical(
    candidates: Vec<Candidate>,
    skipped: &mut Vec<SkippedFolder>,
) -> (Vec<DuplicateGroup>, Vec<Candidate>, u64) {
    let mut by_size: HashMap<u64, Vec<Candidate>> = HashMap::new();
    for candidate in candidates {
        by_size.entry(candidate.size).or_default().push(candidate);
    }

    let mut groups = Vec::new();
    let mut leftovers = Vec::new();
    let mut hashed_files = 0_u64;

    for (_, same_size) in by_size {
        // A size only one file has settles it without opening anything.
        if same_size.len() < 2 {
            leftovers.extend(same_size);
            continue;
        }

        // Counted once, here, rather than per pass: the head hash reads every
        // file that shares a size, and the full hash only re-reads a subset of
        // them, so this is the number of files the scan actually opened.
        hashed_files += same_size.len() as u64;

        let by_head = bucket_by_hash(same_size, Some(HEAD_HASH_BYTES), skipped, &mut leftovers);
        for (_, same_head) in by_head {
            if same_head.len() < 2 {
                leftovers.extend(same_head);
                continue;
            }

            for (hash, same_content) in bucket_by_hash(same_head, None, skipped, &mut leftovers) {
                if same_content.len() < 2 {
                    leftovers.extend(same_content);
                    continue;
                }
                groups.push(identical_group(hash, same_content));
            }
        }
    }

    (groups, leftovers, hashed_files)
}

/// Hashes each candidate over `limit` bytes (or all of them) and buckets by
/// the result.
///
/// A file that cannot be read is not a failure of the scan — it is in use, or
/// permission-denied, both of which happen constantly in a Downloads folder.
/// It is noted in `skipped` and pushed to `leftovers`, where the name pass can
/// still notice it; what it never does is get asserted to be identical to
/// something on the strength of a hash we could not take.
fn bucket_by_hash(
    candidates: Vec<Candidate>,
    limit: Option<u64>,
    skipped: &mut Vec<SkippedFolder>,
    leftovers: &mut Vec<Candidate>,
) -> HashMap<String, Vec<Candidate>> {
    let mut buckets: HashMap<String, Vec<Candidate>> = HashMap::new();

    for candidate in candidates {
        match hash_file(&candidate.path, limit) {
            Ok(hash) => buckets.entry(hash).or_default().push(candidate),
            Err(err) => {
                skipped.push(SkippedFolder {
                    path: display_path(&candidate.path),
                    reason: format!("could not be read: {err}"),
                });
                leftovers.push(candidate);
            }
        }
    }

    buckets
}

/// Streaming SHA-256, over the whole file or its first `limit` bytes.
fn hash_file(path: &Path, limit: Option<u64>) -> std::io::Result<String> {
    let file = File::open(path)?;
    let mut reader: Box<dyn Read> = match limit {
        Some(limit) => Box::new(BufReader::new(file).take(limit)),
        None => Box::new(BufReader::new(file)),
    };

    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(hex(&hasher.finalize()))
}

/// Builds the group for a set of byte-identical files.
fn identical_group(hash: String, candidates: Vec<Candidate>) -> DuplicateGroup {
    let size = candidates.first().map(|file| file.size).unwrap_or(0);
    let files = into_files(candidates, Some(&hash));
    let name = group_name(&files);

    DuplicateGroup {
        id: format!("identical:{hash}"),
        kind: DuplicateGroupKind::Identical,
        name,
        size_bytes: size,
        // Every copy but one is redundant, and they are all the same length.
        reclaimable_bytes: size * (files.len() as u64 - 1),
        files,
    }
}

/// Section 40's filename comparison, over everything the content pass did not
/// already account for.
///
/// The files in a group here are *not* known to be the same — the hash pass
/// has already proved they are not, or could not read them — so the group
/// promises no reclaimable bytes and the UI labels it as needing a look.
fn group_by_name(candidates: Vec<Candidate>) -> Vec<DuplicateGroup> {
    let mut by_name: HashMap<String, Vec<Candidate>> = HashMap::new();
    for candidate in candidates {
        let Some(key) = name_key(&candidate.path) else {
            continue;
        };
        by_name.entry(key).or_default().push(candidate);
    }

    by_name
        .into_iter()
        .filter(|(_, files)| files.len() > 1)
        .map(|(key, candidates)| {
            let files = into_files(candidates, None);
            DuplicateGroup {
                id: format!("name:{key}"),
                kind: DuplicateGroupKind::SimilarName,
                name: group_name(&files),
                size_bytes: files.iter().map(|file| file.size_bytes).max().unwrap_or(0),
                reclaimable_bytes: 0,
                files,
            }
        })
        .collect()
}

/// Orders candidates oldest first and marks the oldest as the suggested keep.
///
/// Oldest, because a copy is made from an original and therefore comes after
/// it. Ties — two files written in the same millisecond, or a filesystem that
/// would not give a time at all — break on path so the choice is stable across
/// scans rather than dependent on directory order.
fn into_files(mut candidates: Vec<Candidate>, hash: Option<&str>) -> Vec<ScannedFile> {
    candidates.sort_by(|a, b| {
        a.modified_ms
            .unwrap_or(i64::MAX)
            .cmp(&b.modified_ms.unwrap_or(i64::MAX))
            .then_with(|| a.path.cmp(&b.path))
    });

    candidates
        .into_iter()
        .enumerate()
        .map(|(index, candidate)| ScannedFile {
            name: file_name(&candidate.path),
            folder: candidate
                .path
                .parent()
                .map(display_path)
                .unwrap_or_default(),
            path: display_path(&candidate.path),
            size_bytes: candidate.size,
            modified_ms: candidate.modified_ms,
            hash: hash.map(str::to_string),
            suggested_keep: index == 0,
        })
        .collect()
}

/// What to head the group with: the shortest name in it, which is the one
/// without ` (1)` or ` - Copy` on the end.
fn group_name(files: &[ScannedFile]) -> String {
    files
        .iter()
        .map(|file| &file.name)
        .min_by_key(|name| (name.chars().count(), name.to_string()))
        .cloned()
        .unwrap_or_default()
}

/// Identical groups first, then same-name; each block by what it would free,
/// then by name, then by id.
///
/// Identical leads because it is the block where the answer is safe. The final
/// tie-break on id is what makes two scans of an unchanged folder produce
/// byte-identical output, which is the whole claim of a "deterministic
/// comparison".
fn sort_groups(groups: &mut [DuplicateGroup]) {
    groups.sort_by(|a, b| {
        kind_rank(a.kind)
            .cmp(&kind_rank(b.kind))
            .then_with(|| b.reclaimable_bytes.cmp(&a.reclaimable_bytes))
            .then_with(|| b.size_bytes.cmp(&a.size_bytes))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.id.cmp(&b.id))
    });
}

fn kind_rank(kind: DuplicateGroupKind) -> u8 {
    match kind {
        DuplicateGroupKind::Identical => 0,
        DuplicateGroupKind::SimilarName => 1,
    }
}

// ---------------------------------------------------------------------------
// Filename comparison
// ---------------------------------------------------------------------------

/// The key two files share when they are the same file under a copy's name.
///
/// Lower-cased stem with copy markers removed, plus the lower-cased extension,
/// which has to match — `report.pdf` and `report.docx` are an export of one
/// document, not two copies of it. Returns `None` for a stem that is nothing
/// but a marker, since `Copy of .txt` would otherwise gather every such file.
fn name_key(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_string_lossy().to_ascii_lowercase();
    let extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    let base = strip_copy_markers(&stem);
    if base.is_empty() {
        return None;
    }

    Some(format!("{base}.{extension}"))
}

/// Removes the suffixes and prefixes a file manager adds when it copies.
///
/// The list is deliberately short and literal: ` (2)`, ` - copy`, `-copy`,
/// `_copy`, ` copy 3`, and a leading `copy of `. What it does *not* strip is a
/// bare trailing number — `report_1.pdf` and `report_2.pdf` are two reports,
/// and a duplicate finder that called them the same thing would be exactly the
/// kind of guess section 40 rules out.
///
/// Applied repeatedly, because `photo - Copy (2)` is both at once.
fn strip_copy_markers(stem: &str) -> String {
    let mut base = stem.trim().to_string();

    loop {
        let before = base.clone();

        // The space after `of` is matched separately rather than being part of
        // the prefix, because a stem that is *only* the marker (`copy of `,
        // which arrives here already trimmed to `copy of`) has to strip to
        // nothing — while `copy office` starts with `copy of` too and must
        // survive untouched.
        if let Some(rest) = base.strip_prefix("copy of") {
            if rest.is_empty() || rest.starts_with(' ') {
                base = rest.trim().to_string();
            }
        }

        base = strip_parenthesised_number(&base);
        base = strip_copy_word(&base);

        base = base.trim().trim_end_matches(['-', '_']).trim().to_string();

        if base == before {
            return base;
        }
    }
}

/// Takes a trailing `(2)` off, with or without the space before it.
fn strip_parenthesised_number(stem: &str) -> String {
    let trimmed = stem.trim_end();
    let Some(open) = trimmed.rfind('(') else {
        return trimmed.to_string();
    };
    if !trimmed.ends_with(')') {
        return trimmed.to_string();
    }

    let inner = &trimmed[open + 1..trimmed.len() - 1];
    if inner.is_empty() || !inner.chars().all(|c| c.is_ascii_digit()) {
        return trimmed.to_string();
    }

    trimmed[..open].trim_end().to_string()
}

/// Takes a trailing `copy`, or `copy 2`, off — the word is required, so a
/// plain number survives.
fn strip_copy_word(stem: &str) -> String {
    let trimmed = stem.trim_end();

    // `copy 2` before `copy`, so the number goes with the word it belongs to.
    let without_number = match trimmed.rsplit_once(' ') {
        Some((head, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => head,
        _ => trimmed,
    };

    for marker in [" - copy", " -copy", " copy", "-copy", "_copy"] {
        if let Some(head) = without_number.strip_suffix(marker) {
            return head.trim_end().to_string();
        }
    }

    trimmed.to_string()
}

// ---------------------------------------------------------------------------
// Actions — the "perform action" end of section 67
// ---------------------------------------------------------------------------

/// Deletes exactly the paths given, reporting each one separately.
///
/// This is the last step of section 67's sequence and it is the only thing in
/// this module that removes a file. It takes a list rather than a scan result
/// on purpose: the only way to reach it is for the frontend to hand back paths
/// the user picked out of a result and confirmed, so there is no code path in
/// which a scan deletes something.
///
/// The deletion is permanent — there is no recycle bin in it — which is why
/// the UI says so in the confirmation and why moving is offered beside it.
pub fn delete_files(paths: &[String]) -> ServiceResult<Vec<FileActionResult>> {
    let targets = validate_targets(paths)?;

    Ok(targets
        .into_iter()
        .map(|path| match checked_file(&path) {
            Err(result) => result,
            Ok(()) => match fs::remove_file(&path) {
                Ok(()) => FileActionResult::ok(&path, None),
                Err(err) => FileActionResult::failed(&path, format!("could not be deleted: {err}")),
            },
        })
        .collect())
}

/// Moves exactly the paths given into `destination`, reporting each one
/// separately.
///
/// The safe half of the same step: the files leave the folder they were
/// cluttering and still exist. A name already taken at the destination gets
/// ` (1)`, ` (2)` and so on rather than overwriting — a cleanup tool that
/// silently replaced a file while tidying duplicates would be destroying data
/// under the banner of protecting it.
pub fn move_files(paths: &[String], destination: &str) -> ServiceResult<Vec<FileActionResult>> {
    let targets = validate_targets(paths)?;

    let destination = PathBuf::from(destination.trim());
    if destination.as_os_str().is_empty() {
        return Err(ServiceError::validation("Choose a folder to move files to."));
    }
    if !destination.is_dir() {
        return Err(ServiceError::validation(format!(
            "{} is not a folder.",
            display_path(&destination)
        )));
    }
    let destination = fs::canonicalize(&destination).map_err(|err| {
        ServiceError::validation(format!(
            "{} could not be opened: {err}",
            display_path(&destination)
        ))
    })?;

    Ok(targets
        .into_iter()
        .map(|path| match checked_file(&path) {
            Err(result) => result,
            Ok(()) => move_one(&path, &destination),
        })
        .collect())
}

/// Moves one file, falling back to copy-then-remove across volumes.
///
/// `rename` is atomic and instant but only within a filesystem; moving a
/// download onto an external drive is a normal thing to want, and it fails
/// with `CrossesDevices` (or a bare OS error on older Windows). The fallback
/// removes the original only after the copy has been written, so an
/// interrupted move leaves the file where it was rather than nowhere.
fn move_one(path: &Path, destination: &Path) -> FileActionResult {
    let Some(name) = path.file_name() else {
        return FileActionResult::failed(path, "does not have a file name.");
    };

    let target = match unique_destination(destination, &name.to_string_lossy()) {
        Some(target) => target,
        None => {
            return FileActionResult::failed(
                path,
                "could not be given a free name in that folder.",
            )
        }
    };

    if fs::rename(path, &target).is_ok() {
        return FileActionResult::ok(path, Some(display_path(&target)));
    }

    if let Err(err) = fs::copy(path, &target) {
        return FileActionResult::failed(path, format!("could not be moved: {err}"));
    }
    if let Err(err) = fs::remove_file(path) {
        return FileActionResult::failed(
            path,
            format!(
                "was copied to {} but the original could not be removed: {err}",
                display_path(&target)
            ),
        );
    }

    FileActionResult::ok(path, Some(display_path(&target)))
}

/// The first free name for `name` in `directory`: `photo.png`, then
/// `photo (1).png`, and so on.
fn unique_destination(directory: &Path, name: &str) -> Option<PathBuf> {
    let candidate = directory.join(name);
    if !candidate.exists() {
        return Some(candidate);
    }

    let path = Path::new(name);
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let extension = path.extension().map(|ext| ext.to_string_lossy().to_string());

    for index in 1..1000 {
        let attempt = match &extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = directory.join(attempt);
        if !candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

/// Opens the folder a file lives in, so the user can look before deciding.
///
/// The non-destructive third option beside delete and move, and the one that
/// makes "the user selects" a real choice rather than a guess from a path.
pub fn open_containing_folder(path: &str) -> ServiceResult<()> {
    let path = PathBuf::from(path.trim());
    let folder = if path.is_dir() {
        path.clone()
    } else {
        path.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| ServiceError::validation("That file has no containing folder."))?
    };

    if !folder.is_dir() {
        return Err(ServiceError::not_found(format!(
            "{} no longer exists.",
            display_path(&folder)
        )));
    }

    tauri_plugin_opener::open_path(&folder, None::<&str>).map_err(|err| {
        ServiceError::validation(format!(
            "{} could not be opened: {err}",
            display_path(&folder)
        ))
    })
}

/// Opens a file with whatever application the OS has registered for it.
pub fn open_file(path: &str) -> ServiceResult<()> {
    let path = PathBuf::from(path.trim());
    if !path.is_file() {
        return Err(ServiceError::not_found(format!(
            "{} no longer exists.",
            display_path(&path)
        )));
    }

    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|err| {
        ServiceError::validation(format!("{} could not be opened: {err}", display_path(&path)))
    })
}

/// Turns a requested path list into paths, or refuses the whole call.
///
/// The two refusals here are about the shape of the request, not about any one
/// file: an empty list means the UI got as far as a confirmation with nothing
/// selected, and a list past [`MAX_ACTION_PATHS`] is not something a person
/// ticked. Whether each individual path is safe to touch is
/// [`checked_file`]'s job, because that answer is per file.
fn validate_targets(paths: &[String]) -> ServiceResult<Vec<PathBuf>> {
    let targets: Vec<PathBuf> = paths
        .iter()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .collect();

    if targets.is_empty() {
        return Err(ServiceError::validation("Select at least one file first."));
    }
    if targets.len() > MAX_ACTION_PATHS {
        return Err(ServiceError::validation(format!(
            "That is more than {MAX_ACTION_PATHS} files at once. Work through them in smaller \
             batches."
        )));
    }

    Ok(targets)
}

/// The per-file guard every destructive action runs first.
///
/// A path that reaches here came from a scan the user has since been looking
/// at, so the file may have been moved, deleted or replaced in the meantime.
/// Three things are checked, and each corresponds to a way this could go
/// wrong rather than to a hypothetical: the file is still there, it is a file
/// and not a directory (so a delete cannot take a folder tree with it), and it
/// is not a symlink (so removing a "duplicate" cannot remove the real file
/// somewhere else).
fn checked_file(path: &Path) -> Result<(), FileActionResult> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return Err(FileActionResult::failed(path, "no longer exists.")),
    };

    if metadata.file_type().is_symlink() {
        return Err(FileActionResult::failed(
            path,
            "is a shortcut to another file, so it was left alone.",
        ));
    }
    if !metadata.is_file() {
        return Err(FileActionResult::failed(path, "is a folder, not a file."));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// Paths on the wire, with Windows' `\\?\` verbatim prefix taken off.
///
/// `canonicalize` returns it on Windows and it is correct, but it is also
/// unreadable in a UI and unrecognisable to a user comparing it with what
/// Explorer shows. It is stripped on the way out only; every path used to
/// touch the disk is the real one.
fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| display_path(path))
}

/// Last-modified as epoch milliseconds, or `None` where the platform or the
/// filesystem will not say — which is not worth failing a scan over.
fn modified_ms(metadata: &fs::Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    match modified.duration_since(UNIX_EPOCH) {
        Ok(since) => i64::try_from(since.as_millis()).ok(),
        // Before 1970. Vanishingly rare, and still orderable.
        Err(err) => i64::try_from(err.duration().as_millis()).ok().map(|ms| -ms),
    }
}

/// Whether a directory is one of the trees [`SKIPPED_DIRECTORIES`] names.
fn is_skipped_directory(path: &Path) -> bool {
    let Some(name) = path.file_name() else {
        return false;
    };
    let name = name.to_string_lossy().to_ascii_lowercase();
    name.starts_with('.') || SKIPPED_DIRECTORIES.contains(&name.as_str())
}

/// Dotfiles are configuration, not clutter, and are left out of the comparison.
fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().starts_with('.'))
        .unwrap_or(false)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_markers_a_file_manager_adds() {
        assert_eq!(strip_copy_markers("photo (1)"), "photo");
        assert_eq!(strip_copy_markers("photo(1)"), "photo");
        assert_eq!(strip_copy_markers("photo - copy"), "photo");
        assert_eq!(strip_copy_markers("photo-copy"), "photo");
        assert_eq!(strip_copy_markers("photo_copy"), "photo");
        assert_eq!(strip_copy_markers("photo copy 2"), "photo");
        assert_eq!(strip_copy_markers("copy of photo"), "photo");
        assert_eq!(strip_copy_markers("photo - copy (3)"), "photo");
    }

    #[test]
    fn leaves_a_bare_number_alone() {
        // Two chapters, not two copies. This is the guess section 40 rules out.
        assert_eq!(strip_copy_markers("report_1"), "report_1");
        assert_eq!(strip_copy_markers("report-2"), "report-2");
        assert_eq!(strip_copy_markers("img 2024"), "img 2024");
        assert_eq!(strip_copy_markers("photo"), "photo");
    }

    #[test]
    fn name_key_needs_the_extension_to_match() {
        let pdf = name_key(Path::new(r"C:\a\report (1).PDF")).unwrap();
        let same = name_key(Path::new(r"C:\b\Report.pdf")).unwrap();
        let other = name_key(Path::new(r"C:\b\report.docx")).unwrap();

        assert_eq!(pdf, same);
        assert_ne!(pdf, other);
    }

    #[test]
    fn name_key_ignores_a_stem_that_is_only_a_marker() {
        assert!(name_key(Path::new(r"C:\a\copy of .txt")).is_none());
        assert!(name_key(Path::new(r"C:\a\ (2).txt")).is_none());
    }

    #[test]
    fn a_word_that_merely_starts_with_a_marker_is_left_alone() {
        assert_eq!(strip_copy_markers("copy office notes"), "copy office notes");
        assert_eq!(strip_copy_markers("photocopy"), "photocopy");
    }

    #[test]
    fn empty_or_oversized_selections_are_refused() {
        assert!(validate_targets(&[]).is_err());
        assert!(validate_targets(&["   ".to_string()]).is_err());

        let too_many: Vec<String> = (0..MAX_ACTION_PATHS + 1).map(|n| n.to_string()).collect();
        assert!(validate_targets(&too_many).is_err());

        let one = validate_targets(&[r"C:\a\photo.png".to_string()]).unwrap();
        assert_eq!(one.len(), 1);
    }

    #[test]
    fn scanning_no_folders_is_a_validation_error() {
        let request = DuplicateScanRequest::default();
        assert!(matches!(
            scan(&request),
            Err(ServiceError::Validation(_))
        ));
    }

    #[test]
    fn groups_are_ordered_identical_first_then_by_saving() {
        let mut groups = vec![
            group_fixture("a", DuplicateGroupKind::SimilarName, 900),
            group_fixture("b", DuplicateGroupKind::Identical, 100),
            group_fixture("c", DuplicateGroupKind::Identical, 500),
        ];
        sort_groups(&mut groups);

        let ids: Vec<&str> = groups.iter().map(|group| group.id.as_str()).collect();
        assert_eq!(ids, vec!["c", "b", "a"]);
    }

    /// The whole pipeline over a real folder: size, head hash, full hash, then
    /// names over the leftovers.
    ///
    /// Four files, and each is there to be classified differently. `photo.png`
    /// and `photo (1).png` are byte-identical, so they are the one identical
    /// group and the only reclaimable bytes in the scan. `decoy.png` is
    /// exactly the same *length* as those two and differs in its contents,
    /// which is the case the hash exists to settle — if it ever joins that
    /// group, the size pass is being trusted for more than it can prove.
    /// `notes.txt` and `notes - Copy.txt` differ, so they can only be the
    /// weaker same-name kind, and that group promises nothing.
    #[test]
    fn scans_a_real_folder_and_separates_the_two_kinds() {
        let folder = scratch_folder("scan");
        let content = vec![7_u8; 4096];
        let decoy = vec![9_u8; 4096];

        fs::write(folder.join("photo.png"), &content).unwrap();
        fs::write(folder.join("photo (1).png"), &content).unwrap();
        fs::write(folder.join("decoy.png"), &decoy).unwrap();
        fs::write(folder.join("notes.txt"), b"the original").unwrap();
        fs::write(folder.join("notes - Copy.txt"), b"an edited version").unwrap();

        let scan = scan(&DuplicateScanRequest {
            folders: vec![folder.to_string_lossy().to_string()],
            include_subfolders: true,
            min_size_bytes: 1,
        })
        .unwrap();

        assert_eq!(scan.scanned_files, 5);
        assert_eq!(scan.duplicate_files, 2);
        assert_eq!(scan.reclaimable_bytes, 4096);
        assert!(!scan.truncated);

        let identical: Vec<&DuplicateGroup> = scan
            .groups
            .iter()
            .filter(|group| group.kind == DuplicateGroupKind::Identical)
            .collect();
        assert_eq!(identical.len(), 1);
        assert_eq!(identical[0].files.len(), 2);
        assert_eq!(identical[0].name, "photo.png");
        assert_eq!(identical[0].reclaimable_bytes, 4096);
        assert!(identical[0].files.iter().all(|file| file.hash.is_some()));
        // Exactly one keep is suggested, and it is a hint rather than a choice.
        assert_eq!(
            identical[0]
                .files
                .iter()
                .filter(|file| file.suggested_keep)
                .count(),
            1
        );

        let similar: Vec<&DuplicateGroup> = scan
            .groups
            .iter()
            .filter(|group| group.kind == DuplicateGroupKind::SimilarName)
            .collect();
        assert_eq!(similar.len(), 1);
        assert_eq!(similar[0].files.len(), 2);
        assert_eq!(similar[0].reclaimable_bytes, 0);

        // The decoy is in neither: same size, different bytes, unique name.
        assert!(scan
            .groups
            .iter()
            .flat_map(|group| &group.files)
            .all(|file| file.name != "decoy.png"));

        fs::remove_dir_all(&folder).ok();
    }

    /// A move never overwrites — see [`unique_destination`].
    #[test]
    fn moving_onto_a_taken_name_renames_instead_of_overwriting() {
        let source = scratch_folder("move-from");
        let destination = scratch_folder("move-to");

        fs::write(source.join("photo.png"), b"the copy").unwrap();
        fs::write(destination.join("photo.png"), b"already here").unwrap();

        let results = move_files(
            &[source.join("photo.png").to_string_lossy().to_string()],
            &destination.to_string_lossy(),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert!(results[0].ok, "{:?}", results[0].error);
        assert!(results[0].new_path.as_deref().unwrap().ends_with("photo (1).png"));
        assert_eq!(
            fs::read(destination.join("photo.png")).unwrap(),
            b"already here"
        );
        assert_eq!(
            fs::read(destination.join("photo (1).png")).unwrap(),
            b"the copy"
        );
        assert!(!source.join("photo.png").exists());

        fs::remove_dir_all(&source).ok();
        fs::remove_dir_all(&destination).ok();
    }

    /// A path that has gone since the scan is reported, not panicked over —
    /// the ordinary consequence of results the user has been reading for a
    /// while.
    #[test]
    fn deleting_a_missing_file_is_reported_rather_than_fatal() {
        let folder = scratch_folder("delete");
        let present = folder.join("photo.png");
        fs::write(&present, b"gone in a moment").unwrap();

        let results = delete_files(&[
            present.to_string_lossy().to_string(),
            folder.join("never-existed.png").to_string_lossy().to_string(),
            folder.to_string_lossy().to_string(),
        ])
        .unwrap();

        assert!(results[0].ok);
        assert!(!present.exists());
        assert!(!results[1].ok);
        // The folder itself: a delete must never take a directory with it.
        assert!(!results[2].ok);
        assert!(folder.is_dir());

        fs::remove_dir_all(&folder).ok();
    }

    /// A fresh directory under the OS temp folder, named after the test.
    ///
    /// No `tempfile` dependency for three tests: the process id plus a counter
    /// is enough to keep concurrent test threads and repeated runs apart.
    fn scratch_folder(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);

        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let folder = std::env::temp_dir().join(format!(
            "routine-launcher-duplicates-{label}-{}-{unique}",
            std::process::id()
        ));

        fs::remove_dir_all(&folder).ok();
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn group_fixture(id: &str, kind: DuplicateGroupKind, reclaimable: u64) -> DuplicateGroup {
        DuplicateGroup {
            id: id.to_string(),
            kind,
            name: id.to_string(),
            size_bytes: reclaimable,
            reclaimable_bytes: reclaimable,
            files: Vec::new(),
        }
    }
}
