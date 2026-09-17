//! The list of programs installed on this computer, and the name-to-program
//! lookup that lets a routine say `Chrome` instead of a path.
//!
//! An `application` action stores a string and hands it to the OS, and the OS
//! only knows two kinds of string: a path to a file, and a bare name that is
//! on `PATH`. Almost nothing a person would name is either. `chrome.exe`
//! lives in `C:\Program Files\Google\Chrome\Application`, which is not on
//! `PATH`; Spotify lives under `%AppData%`; a user who types `Chrome` — the
//! word on the icon they click every day — gets "could not be found", which
//! is true and useless.
//!
//! Windows keeps three lists of what is installed, and this module reads all
//! three because no one of them is complete:
//!
//! * **The Start Menu.** Every desktop installer puts a `.lnk` there, and the
//!   file name *is* the name the user knows the program by ("Google Chrome",
//!   not "chrome.exe"). That makes it the right source for a picker.
//! * **`App Paths`.** The registry key behind Win+R: `chrome`, `msedge`,
//!   `code` resolve there whether or not they are on `PATH`. That makes it
//!   the right source for the short names people type.
//! * **The shell's applications folder.** Store apps are in neither of the
//!   others — they have no `.exe` to find and no file in the Start Menu, only
//!   a registration addressed by ID. Claude and Spotify are commonly
//!   installed that way, so skipping this source would miss the apps the
//!   feature exists for.
//!
//! The three are merged into one catalogue, deduplicated twice — by program,
//! so `chrome.exe` from the registry and `Google Chrome` from the Start Menu
//! are one entry with the friendlier name, and by name, so one word in the
//! picker means one thing.
//!
//! Two things use it: the builder's application picker (a dropdown beats
//! knowing a path) and [`resolve`], which is the last thing
//! `services::routine_exec` tries before reporting that a target could not be
//! found. The second is what makes routines that were saved as plain names —
//! including ones saved before this module existed — start working.
//!
//! ## Why shortcuts are opened rather than followed, sometimes
//!
//! A `.lnk` is a small binary structure, and the part of it worth having is
//! the path it points at: stored as the program itself, an action can take
//! arguments, which a shortcut cannot ([`routine_exec::launch_application`]
//! refuses them). So [`shortcut_target`] parses the file and reads the path
//! out. It is deliberately a partial parser — it understands the one section
//! that carries a local path and gives up on everything else — because the
//! shortcuts it gives up on are real: a Store app's shortcut names an
//! application-user-model ID, not a file, and there is no path in it to find.
//! Those keep the `.lnk` as their target and are opened through the shell,
//! which is the only thing that can start them.
//!
//! ## Freshness
//!
//! The scan walks two directory trees, runs `reg query` three times and pays
//! about a second for PowerShell, so it is cached after the first call. [`list`] takes a `refresh` flag for the
//! picker's reload button, and [`resolve`] rescans by itself when a name
//! misses — an app installed since the app started is exactly the case where
//! a miss is worth paying a rescan for, and a hit never pays it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// One program the user could point an action at.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct InstalledApp {
    /// What the user calls it: `Google Chrome`.
    pub name: String,
    /// What the action should store — a full path to the program, or to the
    /// shortcut when the program behind it could not be read (see the module
    /// docs).
    pub target: String,
    /// Whether the target has to be handed to Windows to open rather than
    /// run directly — a shortcut whose program could not be read, or a Store
    /// app addressed by ID. The picker shows the difference, because these
    /// are the targets that cannot take arguments.
    pub via_shell: bool,
}

/// Names that are in the Start Menu but are not programs anyone launches on
/// purpose. Matched as substrings of the lowercased name, so "Uninstall
/// Spotify" and "Spotify Uninstaller" both go.
const NOT_A_PROGRAM: [&str; 14] = [
    "uninstall",
    "readme",
    "read me",
    "release notes",
    "documentation",
    "user guide",
    "user manual",
    "license",
    "changelog",
    "what's new",
    "website",
    "home page",
    "on the web",
    "support center",
];

