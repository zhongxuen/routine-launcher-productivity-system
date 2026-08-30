//! Local crash and error logging (development-plan.md section 85).
//!
//! One file, on this machine, and nowhere else. Section 68's promise is that
//! nothing leaves the computer, and a crash reporter is the one feature most
//! likely to break that promise by accident — so this service has no network
//! code in it and no way to acquire any: it opens a path under the app's own
//! data directory and appends lines to it. There is no "send report" button
//! anywhere in the app, and the only things the UI can do with the log are
//! show the user where it is and open the folder.
//!
//! ## What ends up in it
//!
//! Three sources, all reaching the same file so a failure can be read in
//! order against whatever happened around it:
//!
//! * **Rust panics.** [`install_panic_hook`] records the payload, the thread,
//!   the location and a backtrace, then hands the panic on to the hook that
//!   was there before — which is what still prints it on a `tauri dev`
//!   console.
//! * **Handled Rust failures.** The [`log_error!`](crate::log_error),
//!   [`log_warn!`](crate::log_warn) and [`log_info!`](crate::log_info) macros,
//!   which took the place of the bare `eprintln!` this backend used to report
//!   a tray that would not build or a shortcut the OS refused. They still
//!   print to stderr as well, so running the app from a terminal shows
//!   exactly what it always showed.
//! * **Frontend errors.** [`record_frontend`], called by
//!   `commands::diagnostics::log_frontend_error` — which is fed by the React
//!   error boundary and by the `error` / `unhandledrejection` listeners each
//!   of the four windows installs. A crash in the webview and the panic in
//!   the process hosting it land in the same file, in the right order, which
//!   is the whole reason the frontend logs through Rust rather than into its
//!   own file.
//!
//! ## Rotation
//!
//! `logs/routine-launcher.log` is the active file. When a write would take it
//! past [`MAX_FILE_BYTES`] it becomes `routine-launcher.1.log`, the previous
//! `.1` becomes `.2`, and the previous `.2` is deleted. [`KEPT_FILES`] files
//! of half a megabyte is the entire footprint — bounded, because a log that
//! can grow without limit on someone else's disk is a bug of its own, and
//! deep enough that a crash is still readable after the app has been
//! restarted a couple of times since.
//!
//! Nothing here is buffered. A `BufWriter` would lose the last line before a
//! hard crash, and the last line is the one the file exists for.
//!
//! ## Timestamps are UTC
//!
//! Every other date in this backend is local, and asks SQLite for the offset
//! (see `services::screenshots::LocalClock`). This one cannot: the first
//! thing worth logging is the database failing to open, and a panic that is
//! already unwinding is the worst possible moment to be taking the lock on a
//! connection. So the civil-calendar arithmetic at the bottom of this file
//! converts the system clock directly, and every line is stamped `Z` so it
//! cannot be mistaken for wall time.
//!
//! ## Before there is a file
//!
//! [`install_panic_hook`] runs at the top of `run()`, before the Tauri
//! builder exists; [`init`] cannot run until `setup` has resolved the app
//! data directory. Anything recorded in between is held in a small bounded
//! buffer and written the moment the file is open — so a panic during plugin
//! setup, the one crash that happens before there is anywhere to put it, is
//! still in the log afterwards.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// The folder, inside the app's data directory, that holds every log file.
const LOG_DIR_NAME: &str = "logs";

/// The active log file is `routine-launcher.log`; the rotated copies are
/// `routine-launcher.1.log` and `routine-launcher.2.log`.
const LOG_FILE_STEM: &str = "routine-launcher";
const LOG_FILE_EXT: &str = "log";

/// How large the active file may get before it is rotated.
pub const MAX_FILE_BYTES: u64 = 512 * 1024;

/// How many files the folder ever holds: the active one, plus two rotated.
pub const KEPT_FILES: usize = 3;

/// How many lines are held while there is nowhere to write them yet.
///
/// Bounded because the buffer only exists for the handful of milliseconds
/// between the panic hook going on and the file being opened. If something
/// manages to produce more than this in that window, the app is failing hard
/// enough that the first few hundred lines are the interesting ones anyway.
const MAX_PENDING_LINES: usize = 256;