/// The scanned catalogue, sorted by name. `None` until the first scan.
static CATALOG: OnceLock<Mutex<Option<Vec<InstalledApp>>>> = OnceLock::new();

fn cache() -> &'static Mutex<Option<Vec<InstalledApp>>> {
    CATALOG.get_or_init(|| Mutex::new(None))
}

/// Every program this computer knows about, by display name.
///
/// `refresh` throws the cache away first — what the picker's reload does
/// after the user has installed something with the app still running.
pub fn list(refresh: bool) -> Vec<InstalledApp> {
    // A poisoned lock is not worth failing a picker over: the data behind it
    // is a cache of the disk, so the worst case of ignoring the poison is one
    // extra scan.
    let mut guard = match cache().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    if refresh {
        *guard = None;
    }

    guard.get_or_insert_with(scan).clone()
}

/// Finds the program a typed name means, or `None` if nothing matches.
///
/// Called by `services::routine_exec` when a target is neither a path nor a
/// name on `PATH` — so by the time this runs, "chrome" has already failed
/// every lookup Windows itself would do.
pub fn resolve(target: &str) -> Option<PathBuf> {
    if let Some(found) = best_match(&list(false), target) {
        return Some(found);
    }

    // A miss might be a name that does not exist, or an app installed since
    // the catalogue was built. Only the second is fixable, and only a rescan
    // fixes it — so a miss pays for one and a hit never does.
    best_match(&list(true), target)
}

/// Groups of names that all mean one program — `vscode`, `code` and
/// `Visual Studio Code`; `files` and `File Explorer`. The same file the
/// builder's picker reads (`src/lib/installed-app-utils.ts`), so the two agree
/// on what a nickname means.
const ALIAS_GROUPS_JSON: &str = include_str!("../../../src/lib/app-aliases.json");

static ALIAS_GROUPS: OnceLock<Vec<Vec<String>>> = OnceLock::new();

fn alias_groups() -> &'static [Vec<String>] {
    ALIAS_GROUPS.get_or_init(|| {
        let groups: Vec<Vec<String>> =
            serde_json::from_str(ALIAS_GROUPS_JSON).expect("app-aliases.json is valid");
        groups
            .into_iter()
            .map(|group| group.iter().map(|alias| normalise(alias)).collect())
            .collect()
    })
}

/// The group `query` is one of the names in, and every name in groups it is
/// the start of (`vsc` is on its way to `vscode`).
fn aliases_for(query: &str) -> (Option<&'static [String]>, Vec<&'static str>) {
    let mut exact = None;
    let mut partial = Vec::new();

    for group in alias_groups() {
        if group.iter().any(|alias| alias == query) {
            exact = Some(group.as_slice());
        } else if group.iter().any(|alias| alias.starts_with(query)) {
            partial.extend(group.iter().map(String::as_str));
        }
    }

    (exact, partial)
}

/// The best entry for `query`, by how directly it was named.
///
/// The tiers matter more than the scoring: an exact name and a program whose
/// file happens to start with the same letters are not the same claim, and
/// `chrome` must not become `Chrome Remote Desktop` while `Google Chrome`
/// exists. Within a tier the shortest name wins, which is the same rule by a
/// different route — the shortest match is the least-qualified one, and a
/// user who types a bare word means the bare thing.
///
/// A known nickname comes first of all: the table exists because `files`
/// means File Explorer even on a machine that also has an app called "Files".
/// Inside a group the earlier name wins, so `explorer` finds File Explorer
/// rather than whatever else answers to another name in its group.
fn best_match(apps: &[InstalledApp], query: &str) -> Option<PathBuf> {
    let query = normalise(&without_executable_extension(query.trim()));
    if query.is_empty() {
        return None;
    }

    let (exact, partial) = aliases_for(&query);

    apps.iter()
        .filter_map(|app| {
            let name = normalise(&app.name);
            let stem = normalise(&file_stem(&app.target));
            let alias_rank = exact.and_then(|group| {
                group.iter().position(|alias| *alias == name || *alias == stem)
            });

            let (tier, rank) = if let Some(rank) = alias_rank {
                (0, rank)
            } else if name == query || stem == query {
                (1, 0)
            } else if name.starts_with(&query)
                || stem.starts_with(&query)
                || partial.contains(&name.as_str())
                || partial.contains(&stem.as_str())
            {
                (2, 0)
            } else if name.contains(&query) {
                (3, 0)
            } else {
                return None;
            };

            Some((tier, rank, app.name.len(), app))
        })
        .min_by_key(|(tier, rank, length, app)| (*tier, *rank, *length, app.name.clone()))
        .map(|(_, _, _, app)| PathBuf::from(&app.target))
}

/// Lowercases and drops everything that is not a letter or a digit, so
/// `Visual Studio Code`, `visualstudiocode` and `Visual-Studio-Code` are one
/// string. Spaces and punctuation are the part of a program's name people
/// remember least reliably.
fn normalise(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// `chrome.exe` without the `.exe` — `chrome` and `Google Chrome` unchanged.
///
/// The catalogue is keyed on what a program is *called*, so the several ways
/// Windows spells "executable" are dropped from the query rather than matched
/// against. Only those spellings: a name with a dot in it that is not one of
/// them ("Node.js") is a name, not a file, and keeps its dot.
fn without_executable_extension(query: &str) -> String {
    const EXECUTABLE: [&str; 5] = ["exe", "com", "bat", "cmd", "lnk"];

    let Some((stem, extension)) = query.rsplit_once('.') else {
        return query.to_owned();
    };

    if stem.is_empty() || !EXECUTABLE.iter().any(|e| extension.eq_ignore_ascii_case(e)) {
        return query.to_owned();
    }

    stem.to_owned()
}

fn file_stem(target: &str) -> String {
    Path::new(target)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// Reads both sources and merges them into one list with one row per program.
///
/// Both sources name the same programs, so merging is mostly deduplication,
/// and it has to happen twice because there are two ways to be a duplicate:
///
/// * **Two names for one program.** `App Paths` calls Chrome `chrome.exe`;
///   the Start Menu calls it `Google Chrome`. Keyed by the file, resolved
///   towards the name a person would recognise.
/// * **Two programs under one name.** Discord's Start Menu shortcut points at
///   its updater and its registered path at the app itself — both are called
///   "Discord", and a picker offering the same word twice is asking a
///   question the user cannot answer. Keyed by the name, resolved towards
///   whichever source spoke last, which is the Start Menu: that is the
///   shortcut the user clicks today, so it is the one that works.
fn scan() -> Vec<InstalledApp> {
    let mut by_name: BTreeMap<String, InstalledApp> = BTreeMap::new();

    let sources = registered_programs()
        .into_iter()
        .chain(start_menu_programs())
        .chain(store_apps());

    for app in sources {
        if is_noise(&app) {
            continue;
        }
        by_name.insert(normalise(&app.name), app);
    }

    let mut by_target: BTreeMap<String, InstalledApp> = BTreeMap::new();
    for app in by_name.into_values() {
        match by_target.entry(app.target.to_lowercase()) {
            std::collections::btree_map::Entry::Vacant(slot) => {
                slot.insert(app);
            }
            std::collections::btree_map::Entry::Occupied(mut slot) => {
                if friendlier(&app, slot.get()) {
                    slot.insert(app);
                }
            }
        }
    }

    let mut apps: Vec<InstalledApp> = by_target.into_values().collect();
    apps.sort_by_key(|app| app.name.to_lowercase());
    apps
}

/// Whether `candidate` is the better of two names for the same program.
///
/// "Better" is "less like a file name": `App Paths` is keyed by executable, so
/// its entry for Chrome is called `chrome`, and the Start Menu's is called
/// `Google Chrome`. Deciding it this way rather than by which source it came
/// from means it also settles two Start Menu shortcuts to the same program,
/// where there is no source to prefer.
fn friendlier(candidate: &InstalledApp, current: &InstalledApp) -> bool {
    let is_file_name =
        |app: &InstalledApp| normalise(&app.name) == normalise(&file_stem(&app.target));

    match (is_file_name(candidate), is_file_name(current)) {
        (false, true) => true,
        (true, false) => false,
        _ => candidate.name.len() > current.name.len(),
    }
}

/// Whether an entry is something other than a program the user launches.
///
/// Two kinds get dropped. The Start Menu is full of shortcuts to documents —
/// a manual as a `.txt`, a help file as a `.chm`, a "getting started" page as
/// an `.htm` — which are only in a program's folder because the installer put
/// them there; and next to those sit its uninstaller and its website. Neither
/// belongs in a list of things to open at the start of a work session, and a
/// picker is only as useful as it is short.
fn is_noise(app: &InstalledApp) -> bool {
    const LAUNCHABLE: [&str; 5] = ["exe", "com", "bat", "cmd", "lnk"];

    // A Store app is an ID rather than a file, so there is no extension to
    // judge it by — and nothing puts a manual in that list.
    if app.target.starts_with(APPS_FOLDER) {
        return false;
    }

    let launchable = Path::new(&app.target)
        .extension()
        .map(|ext| LAUNCHABLE.iter().any(|kind| ext.eq_ignore_ascii_case(kind)))
        .unwrap_or(false);

    if !launchable {
        return true;
    }

    let name = app.name.to_lowercase();
    NOT_A_PROGRAM.iter().any(|noise| name.contains(noise))
}

/// Programs registered under `App Paths` — the names Win+R accepts.
#[cfg(windows)]
fn registered_programs() -> Vec<InstalledApp> {
    const KEYS: [&str; 3] = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
    ];

    KEYS.iter()
        .flat_map(|key| parse_app_paths(&query_registry(key)))
        .collect()
}

#[cfg(not(windows))]
fn registered_programs() -> Vec<InstalledApp> {
    Vec::new()
}

/// Runs `reg query <key> /s` and returns its output, or an empty string.
///
/// `reg.exe` rather than a registry crate: this is three reads of two
/// well-known keys, done once, and the alternative is a dependency for it.
/// The console it would otherwise flash up is suppressed the same way
/// `routine_exec` suppresses the one behind a `.cmd` launch.
#[cfg(windows)]
fn query_registry(key: &str) -> String {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    /// Run without allocating a console.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = Command::new("reg")
        .args(["query", key, "/s"])
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match output {
        // Lossy on purpose: `reg` writes in the console code page, and the
        // only field being read is a file path, which is ASCII in every
        // installation worth resolving. A path that is not survives as
        // replacement characters, fails to exist, and is dropped below.
        Ok(output) => String::from_utf8_lossy(&output.stdout).into_owned(),
        Err(_) => String::new(),
    }
}

/// Pulls `(key name, default value)` pairs out of `reg query /s` output.
///
/// The shape being read is one subkey per program, named after its
/// executable, whose default value is the full path to it:
///
/// ```text
/// HKEY_LOCAL_MACHINE\...\App Paths\chrome.exe
///     (Default)    REG_SZ    C:\Program Files\Google\Chrome\Application\chrome.exe
/// ```
#[cfg(windows)]
fn parse_app_paths(output: &str) -> Vec<InstalledApp> {
    let mut apps = Vec::new();
    let mut current: Option<String> = None;

    for line in output.lines() {
        if line.starts_with("HKEY_") {
            current = line.rsplit('\\').next().map(str::to_owned);
            continue;
        }

        let Some(key_name) = current.as_deref() else {
            continue;
        };

        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix("(Default)") else {
            continue;
        };
        let Some((_, value)) = rest.trim_start().split_once("REG_SZ") else {
            continue;
        };

        // Quoted values happen, and the quotes are not part of the path.
        let path = value.trim().trim_matches('"').trim();
        if path.is_empty() || !Path::new(path).is_file() {
            continue;
        }

        // The registry's name for it is the file name; the extension is
        // noise in a picker, and `Path::file_stem` is not enough on its own
        // because the key is a name rather than a path.
        let name = key_name
            .strip_suffix(".exe")
            .or_else(|| key_name.strip_suffix(".EXE"))
            .unwrap_or(key_name);

        apps.push(InstalledApp {
            name: name.to_owned(),
            target: path.to_owned(),
            via_shell: false,
        });

        current = None;
    }

    apps
}

/// The prefix that turns an application-user-model ID into something the
/// shell can open. Also how [`is_noise`] and `routine_exec` recognise one.
pub const APPS_FOLDER: &str = r"shell:AppsFolder\";

/// Store apps, which are the ones the other two sources cannot see.
///
/// A packaged app has no `.exe` to point at and no Start Menu file: it is a
/// registration in the shell's own list of applications, addressed by an ID
/// rather than a path. On this machine that is where Claude and Spotify live
/// — two of the four programs a user is most likely to type the name of — so
/// leaving them out would leave the feature half-working for exactly the apps
/// it was asked for.
///
/// `Get-StartApps` is the only enumeration of that list that does not mean
/// calling COM, and it is worth about a second, which is why the catalogue is
/// cached. Failure is silent and total: a machine where PowerShell is locked
/// down still gets its desktop programs.
#[cfg(windows)]
fn store_apps() -> Vec<InstalledApp> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const SCRIPT: &str = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; \
                          Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress";

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let Ok(output) = output else {
        return Vec::new();
    };

    #[derive(serde::Deserialize)]
    struct StartApp {
        #[serde(rename = "Name")]
        name: String,
        #[serde(rename = "AppID")]
        app_id: String,
    }

    let text = String::from_utf8_lossy(&output.stdout);
    // One installed app makes `ConvertTo-Json` emit an object rather than a
    // list of one, which is a PowerShell habit rather than a case worth
    // handling twice.
    let parsed: Vec<StartApp> = serde_json::from_str(&text)
        .or_else(|_| serde_json::from_str::<StartApp>(&text).map(|one| vec![one]))
        .unwrap_or_default();

    parsed
        .into_iter()
        // `!` is what separates a package family from the application inside
        // it, so it is also what tells a packaged app from a desktop one.
        // The desktop ones are already here from a source that knows where
        // their `.exe` is, and a path beats an ID: only a path takes
        // arguments.
        .filter(|app| app.app_id.contains('!'))
        .map(|app| InstalledApp {
            name: app.name,
            target: format!("{APPS_FOLDER}{}", app.app_id),
            via_shell: true,
        })
        .collect()
}