/// The longest frontend message written verbatim.
const MAX_MESSAGE_CHARS: usize = 2_000;

/// The longest frontend stack trace written verbatim.
///
/// Larger than the message, because a stack is the part worth having, and
/// still a cap: [`record_frontend`] is reachable from `invoke`, so the size
/// of what it writes to the user's disk cannot be left to the caller.
const MAX_DETAIL_CHARS: usize = 8_000;

/// How loud a line is. There are only three because there are only three
/// things this app has to say: something failed, something did not go to plan
/// but was handled, and something happened worth seeing in the order it
/// happened in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Error,
    Warn,
    Info,
}

impl Level {
    /// Padded to five characters so the message column lines up down the
    /// file — which is the difference between a log you can skim and one you
    /// have to read.
    fn label(self) -> &'static str {
        match self {
            Self::Error => "ERROR",
            Self::Warn => "WARN ",
            Self::Info => "INFO ",
        }
    }
}

// ---------------------------------------------------------------------------
// Process-wide state
// ---------------------------------------------------------------------------

/// The open file, once there is one.
static SINK: Mutex<Option<Sink>> = Mutex::new(None);

/// Lines recorded before [`init`] found somewhere to put them.
static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Where the files live, published for [`log_file`] and [`log_dir`] — the two
/// things the Settings card and the crash screen need in order to tell the
/// user where to look.
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Takes a lock, ignoring poisoning.
///
/// A panic while the sink lock is held is precisely the moment logging has to
/// keep working — refusing to record the *next* failure because a previous
/// one poisoned the mutex would be the wrong way round. Nothing guarded here
/// has an invariant a half-finished write could break: the worst case is a
/// truncated line.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Setting up
// ---------------------------------------------------------------------------

/// Opens the log file under `app_data_dir` and returns its path.
///
/// Called as the first statement of `setup`, before the database, so that
/// everything after it — including `init_db` failing — has somewhere to be
/// recorded. A failure here is reported and non-fatal: an app that refused to
/// start because it could not write a log would be trading a real feature for
/// a diagnostic one.
pub fn init(app_data_dir: &Path) -> Result<PathBuf, String> {
    let dir = app_data_dir.join(LOG_DIR_NAME);

    let sink = Sink::open(&dir).map_err(|error| {
        format!("could not open the log file in {}: {error}", dir.display())
    })?;
    let path = sink.path.clone();

    *lock(&SINK) = Some(sink);
    let _ = LOG_DIR.set(dir);

    record(
        Level::Info,
        &format!(
            "--- Routine Launcher {} started (pid {}) ---",
            env!("CARGO_PKG_VERSION"),
            std::process::id()
        ),
    );

    // Anything recorded before the file existed goes in directly after the
    // banner. Their own timestamps are a moment earlier than it, which is the
    // honest record of what happened: they were produced before there was
    // anywhere to put them.
    flush_pending();

    Ok(path)
}

/// Records every panic in this process before letting the default hook have
/// it.
///
/// Installed at the top of `run()` rather than in `setup`, because a panic
/// while the Tauri builder is assembling its plugins is exactly the crash a
/// user cannot describe and a log can. Until [`init`] runs there is nowhere
/// to write, so such a panic is held by [`hold`] and lands in the file as
/// soon as there is one.
///
/// The previous hook is kept and called, so `cargo tauri dev` still prints
/// panics to the terminal the way it always did.
pub fn install_panic_hook() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    if INSTALLED.set(()).is_err() {
        return;
    }

    let previous = std::panic::take_hook();

    // The closure's argument is deliberately not named: it is `PanicInfo` up
    // to Rust 1.80 and `PanicHookInfo` from 1.81, and inference spells
    // whichever one this toolchain has. Everything worth testing is pulled
    // out into `panic_report` below.
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let location = info
            .location()
            .map(|at| format!("{}:{}:{}", at.file(), at.line(), at.column()));

        // `force_capture` rather than `capture`, which stays off unless
        // `RUST_BACKTRACE` is set — and nobody sets an environment variable
        // before the crash they did not know was coming. It costs a slow
        // moment during a panic, which is a moment the process was losing
        // anyway.
        let backtrace = std::backtrace::Backtrace::force_capture();

        record(
            Level::Error,
            &panic_report(
                info.payload(),
                location.as_deref(),
                thread.name(),
                &backtrace.to_string(),
            ),
        );

        previous(info);
    }));
}

/// One panic, as the line that goes in the file.
///
/// Four things, because a panic without any of them is a panic nobody can
/// act on: what was thrown, where, on which thread — a background scheduler
/// dying reads very differently from the UI thread doing it — and the
/// backtrace under it. The backtrace is a continuation of the same entry, so
/// [`format_line`] indents it and one timestamp still means one failure.
fn panic_report(
    payload: &(dyn std::any::Any + Send),
    location: Option<&str>,
    thread: Option<&str>,
    backtrace: &str,
) -> String {
    format!(
        "PANIC on thread \"{}\" at {}: {}\n{}",
        thread.unwrap_or("unnamed"),
        location.unwrap_or("an unknown location"),
        payload_text(payload),
        backtrace.trim_end()
    )
}

/// The active log file's path, once [`init`] has opened one.
pub fn log_file() -> Option<PathBuf> {
    LOG_DIR.get().map(|dir| active_path(dir))
}

/// The folder holding the active file and its rotated copies.
pub fn log_dir() -> Option<PathBuf> {
    LOG_DIR.get().cloned()
}

// ---------------------------------------------------------------------------
// Failing where the user can see it
// ---------------------------------------------------------------------------

/// Reports a failure that stops the app from starting at all, and exits.
///
/// `setup` has two steps that cannot be recovered from — resolving the app
/// data directory and opening the database — and both used to `expect`.
/// In a `tauri dev` console that is a readable panic; in the shipped app it is
/// nothing whatsoever. `main.rs` builds with `windows_subsystem = "windows"`,
/// so there is no console for the panic to print to, and `tauri.conf.json`
/// builds the main window hidden (see `services::startup`), so there is no
/// window either. The result was an app that could be double-clicked all
/// morning without so much as an error: the process started, wrote a line to
/// a log the user has no way to know about, and vanished.
///
/// The realistic causes are all a locked-down or unhealthy `%APPDATA%` — a
/// roaming profile that did not sync, a policy or antivirus holding the file,
/// a directory the user has no rights to — which is to say, they are the
/// section 85 permission cases, and the user can usually fix them once they
/// are told which one it is.
///
/// So this says so on screen and then exits. It never returns, and it is
/// deliberately not a panic: the message has already been delivered by the
/// time this is called, and unwinding on top of it would only add a second,
/// less useful report.
///
/// ## Why the message box is `MessageBoxW` and not the dialog plugin
///
/// `tauri-plugin-dialog` is a dependency and would be the obvious choice, but
/// its `blocking_show` dispatches through `run_on_main_thread` and then waits
/// for the result — and `setup` *is* the main thread, so calling it there
/// deadlocks the app instead of reporting anything. Its own documentation
/// says not to. `MessageBoxW` is what the plugin eventually reaches anyway,
/// it needs no window to exist first, and calling it from the thread that
/// owns the message loop is exactly what it is for.
pub fn fatal(summary: &str, error: &dyn std::fmt::Display) -> ! {
    record(Level::Error, &format!("FATAL {summary}: {error}"));

    let mut body = format!("{summary}\n\n{error}");
    match log_file() {
        Some(path) => body.push_str(&format!("\n\nThe details were saved to:\n{}", path.display())),
        // Nowhere to write means `init` failed too, which is worth saying:
        // it is the same cause, and it tells the user not to go looking for a
        // log that is not there.
        None => body.push_str(
            "\n\nNo log file could be opened either, which usually means this app's folder in \
             %APPDATA% cannot be written to.",
        ),
    }

    show_message_box("Routine Launcher cannot start", &body);
    std::process::exit(1)
}