#[cfg(not(windows))]
fn store_apps() -> Vec<InstalledApp> {
    Vec::new()
}

/// Every `.lnk` under the all-users and per-user Start Menus, resolved to the
/// program behind it where that can be read.
#[cfg(windows)]
fn start_menu_programs() -> Vec<InstalledApp> {
    let roots = [
        std::env::var_os("ProgramData").map(|dir| {
            PathBuf::from(dir).join(r"Microsoft\Windows\Start Menu\Programs")
        }),
        std::env::var_os("AppData").map(|dir| {
            PathBuf::from(dir).join(r"Microsoft\Windows\Start Menu\Programs")
        }),
    ];

    let mut apps = Vec::new();
    for root in roots.into_iter().flatten() {
        collect_shortcuts(&root, 0, &mut apps);
    }
    apps
}

#[cfg(not(windows))]
fn start_menu_programs() -> Vec<InstalledApp> {
    Vec::new()
}

/// The Start Menu is a shallow tree — a folder per vendor, occasionally one
/// more inside it. The depth limit is a guard against a symlinked loop rather
/// than a real shape, and unreadable folders are skipped rather than
/// reported: a picker that refuses to list anything because one directory
/// denied access would be worse than one that lists the rest.
#[cfg(windows)]
fn collect_shortcuts(dir: &Path, depth: usize, apps: &mut Vec<InstalledApp>) {
    const MAX_DEPTH: usize = 4;

    if depth > MAX_DEPTH {
        return;
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();

        if path.is_dir() {
            collect_shortcuts(&path, depth + 1, apps);
            continue;
        }

        let is_link = path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false);
        if !is_link {
            continue;
        }

        let Some(name) = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()) else {
            continue;
        };

        match shortcut_target(&path) {
            Some(program) => apps.push(InstalledApp {
                name,
                target: program.to_string_lossy().into_owned(),
                via_shell: false,
            }),
            // Nothing to follow — a Store app, or a shortcut whose target is
            // not a local file. The shell can still open it.
            None => apps.push(InstalledApp {
                name,
                target: path.to_string_lossy().into_owned(),
                via_shell: true,
            }),
        }
    }
}