/// Puts one message on screen, with no window and no runtime needed.
///
/// ## Why it runs on a thread of its own
///
/// `MessageBoxW` is modal, and a modal dialog keeps its owner responsive by
/// pumping that thread's message queue while it is up. Called from the main
/// thread — which is where [`fatal`] is called from, `setup` being the main
/// thread — that means the app's *own* window messages are dispatched while
/// the box is on screen, and straight back into Tauri's event handlers.
///
/// Which is exactly the wrong moment for it. The reason `fatal` is being
/// called is that startup did not finish, so the state those handlers expect
/// is not there: `on_window_event` asks for the database connection, `manage`
/// has not been reached, and `state()` panics — inside an FFI callback that
/// cannot unwind, which aborts the process. The dialog was appearing and
/// being torn off the screen a fraction of a second later, which is worse
/// than not showing one at all: the user sees a flash and still has nothing
/// to read.
///
/// A message box on a thread that owns no windows pumps only its own empty
/// queue, so nothing is dispatched anywhere and the main thread sits still
/// until the user clicks OK. `join` is what makes it a modal dialog rather
/// than a race with `exit`.
#[cfg(windows)]
fn show_message_box(title: &str, body: &str) {
    /// The handful of `user32` surface this needs. Declared here rather than
    /// pulled in from the `windows` crate because it is one function and two
    /// constants, and a startup failure is the worst possible thing to make
    /// depend on more code.
    mod win32 {
        #[link(name = "user32")]
        extern "system" {
            pub fn MessageBoxW(
                hwnd: *mut core::ffi::c_void,
                text: *const u16,
                caption: *const u16,
                utype: u32,
            ) -> i32;
        }

        pub const MB_OK: u32 = 0x0000_0000;
        pub const MB_ICONERROR: u32 = 0x0000_0010;
        /// Without these the box can open behind whatever the user is doing,
        /// which for an app that is about to exit means it is never seen.
        pub const MB_SETFOREGROUND: u32 = 0x0001_0000;
        pub const MB_TOPMOST: u32 = 0x0004_0000;
    }

    fn wide(text: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let body = wide(body);
    let title = wide(title);

    let shown = std::thread::spawn(move || {
        // SAFETY: both vectors are NUL-terminated UTF-16 owned by this
        // closure, so they outlive the call; a null owner window is what
        // `MessageBoxW` documents for a dialog with no parent, which is the
        // case here since the failure happens before any window exists.
        unsafe {
            win32::MessageBoxW(
                std::ptr::null_mut(),
                body.as_ptr(),
                title.as_ptr(),
                win32::MB_OK | win32::MB_ICONERROR | win32::MB_SETFOREGROUND | win32::MB_TOPMOST,
            );
        }
    });

    // A thread that could not be spawned, or that panicked, is not a reason
    // to hang: the message is already in the log either way.
    let _ = shown.join();
}

/// Elsewhere there is a console to print to, so the message goes there.
#[cfg(not(windows))]
fn show_message_box(title: &str, body: &str) {
    eprintln!("{title}\n{body}");
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Writes one entry, to the log file and to stderr.
///
/// Reached through [`log_error!`](crate::log_error) and its siblings in the
/// backend, and through [`record_frontend`] from the webviews. A multi-line
/// message (a backtrace, a JS stack) stays one entry: its continuation lines
/// are indented, so one line of the file is one line of the report and a
/// `findstr` for a timestamp still finds entry boundaries.
pub fn record(level: Level, message: &str) {
    let line = format_line(level, message, SystemTime::now());

    // Every call site here used to be an `eprintln!`, and a terminal that
    // stopped showing what the app was doing would be a regression for the
    // person developing it.
    eprintln!("{line}");

    // The sink lock is released before `hold` takes the pending one, so the
    // two are never held at once and can never be taken in the other order by
    // `flush_pending`.
    let unwritten = {
        let mut sink = lock(&SINK);
        match sink.as_mut() {
            Some(sink) => {
                if let Err(error) = sink.write_line(&line) {
                    // Said once, on stderr. Recording a failed log write into
                    // the log is a loop.
                    eprintln!("[logging] could not write to the log file: {error}");
                }
                None
            }
            None => Some(line),
        }
    };

    if let Some(line) = unwritten {
        hold(line);
    }
}

/// Records something the React layer caught (development-plan.md section 85).
///
/// `window` is which of the four webviews it came from, `kind` is how it was
/// caught — a render that threw, an unhandled rejection, a listener that
/// escaped — and `detail` is the stack if there was one.
///
/// Both strings are cut to a fixed length before anything is written. This is
/// reachable from `invoke`, so how much of the user's disk one report can
/// take is not a decision the caller gets to make.
pub fn record_frontend(window: &str, kind: &str, message: &str, detail: Option<&str>) {
    let mut text = format!(
        "[{}] {}: {}",
        clean_token(window),
        clean_token(kind),
        truncate(message.trim(), MAX_MESSAGE_CHARS)
    );

    if let Some(detail) = detail.map(str::trim).filter(|detail| !detail.is_empty()) {
        text.push('\n');
        text.push_str(&truncate(detail, MAX_DETAIL_CHARS));
    }

    record(Level::Error, &text);
}

/// Holds a line until there is a file to put it in.
fn hold(line: String) {
    let mut pending = lock(&PENDING);
    if pending.len() < MAX_PENDING_LINES {
        pending.push(line);
    }
}

/// Writes everything [`hold`] kept.
fn flush_pending() {
    // The guard is a temporary of this statement and is dropped at the end of
    // it, so the sink lock below is never taken while it is held.
    let held = std::mem::take(&mut *lock(&PENDING));
    if held.is_empty() {
        return;
    }

    let mut sink = lock(&SINK);
    let Some(sink) = sink.as_mut() else { return };

    for line in held {
        if let Err(error) = sink.write_line(&line) {
            eprintln!("[logging] could not write the held log lines: {error}");
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// The file itself
// ---------------------------------------------------------------------------

/// The open log file, and how much has gone into it.
struct Sink {
    path: PathBuf,
    file: File,
    written: u64,
    /// Kept on the struct rather than read from the constant, so rotation can
    /// be tested against a few hundred bytes instead of half a megabyte.
    max_bytes: u64,
}

impl Sink {
    fn open(dir: &Path) -> io::Result<Self> {
        Self::open_with_limit(dir, MAX_FILE_BYTES)
    }

    fn open_with_limit(dir: &Path, max_bytes: u64) -> io::Result<Self> {
        fs::create_dir_all(dir)?;

        let path = active_path(dir);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        // Appending to whatever the last run left, so a crash and the restart
        // that followed it are one story rather than two files.
        let written = file.metadata().map(|meta| meta.len()).unwrap_or(0);

        Ok(Self { path, file, written, max_bytes })
    }

    /// Appends one entry, rotating first if it would not fit.
    ///
    /// The size test is against the whole entry rather than a line at a time,
    /// so a backtrace is never split across a rotation — half a stack in each
    /// of two files is worse than either.
    fn write_line(&mut self, line: &str) -> io::Result<()> {
        let bytes = line.len() as u64 + 1;

        if self.written > 0 && self.written + bytes > self.max_bytes {
            if let Err(error) = self.rotate() {
                // A log that cannot be rotated is a log that grows without
                // limit, which is the one outcome worse than losing the older
                // lines. So the file is emptied and the reason for it is the
                // first thing in the new one.
                self.restart(&error)?;
            }
        }

        self.file.write_all(line.as_bytes())?;
        self.file.write_all(b"\n")?;
        self.written += bytes;

        Ok(())
    }

    /// Steps the numbered copies along and starts a fresh active file.
    ///
    /// The handle is reopened rather than kept. Windows will rename a file
    /// that is open — Rust's `File` asks for `FILE_SHARE_DELETE` — but the
    /// handle follows the file to its new name, so writing through it
    /// afterwards would quietly append to the rotated copy and the active
    /// file would stay empty forever.
    ///
    /// Only the last rename is allowed to fail the call. Losing the shuffle
    /// of an older copy costs one file of history; failing to move the active
    /// one out of the way is what would leave the cap unenforced.
    fn rotate(&mut self) -> io::Result<()> {
        let dir = self
            .path
            .parent()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "the log file has no folder"))?
            .to_path_buf();

        let _ = fs::remove_file(rotated_path(&dir, KEPT_FILES - 1));
        for index in (1..KEPT_FILES - 1).rev() {
            let _ = fs::rename(rotated_path(&dir, index), rotated_path(&dir, index + 1));
        }

        fs::rename(&self.path, rotated_path(&dir, 1))?;

        self.file = OpenOptions::new().create(true).append(true).open(&self.path)?;
        self.written = 0;

        Ok(())
    }

    /// Empties the active file, when rotating it was not possible.
    fn restart(&mut self, cause: &io::Error) -> io::Result<()> {
        // `File::create` truncates; the handle it returns is dropped straight
        // away because the appending one below is the one that gets kept.
        drop(File::create(&self.path)?);
        self.file = OpenOptions::new().create(true).append(true).open(&self.path)?;
        self.written = 0;

        let line = format_line(
            Level::Warn,
            &format!("the log could not be rotated ({cause}); it was emptied instead"),
            SystemTime::now(),
        );
        self.file.write_all(line.as_bytes())?;
        self.file.write_all(b"\n")?;
        self.written = line.len() as u64 + 1;

        Ok(())
    }
}

fn active_path(dir: &Path) -> PathBuf {
    dir.join(format!("{LOG_FILE_STEM}.{LOG_FILE_EXT}"))
}

fn rotated_path(dir: &Path, index: usize) -> PathBuf {
    dir.join(format!("{LOG_FILE_STEM}.{index}.{LOG_FILE_EXT}"))
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/// `2026-08-30T09:41:07.612Z ERROR could not create the system tray: ...`
///
/// Continuation lines are indented four spaces, so an entry is recognisable
/// as one thing and a timestamp at the start of a line always means a new
/// one.
fn format_line(level: Level, message: &str, at: SystemTime) -> String {
    let stamp = timestamp(at);
    let label = level.label();

    let mut lines = message.split('\n');
    let first = lines.next().unwrap_or_default();
    let mut out = format!("{stamp} {label} {}", first.trim_end());

    for rest in lines {
        out.push_str("\n    ");
        out.push_str(rest.trim_end());
    }

    out
}

/// Cuts `text` to `limit` characters — on a character boundary, and saying so.
fn truncate(text: &str, limit: usize) -> String {
    let mut kept: String = text.chars().take(limit).collect();
    if kept.len() < text.len() {
        kept.push_str("… (truncated)");
    }
    kept
}

/// Reduces a caller-supplied tag to one short, single-line token.
///
/// `window` and `kind` are written into the *structure* of a line, not into
/// its message, so a newline in one would forge an entry boundary and a long
/// one would push the message off the readable part of the line.
fn clean_token(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|character| if character.is_control() { ' ' } else { character })
        .take(48)
        .collect();

    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned.to_string()
    }
}

/// What a panic was carrying, for the two types a `panic!` can produce.
fn payload_text(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&'static str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("a payload that is neither &str nor String")
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/// UTC, as `2026-08-30T09:41:07.612Z`.
///
/// A clock set before 1970 gets a placeholder rather than losing the entry:
/// the message is the point, and a machine whose clock is wrong is a machine
/// whose log is worth having.
fn timestamp(at: SystemTime) -> String {
    let Ok(since_epoch) = at.duration_since(UNIX_EPOCH) else {
        return "-------0--T--:--:--.---Z".to_string();
    };

    let seconds = since_epoch.as_secs() as i64;
    let millis = since_epoch.subsec_millis();

    let days = floor_div(seconds, 86_400);
    let second_of_day = seconds - days * 86_400;
    let (year, month, day) = civil_from_days(days);

    let hour = second_of_day / 3_600;
    let minute = (second_of_day / 60) % 60;
    let second = second_of_day % 60;

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Integer division rounding towards negative infinity.
///
/// The third copy of this pair in the backend, after `services::screenshots`
/// and `services::large_files`, and deliberately not shared with either: both
/// of those work in *local* days and take their offset from SQLite. This file
/// has to be able to stamp a line while the database is failing to open, so
/// it owns a copy that depends on nothing.
fn floor_div(value: i64, divisor: i64) -> i64 {
    let quotient = value / divisor;
    if value % divisor < 0 {
        quotient - 1
    } else {
        quotient
    }
}

/// Days-since-epoch to `(year, month, day)`, by Howard Hinnant's civil
/// calendar algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = floor_div(shifted, 146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = (if month_prime < 10 { month_prime + 3 } else { month_prime - 9 }) as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

// ---------------------------------------------------------------------------
// The macros
// ---------------------------------------------------------------------------

/// Records a failure, and prints it to stderr the way `eprintln!` did.
///
/// ```ignore
/// crate::log_error!("could not create the system tray: {error}");
/// ```
#[macro_export]
macro_rules! log_error {
    ($($argument:tt)*) => {
        $crate::services::logging::record(
            $crate::services::logging::Level::Error,
            &format!($($argument)*),
        )
    };
}

/// Records something that did not go to plan but was handled.
#[macro_export]
macro_rules! log_warn {
    ($($argument:tt)*) => {
        $crate::services::logging::record(
            $crate::services::logging::Level::Warn,
            &format!($($argument)*),
        )
    };
}

/// Records something worth reading in the order it happened in.
#[macro_export]
macro_rules! log_info {
    ($($argument:tt)*) => {
        $crate::services::logging::record(
            $crate::services::logging::Level::Info,
            &format!($($argument)*),
        )
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    /// A folder of this test's own. No `tempfile` dependency for a handful of
    /// tests: the process id plus a counter is unique enough, and the same
    /// trick the other filesystem services use.
    fn temp_dir(name: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "routine-launcher-logging-{name}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("could not create the test folder");
        dir
    }

    fn at(epoch_millis: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(epoch_millis)
    }

    #[test]
    fn a_line_is_stamped_in_utc_to_the_millisecond() {
        // 1_788_082_867_612 ms is 2026-08-30T09:41:07.612Z.
        assert_eq!(
            format_line(Level::Error, "the tray would not build", at(1_788_082_867_612)),
            "2026-08-30T09:41:07.612Z ERROR the tray would not build"
        );
    }

    #[test]
    fn the_epoch_and_a_leap_day_both_convert() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2024-02-29, the case the shifted-year arithmetic exists for.
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }

    #[test]
    fn continuation_lines_are_indented_so_an_entry_stays_one_entry() {
        let line = format_line(Level::Error, "PANIC: nope\n  at one\n  at two", at(0));

        let mut lines = line.lines();
        assert_eq!(lines.next(), Some("1970-01-01T00:00:00.000Z ERROR PANIC: nope"));
        assert_eq!(lines.next(), Some("      at one"));
        assert_eq!(lines.next(), Some("      at two"));
        assert_eq!(lines.next(), None);
    }

    #[test]
    fn writing_past_the_limit_rotates_and_keeps_only_the_last_three_files() {
        let dir = temp_dir("rotate");
        let mut sink = Sink::open_with_limit(&dir, 200).expect("could not open the log");

        // Each entry is over a third of the limit, so this rotates several
        // times and has to drop the oldest copy more than once.
        for index in 0..40 {
            sink.write_line(&format!("{index:0>80}")).expect("could not write");
        }

        let files: Vec<_> = fs::read_dir(&dir)
            .expect("could not read the log folder")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();

        assert_eq!(files.len(), KEPT_FILES, "kept {files:?}");
        assert!(files.contains(&"routine-launcher.log".to_string()));
        assert!(files.contains(&"routine-launcher.1.log".to_string()));
        assert!(files.contains(&"routine-launcher.2.log".to_string()));

        // The active file holds the newest entry, and no file is over the cap.
        let active = fs::read_to_string(active_path(&dir)).expect("could not read the log");
        assert!(active.contains(&format!("{:0>80}", 39)), "active file was {active}");
        for name in files {
            let length = fs::metadata(dir.join(name)).expect("could not stat").len();
            assert!(length <= 200, "a rotated file was {length} bytes");
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reopening_appends_rather_than_replacing() {
        let dir = temp_dir("append");

        let mut first = Sink::open(&dir).expect("could not open the log");
        first.write_line("the first run").expect("could not write");
        drop(first);

        let mut second = Sink::open(&dir).expect("could not reopen the log");
        second.write_line("the second run").expect("could not write");
        drop(second);

        let contents = fs::read_to_string(active_path(&dir)).expect("could not read the log");
        assert!(contents.contains("the first run"));
        assert!(contents.contains("the second run"));

        let _ = fs::remove_dir_all(&dir);
    }

    /// The one test that uses the process-wide sink rather than a local
    /// `Sink`, because it is about the globals: that a line recorded before
    /// there was a file survives, that `init` publishes a path the commands
    /// can answer with, and that a frontend report reaches the same file the
    /// backend writes to. `LOG_DIR` is a `OnceLock`, so there can only ever
    /// be one of these in a test binary.
    #[test]
    fn init_publishes_a_path_and_writes_what_was_held_before_it() {
        let dir = temp_dir("init");

        // Recorded while there is nowhere to put it.
        record(Level::Error, "something failed before the file existed");

        let path = init(&dir).expect("logging should start");
        assert_eq!(path, dir.join(LOG_DIR_NAME).join("routine-launcher.log"));
        assert_eq!(log_file().as_deref(), Some(path.as_path()));
        assert_eq!(log_dir().as_deref(), Some(dir.join(LOG_DIR_NAME).as_path()));

        record_frontend("popup", "render", "TypeError: x is not a function", Some("at Popup"));

        let contents = fs::read_to_string(&path).expect("could not read the log");
        assert!(contents.contains("Routine Launcher"), "no banner in {contents}");
        assert!(contents.contains("something failed before the file existed"));
        assert!(contents.contains("[popup] render: TypeError: x is not a function"));
        assert!(contents.contains("\n    at Popup"), "the stack was not indented");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_frontend_report_cannot_choose_how_much_disk_it_uses() {
        let long = "x".repeat(MAX_MESSAGE_CHARS + 500);
        let cut = truncate(&long, MAX_MESSAGE_CHARS);

        assert!(cut.starts_with(&"x".repeat(MAX_MESSAGE_CHARS)));
        assert!(cut.ends_with("(truncated)"));
        assert!(cut.chars().count() < long.chars().count());
    }

    #[test]
    fn truncation_lands_on_a_character_boundary() {
        // Four bytes each, so a byte-wise cut at 2 would split one.
        assert_eq!(truncate("🙂🙂🙂", 2), "🙂🙂… (truncated)");
        assert_eq!(truncate("🙂🙂", 2), "🙂🙂");
    }

    #[test]
    fn a_tag_from_the_frontend_cannot_forge_an_entry_boundary() {
        assert_eq!(clean_token("popup"), "popup");
        // A newline would end the entry and let the rest of the tag pose as
        // the next one. It becomes a space instead.
        assert_eq!(
            clean_token("main\n2026-01-01T00:00:00.000Z ERROR"),
            "main 2026-01-01T00:00:00.000Z ERROR"
        );
        // And a tag long enough to push the message off the line is cut.
        assert_eq!(clean_token(&"w".repeat(200)), "w".repeat(48));
        assert_eq!(clean_token("   "), "unknown");
    }

    #[test]
    fn a_panic_is_reported_with_its_thread_its_place_and_its_backtrace() {
        let report = panic_report(
            &String::from("failed to initialize database"),
            Some("src/db/mod.rs:31:5"),
            Some("reminder-scheduler"),
            "   0: routine_launcher_lib::db::init_db\n   1: core::ops::function\n",
        );

        // One entry once it is stamped: the backtrace is indented under the
        // first line rather than becoming three of its own.
        let line = format_line(Level::Error, &report, at(0));
        let mut lines = line.lines();
        assert_eq!(
            lines.next(),
            Some(
                "1970-01-01T00:00:00.000Z ERROR PANIC on thread \"reminder-scheduler\" \
                 at src/db/mod.rs:31:5: failed to initialize database"
            )
        );
        assert_eq!(lines.next(), Some("       0: routine_launcher_lib::db::init_db"));
        assert_eq!(lines.next(), Some("       1: core::ops::function"));
        assert_eq!(lines.next(), None);
    }

    #[test]
    fn a_panic_with_nothing_known_about_it_still_reads_as_a_sentence() {
        let report = panic_report(&"nope", None, None, "");
        assert_eq!(report, "PANIC on thread \"unnamed\" at an unknown location: nope\n");
    }

    #[test]
    fn a_panic_payload_is_read_for_both_shapes_a_panic_can_carry() {
        assert_eq!(payload_text(&"a literal"), "a literal");
        assert_eq!(payload_text(&String::from("a formatted message")), "a formatted message");
        assert_eq!(payload_text(&7_u32), "a payload that is neither &str nor String");
    }
}