/// Reads the local path out of a `.lnk`, or `None` when there is not one.
///
/// Only the `LinkInfo` section is understood, and only its local-path half:
/// that is the part that answers "which file does this shortcut start", and
/// every other section is either a name for the shortcut or a description of
/// something that is not a path. See MS-SHLLINK for the layout — the numbers
/// below are its field offsets.
#[cfg(windows)]
fn shortcut_target(path: &Path) -> Option<PathBuf> {
    const HEADER_SIZE: usize = 0x4C;
    const HAS_LINK_TARGET_ID_LIST: u32 = 0x0000_0001;
    const HAS_LINK_INFO: u32 = 0x0000_0002;
    /// `LinkInfo` carries a VolumeID and a local base path, as opposed to a
    /// network share — the flag that makes the offsets below meaningful.
    const VOLUME_ID_AND_LOCAL_BASE_PATH: u32 = 0x0000_0001;
    /// A `LinkInfo` header this size or larger has the two Unicode offsets.
    const UNICODE_HEADER_SIZE: u32 = 0x24;

    let bytes = std::fs::read(path).ok()?;

    if read_u32(&bytes, 0)? != HEADER_SIZE as u32 {
        return None;
    }
    let flags = read_u32(&bytes, 20)?;

    let mut cursor = HEADER_SIZE;
    if flags & HAS_LINK_TARGET_ID_LIST != 0 {
        // A u16 length followed by that many bytes of shell item IDs, which
        // are only skipped past: the same target is in `LinkInfo` in a form
        // that does not need the shell namespace to read.
        cursor += 2 + read_u16(&bytes, cursor)? as usize;
    }

    if flags & HAS_LINK_INFO == 0 {
        return None;
    }

    let info = cursor;
    let header_size = read_u32(&bytes, info + 0x04)?;
    if read_u32(&bytes, info + 0x08)? & VOLUME_ID_AND_LOCAL_BASE_PATH == 0 {
        return None;
    }

    // The path arrives in two halves — the volume and directory ("C:\Program
    // Files\Google\Chrome\Application\") and the file after it — which are
    // stored apart and mean nothing separately.
    let (base, suffix) = if header_size >= UNICODE_HEADER_SIZE {
        (
            read_utf16(&bytes, info + read_u32(&bytes, info + 0x1C)? as usize)?,
            read_utf16(&bytes, info + read_u32(&bytes, info + 0x20)? as usize)?,
        )
    } else {
        (
            read_ascii(&bytes, info + read_u32(&bytes, info + 0x10)? as usize)?,
            read_ascii(&bytes, info + read_u32(&bytes, info + 0x18)? as usize)?,
        )
    };

    let resolved = PathBuf::from(format!("{base}{suffix}"));

    // A shortcut can outlive what it points at, and one that does is worth
    // less than the shortcut file itself: the shell has its own repair pass,
    // and this parser has none. Falling back is the caller's `None` branch.
    resolved.is_file().then_some(resolved)
}

#[cfg(windows)]
fn read_u16(bytes: &[u8], at: usize) -> Option<u16> {
    let slice = bytes.get(at..at + 2)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

#[cfg(windows)]
fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// A NUL-terminated single-byte string, decoded as Latin-1.
///
/// The real encoding is the system's ANSI code page, which is not knowable
/// from here. Latin-1 is exact for the ASCII these paths are made of and
/// merely wrong-looking for anything else — and a wrong-looking path fails
/// the `is_file` check above rather than being launched.
#[cfg(windows)]
fn read_ascii(bytes: &[u8], at: usize) -> Option<String> {
    let rest = bytes.get(at..)?;
    let end = rest.iter().position(|&byte| byte == 0).unwrap_or(rest.len());
    Some(rest[..end].iter().map(|&byte| byte as char).collect())
}

/// A NUL-terminated UTF-16LE string.
#[cfg(windows)]
fn read_utf16(bytes: &[u8], at: usize) -> Option<String> {
    let rest = bytes.get(at..)?;
    let units: Vec<u16> = rest
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|&unit| unit != 0)
        .collect();
    Some(String::from_utf16_lossy(&units))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, target: &str) -> InstalledApp {
        InstalledApp {
            name: name.to_owned(),
            target: target.to_owned(),
            via_shell: false,
        }
    }

    fn catalog() -> Vec<InstalledApp> {
        vec![
            app("Google Chrome", r"C:\Program Files\Google\Chrome\chrome.exe"),
            app("Chrome Remote Desktop", r"C:\Program Files\Google\crd.exe"),
            app("Spotify", r"C:\Users\me\AppData\Roaming\Spotify\Spotify.exe"),
            app("Visual Studio Code", r"C:\Program Files\VS Code\Code.exe"),
            app("Opera", r"C:\Program Files\Opera\launcher.exe"),
            app("Code::Blocks", r"C:\Program Files\CodeBlocks\codeblocks.exe"),
            app("File Explorer", r"C:\Windows\explorer.exe"),
            app("Microsoft Teams (work or school)", r"C:\Program Files\WindowsApps\ms-teams.exe"),
            app("Claude", r"C:\Users\me\AppData\Local\AnthropicClaude\claude.exe"),
        ]
    }

    #[test]
    fn nicknames_open_the_program_they_mean() {
        for (typed, expected) in [
            ("vscode", r"C:\Program Files\VS Code\Code.exe"),
            ("VS Code", r"C:\Program Files\VS Code\Code.exe"),
            ("code", r"C:\Program Files\VS Code\Code.exe"),
            ("files", r"C:\Windows\explorer.exe"),
            ("teams", r"C:\Program Files\WindowsApps\ms-teams.exe"),
            ("MS Teams", r"C:\Program Files\WindowsApps\ms-teams.exe"),
            ("claude ai", r"C:\Users\me\AppData\Local\AnthropicClaude\claude.exe"),
            ("opera browser", r"C:\Program Files\Opera\launcher.exe"),
        ] {
            assert_eq!(
                best_match(&catalog(), typed),
                Some(PathBuf::from(expected)),
                "{typed} should have matched"
            );
        }
    }

    #[test]
    fn a_nickname_means_its_program_even_when_another_app_has_that_name() {
        // Microsoft 365 Companions ships an app literally called "Files".
        let mut apps = catalog();
        apps.push(app("Files", r"shell:AppsFolder\Microsoft.M365Companions!Files"));
        for typed in ["files", "explorer"] {
            assert_eq!(
                best_match(&apps, typed),
                Some(PathBuf::from(r"C:\Windows\explorer.exe")),
                "{typed} should have matched File Explorer"
            );
        }
    }

    #[test]
    fn every_alias_names_one_program() {
        let mut seen = std::collections::HashSet::new();
        for group in alias_groups() {
            assert!(group.len() >= 2, "{group:?} has no nicknames");
            for alias in group {
                assert!(!alias.is_empty(), "{group:?} has an empty name");
                assert!(seen.insert(alias.clone()), "{alias} is in more than one group");
            }
        }
    }

    #[test]
    fn matches_the_name_on_the_icon() {
        assert_eq!(
            best_match(&catalog(), "Spotify"),
            Some(PathBuf::from(r"C:\Users\me\AppData\Roaming\Spotify\Spotify.exe"))
        );
    }

    #[test]
    fn a_bare_word_prefers_the_program_it_names_over_one_that_starts_with_it() {
        // Both "Google Chrome" and "Chrome Remote Desktop" contain the word;
        // only one of them is what a user typing "chrome" is asking for.
        assert_eq!(
            best_match(&catalog(), "chrome"),
            Some(PathBuf::from(r"C:\Program Files\Google\Chrome\chrome.exe"))
        );
    }

    #[test]
    fn matches_the_executable_name_as_well_as_the_display_name() {
        // Nothing in the catalogue is *called* "Code" — the file is.
        assert_eq!(
            best_match(&catalog(), "code.exe"),
            Some(PathBuf::from(r"C:\Program Files\VS Code\Code.exe"))
        );
    }

    #[test]
    fn spacing_and_case_are_not_something_the_user_has_to_get_right() {
        for typed in ["visual studio code", "VisualStudioCode", "VISUAL STUDIO CODE"] {
            assert_eq!(
                best_match(&catalog(), typed),
                Some(PathBuf::from(r"C:\Program Files\VS Code\Code.exe")),
                "{typed} should have matched"
            );
        }
    }

    #[test]
    fn a_name_no_installed_program_answers_to_stays_unresolved() {
        // So the executor reports the user's own target back to them rather
        // than launching something they did not ask for.
        assert_eq!(best_match(&catalog(), "photoshop"), None);
        assert_eq!(best_match(&catalog(), ""), None);
    }

    /// What this machine actually has on it — ignored by default because the
    /// answer is different on every computer and there is nothing to assert
    /// beyond "the scan found something". Run it with
    /// `cargo test --lib installed_apps -- --ignored --nocapture` when a real
    /// program is not being found.
    #[test]
    #[ignore = "reports the local machine; no fixed expectation to assert"]
    fn reports_what_is_installed_here() {
        let apps = list(true);
        println!("{} programs found", apps.len());
        for app in apps.iter().take(40) {
            println!("  {:<40} {}", app.name, app.target);
        }
        for name in ["chrome", "spotify", "opera", "code", "vscode", "files", "teams", "claude", "explorer", "file explorer", "notepad"] {
            println!("{name} -> {:?}", resolve(name));
        }
        assert!(!apps.is_empty(), "a Windows install has programs on it");
    }

    #[test]
    fn the_friendly_name_wins_over_the_executable_name_for_the_same_program() {
        // What the registry and the Start Menu each call Chrome. Only one of
        // the two is a name; the other is the file it happens to live in.
        let registered = app("chrome", r"C:\Program Files\Google\Chrome\chrome.exe");
        let start_menu = app("Google Chrome", r"C:\Program Files\Google\Chrome\chrome.exe");

        assert!(friendlier(&start_menu, &registered));
        assert!(!friendlier(&registered, &start_menu));
    }

    #[test]
    fn documents_and_uninstallers_are_not_programs() {
        // Everything below is really in a Start Menu somewhere.
        for not_a_program in [
            app("Console RAR manual", r"C:\Program Files\WinRAR\Rar.txt"),
            app("Cisco Packet Tracer Help", r"C:\Program Files\PT\help\index.htm"),
            app("Application Verifier Help", r"C:\Windows\System32\appverif.chm"),
            app("Uninstall Spotify", r"C:\Users\me\AppData\Spotify\Uninstall.exe"),
            app("Opera GX website", r"C:\Program Files\Opera\visit.lnk"),
        ] {
            assert!(is_noise(&not_a_program), "{} should be dropped", not_a_program.name);
        }

        assert!(!is_noise(&app("Spotify", r"C:\Users\me\Spotify\Spotify.exe")));
        // A Store app, kept as the shortcut because there is no path behind
        // it — still the one row in the picker that starts it.
        assert!(!is_noise(&app("WhatsApp", r"C:\ProgramData\...\WhatsApp.lnk")));
    }
}
