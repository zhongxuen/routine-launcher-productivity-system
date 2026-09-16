//! Application usage tracking (development-plan.md sections 37, 57, 92 Tier 5).
//!
//! "Track how long applications are open" — and section 37's warning with it:
//! this is **usage time, not productivity time**. Nothing that pays XP, ticks a
//! quest, keeps a streak or feeds the productivity statistics reads this
//! module's table. It has its own tab under Progress, labelled as usage, and
//! one consumer elsewhere: section 55's "you often open these together" rule
//! in `services::suggestions`.
//!
//! # What is recorded
//!
//! Off until the user turns it on. While on, a background thread looks at the
//! foreground window every [`SAMPLE_SECONDS`] and credits that interval to the
//! program that owns it, by executable name, in the local hour it happened.
//! Time the user is idle for longer than [`IDLE_SECONDS`] is not credited: an
//! editor left in front over lunch was not in use. Window titles, documents
//! and URLs are never read — the table has no column that could hold them.
//!
//! Samples are summed in memory and written once every [`FLUSH_SECONDS`], so
//! the shared connection is borrowed once a minute rather than every few
//! seconds. Switching tracking off flushes what is held, and closing the app
//! loses at most that last minute, which is fine for a figure shown in
//! minutes.
//!
//! Rows older than [`RETENTION_DAYS`] are deleted as new ones are written.
//! Usage history is only useful recently, and a table that grows forever is a
//! privacy cost with no benefit.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db::DbConnection;

use super::error::{ServiceError, ServiceResult};
use super::settings;

/// Settings key for the opt-in. Absent means off.
pub const TRACKING_ENABLED_KEY: &str = "usage.tracking_enabled";

/// How often the foreground window is looked at.
pub const SAMPLE_SECONDS: u64 = 5;
/// How often the held samples are written.
pub const FLUSH_SECONDS: u64 = 60;
/// No keyboard or mouse input for this long, and the time stops counting.
pub const IDLE_SECONDS: u64 = 5 * 60;
/// How much history is kept.
pub const RETENTION_DAYS: i64 = 90;
/// The longest range the usage tab asks for.
pub const MAX_RANGE_DAYS: i64 = RETENTION_DAYS;

/// Programs that are the shell rather than something the user opened: the
/// lock screen, the Start menu, search. Time in front of these is not "using
/// an application", so it is not recorded at all.
const SHELL_PROCESSES: &[&str] = &[
    "lockapp.exe",
    "shellexperiencehost.exe",
    "startmenuexperiencehost.exe",
    "searchhost.exe",
    "searchapp.exe",
    "searchui.exe",
    "logonui.exe",
];

/// The switch, mirrored in memory so the sampler does not read the database
/// every five seconds. Written by [`set_tracking_enabled`] and by [`start`].
static TRACKING: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One program's usage over the range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppTotal {
    /// The executable's file name, e.g. `Code.exe`.
    pub app_name: String,
    /// The most recent full path seen for it, if any.
    pub exe_path: Option<String>,
    pub seconds: i64,
    /// Distinct local days it was used on.
    pub days_used: i64,
}

/// All programs' usage on one local day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayTotal {
    pub date: String,
    pub seconds: i64,
}

/// What the usage tab draws.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub tracking_enabled: bool,
    /// First and last local date of the range, inclusive.
    pub from: String,
    pub to: String,
    pub total_seconds: i64,
    /// Most used first.
    pub apps: Vec<AppTotal>,
    /// Every day of the range, oldest first, zero where nothing was recorded.
    pub days: Vec<DayTotal>,
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

pub fn tracking_enabled(conn: &Connection) -> ServiceResult<bool> {
    settings::get_bool(conn, TRACKING_ENABLED_KEY, false)
}

/// Stores the switch and tells the sampler. Answers the stored value.
pub fn set_tracking_enabled(conn: &Connection, enabled: bool) -> ServiceResult<bool> {
    settings::set_bool(conn, TRACKING_ENABLED_KEY, enabled)?;
    TRACKING.store(enabled, Ordering::Relaxed);
    tracking_enabled(conn)
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// One sampled interval: which program, when, and for how long.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sample {
    /// Local `YYYY-MM-DD`.
    pub date: String,
    /// Local hour, 0-23.
    pub hour: i64,
    pub app_name: String,
    pub exe_path: Option<String>,
    pub seconds: i64,
}

/// Samples summed by (date, hour, program) until they are written.
#[derive(Debug, Default)]
pub struct Pending {
    totals: HashMap<(String, i64, String), (Option<String>, i64)>,
}

impl Pending {
    pub fn add(&mut self, sample: Sample) {
        if sample.seconds <= 0 || sample.app_name.trim().is_empty() {
            return;
        }
        let entry = self
            .totals
            .entry((sample.date, sample.hour, sample.app_name))
            .or_insert((None, 0));
        if sample.exe_path.is_some() {
            entry.0 = sample.exe_path;
        }
        entry.1 += sample.seconds;
    }

    pub fn is_empty(&self) -> bool {
        self.totals.is_empty()
    }

    /// Writes everything held in one transaction, prunes old history, and
    /// empties the buffer only once that succeeded.
    pub fn flush(&mut self, conn: &Connection) -> ServiceResult<()> {
        if self.totals.is_empty() {
            return Ok(());
        }

        conn.execute_batch("SAVEPOINT app_usage_flush;")?;
        let written = (|| -> ServiceResult<()> {
            for ((date, hour, app_name), (exe_path, seconds)) in &self.totals {
                record(conn, date, *hour, app_name, exe_path.as_deref(), *seconds)?;
            }
            prune(conn).map(drop)
        })();

        match written {
            Ok(()) => {
                conn.execute_batch("RELEASE app_usage_flush;")?;
                self.totals.clear();
                Ok(())
            }
            Err(error) => {
                conn.execute_batch("ROLLBACK TO app_usage_flush; RELEASE app_usage_flush;")?;
                Err(error)
            }
        }
    }
}

/// Adds `seconds` to a program's hour, creating the row if needed.
pub fn record(
    conn: &Connection,
    date: &str,
    hour: i64,
    app_name: &str,
    exe_path: Option<&str>,
    seconds: i64,
) -> ServiceResult<()> {
    if !(0..=23).contains(&hour) {
        return Err(ServiceError::validation(format!("{hour} is not an hour of the day.")));
    }
    conn.execute(
        "INSERT INTO app_usage (date, hour, app_name, exe_path, seconds)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (date, hour, app_name) DO UPDATE SET
            seconds = seconds + excluded.seconds,
            exe_path = COALESCE(excluded.exe_path, exe_path)",
        params![date, hour, app_name, exe_path, seconds.max(0)],
    )?;
    Ok(())
}

/// Deletes history older than [`RETENTION_DAYS`].
pub fn prune(conn: &Connection) -> ServiceResult<usize> {
    Ok(conn.execute(
        "DELETE FROM app_usage WHERE date < date('now', 'localtime', ?1)",
        params![format!("-{RETENTION_DAYS} days")],
    )?)
}

/// Deletes every recorded minute. The switch is left as it is.
pub fn clear(conn: &Connection) -> ServiceResult<()> {
    conn.execute("DELETE FROM app_usage", [])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Usage over the last `days` local days, today included.
pub fn summary(conn: &Connection, days: i64) -> ServiceResult<UsageSummary> {
    let today: String = conn.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))?;
    summary_on(conn, &today, days)
}

/// [`summary`] as of the local date `today`, which is what the tests pin.
pub fn summary_on(conn: &Connection, today: &str, days: i64) -> ServiceResult<UsageSummary> {
    if !(1..=MAX_RANGE_DAYS).contains(&days) {
        return Err(ServiceError::validation(format!(
            "Usage can be shown for 1 to {MAX_RANGE_DAYS} days."
        )));
    }

    let from: String = conn.query_row(
        "SELECT date(?1, ?2)",
        params![today, format!("-{} days", days - 1)],
        |row| row.get(0),
    )?;

    let mut statement = conn.prepare(
        "SELECT app_name,
                SUM(seconds) AS seconds,
                COUNT(DISTINCT date) AS days_used,
                (SELECT exe_path FROM app_usage latest
                  WHERE latest.app_name = app_usage.app_name AND latest.exe_path IS NOT NULL
                  ORDER BY latest.date DESC, latest.hour DESC LIMIT 1) AS exe_path
           FROM app_usage
          WHERE date BETWEEN ?1 AND ?2
          GROUP BY app_name
         HAVING SUM(seconds) > 0
          ORDER BY seconds DESC, app_name",
    )?;
    let apps = statement
        .query_map(params![from, today], |row| {
            Ok(AppTotal {
                app_name: row.get("app_name")?,
                exe_path: row.get("exe_path")?,
                seconds: row.get("seconds")?,
                days_used: row.get("days_used")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut per_day: HashMap<String, i64> = HashMap::new();
    let mut statement = conn.prepare(
        "SELECT date, SUM(seconds) FROM app_usage WHERE date BETWEEN ?1 AND ?2 GROUP BY date",
    )?;
    for row in statement.query_map(params![from, today], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })? {
        let (date, seconds) = row?;
        per_day.insert(date, seconds);
    }

    let mut days_out = Vec::with_capacity(days as usize);
    for offset in 0..days {
        let date: String = conn.query_row(
            "SELECT date(?1, ?2)",
            params![from, format!("+{offset} days")],
            |row| row.get(0),
        )?;
        let seconds = per_day.get(&date).copied().unwrap_or(0);
        days_out.push(DayTotal { date, seconds });
    }

    Ok(UsageSummary {
        tracking_enabled: tracking_enabled(conn)?,
        from,
        to: today.to_string(),
        total_seconds: apps.iter().map(|app| app.seconds).sum(),
        apps,
        days: days_out,
    })
}

// ---------------------------------------------------------------------------
// The sampler
// ---------------------------------------------------------------------------

/// Whether a program is part of the shell rather than something opened.
pub fn is_shell_process(app_name: &str) -> bool {
    let lower = app_name.to_ascii_lowercase();
    SHELL_PROCESSES.contains(&lower.as_str())
}

/// Starts the background sampler. Called once from `setup`, after the
/// connection is managed. It runs for the life of the process and does
/// nothing but sleep while tracking is off.
pub fn start(app: AppHandle) {
    let enabled = match app.state::<DbConnection>().lock() {
        Ok(conn) => tracking_enabled(&conn).unwrap_or(false),
        Err(_) => false,
    };
    TRACKING.store(enabled, Ordering::Relaxed);

    let spawned = std::thread::Builder::new()
        .name("app-usage".into())
        .spawn(move || run(app));
    if let Err(error) = spawned {
        crate::log_error!("[usage] could not start the usage sampler: {error}");
    }
}

fn run(app: AppHandle) {
    let own_exe = std::env::current_exe()
        .ok()
        .and_then(|path| path.file_name().map(|name| name.to_string_lossy().to_ascii_lowercase()));
    let mut pending = Pending::default();
    let mut last_flush = Instant::now();

    loop {
        std::thread::sleep(Duration::from_secs(SAMPLE_SECONDS));

        let tracking = TRACKING.load(Ordering::Relaxed);
        if tracking {
            if let Some(sample) = platform::sample(SAMPLE_SECONDS as i64) {
                let is_own = own_exe.as_deref() == Some(sample.app_name.to_ascii_lowercase().as_str());
                if !is_own && !is_shell_process(&sample.app_name) {
                    pending.add(sample);
                }
            }
        }

        let due = last_flush.elapsed() >= Duration::from_secs(FLUSH_SECONDS);
        if (due || !tracking) && !pending.is_empty() {
            last_flush = Instant::now();
            let Some(state) = app.try_state::<DbConnection>() else {
                continue;
            };
            let flushed = match state.lock() {
                Ok(conn) => pending.flush(&conn).map_err(|error| error.to_string()),
                Err(error) => Err(error.to_string()),
            };
            if let Err(error) = flushed {
                crate::log_error!("[usage] could not record application usage: {error}");
            }
        } else if due {
            last_flush = Instant::now();
        }
    }
}

#[cfg(windows)]
mod platform {
    //! The `user32` / `kernel32` surface the sampler needs, declared here for
    //! the same reason `services::storage` declares its own: a handful of
    //! functions that have not changed in twenty years do not justify the
    //! `windows` crate.

    use std::ffi::c_void;

    use super::{Sample, IDLE_SECONDS};

    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        dw_time: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindowThreadProcessId(window: *mut c_void, process_id: *mut u32) -> u32;
        fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut c_void;
        fn QueryFullProcessImageNameW(
            process: *mut c_void,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetTickCount() -> u32;
        fn GetLocalTime(time: *mut SystemTime);
    }

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    /// The foreground program right now, credited with `seconds`, or `None`
    /// when there is no foreground window, the user is idle, or the program
    /// cannot be named.
    pub fn sample(seconds: i64) -> Option<Sample> {
        if idle_seconds() >= IDLE_SECONDS {
            return None;
        }

        // SAFETY: no arguments; a null return is handled.
        let window = unsafe { GetForegroundWindow() };
        if window.is_null() {
            return None;
        }

        let mut process_id = 0u32;
        // SAFETY: `window` came from the OS a moment ago and `process_id` is
        // a valid out-pointer. A stale handle yields 0, which is handled.
        unsafe { GetWindowThreadProcessId(window, &mut process_id) };
        if process_id == 0 {
            return None;
        }

        let path = image_path(process_id)?;
        let app_name = std::path::Path::new(&path)
            .file_name()?
            .to_string_lossy()
            .into_owned();

        let mut now = SystemTime::default();
        // SAFETY: `now` is a correctly laid out SYSTEMTIME.
        unsafe { GetLocalTime(&mut now) };

        Some(Sample {
            date: format!("{:04}-{:02}-{:02}", now.year, now.month, now.day),
            hour: i64::from(now.hour),
            app_name,
            exe_path: Some(path),
            seconds,
        })
    }

    fn idle_seconds() -> u64 {
        let mut info = LastInputInfo {
            cb_size: std::mem::size_of::<LastInputInfo>() as u32,
            dw_time: 0,
        };
        // SAFETY: `info.cb_size` is set as the API requires.
        if unsafe { GetLastInputInfo(&mut info) } == 0 {
            return 0;
        }
        // SAFETY: no arguments. Both values wrap every 49.7 days together.
        let now = unsafe { GetTickCount() };
        u64::from(now.wrapping_sub(info.dw_time)) / 1000
    }

    fn image_path(process_id: u32) -> Option<String> {
        // SAFETY: a plain open with the least access that can read the image
        // name; a null handle (an elevated or protected process) is handled.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if process.is_null() {
            return None;
        }

        let mut buffer = vec![0u16; 1024];
        let mut size = buffer.len() as u32;
        // SAFETY: `buffer` holds `size` UTF-16 units and `size` is updated
        // with the length written.
        let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) };
        // SAFETY: `process` is a handle this function opened.
        unsafe { CloseHandle(process) };

        if ok == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

#[cfg(not(windows))]
mod platform {
    use super::Sample;

    /// Usage tracking is Windows-only, like the rest of the desktop surface.
    pub fn sample(_seconds: i64) -> Option<Sample> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    fn sample(date: &str, hour: i64, app: &str, seconds: i64) -> Sample {
        Sample {
            date: date.into(),
            hour,
            app_name: app.into(),
            exe_path: Some(format!("C:/Apps/{app}")),
            seconds,
        }
    }

    #[test]
    fn tracking_is_off_until_switched_on() {
        let conn = init_memory_db().unwrap();
        assert!(!tracking_enabled(&conn).unwrap());
        assert!(set_tracking_enabled(&conn, true).unwrap());
        assert!(tracking_enabled(&conn).unwrap());
    }

    #[test]
    fn samples_are_summed_per_program_per_hour() {
        let conn = init_memory_db().unwrap();
        let mut pending = Pending::default();
        for _ in 0..12 {
            pending.add(sample("2026-09-16", 9, "Code.exe", 5));
        }
        pending.add(sample("2026-09-16", 10, "Code.exe", 5));
        pending.add(sample("2026-09-16", 9, "chrome.exe", 5));
        pending.add(sample("2026-09-16", 9, "chrome.exe", 0));
        pending.flush(&conn).unwrap();
        assert!(pending.is_empty());

        // A second flush adds to the same rows rather than duplicating them.
        pending.add(sample("2026-09-16", 9, "Code.exe", 5));
        pending.flush(&conn).unwrap();

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM app_usage", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 3);
        let code_nine: i64 = conn
            .query_row(
                "SELECT seconds FROM app_usage WHERE app_name = 'Code.exe' AND hour = 9",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(code_nine, 65);
    }

    #[test]
    fn a_summary_lists_programs_by_time_and_every_day_of_the_range() {
        let conn = init_memory_db().unwrap();
        record(&conn, "2026-09-14", 9, "chrome.exe", Some("C:/chrome.exe"), 600).unwrap();
        record(&conn, "2026-09-16", 9, "Code.exe", Some("C:/Code.exe"), 3600).unwrap();
        record(&conn, "2026-09-16", 14, "chrome.exe", None, 1200).unwrap();
        // Outside a three-day range.
        record(&conn, "2026-09-13", 9, "Spotify.exe", None, 9999).unwrap();

        let summary = summary_on(&conn, "2026-09-16", 3).unwrap();
        assert_eq!(summary.from, "2026-09-14");
        assert_eq!(summary.total_seconds, 5400);
        assert_eq!(
            summary.apps.iter().map(|app| app.app_name.as_str()).collect::<Vec<_>>(),
            ["Code.exe", "chrome.exe"]
        );
        assert_eq!(summary.apps[1].days_used, 2);
        assert_eq!(summary.apps[1].exe_path.as_deref(), Some("C:/chrome.exe"));
        assert_eq!(
            summary.days,
            vec![
                DayTotal { date: "2026-09-14".into(), seconds: 600 },
                DayTotal { date: "2026-09-15".into(), seconds: 0 },
                DayTotal { date: "2026-09-16".into(), seconds: 4800 },
            ]
        );
    }

    #[test]
    fn a_range_has_limits() {
        let conn = init_memory_db().unwrap();
        assert!(summary_on(&conn, "2026-09-16", 0).is_err());
        assert!(summary_on(&conn, "2026-09-16", MAX_RANGE_DAYS + 1).is_err());
    }

    #[test]
    fn old_history_is_pruned_and_clear_removes_everything() {
        let conn = init_memory_db().unwrap();
        let old: String = conn
            .query_row(
                "SELECT date('now', 'localtime', ?1)",
                [format!("-{} days", RETENTION_DAYS + 5)],
                |row| row.get(0),
            )
            .unwrap();
        let today: String = conn
            .query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))
            .unwrap();
        record(&conn, &old, 9, "Old.exe", None, 60).unwrap();
        record(&conn, &today, 9, "New.exe", None, 60).unwrap();

        assert_eq!(prune(&conn).unwrap(), 1);
        clear(&conn).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM app_usage", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn the_table_cannot_hold_a_window_title() {
        // Section 68: only which program, never what was in it. Checked
        // against the schema, so a column added later fails here first.
        let conn = init_memory_db().unwrap();
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(app_usage)")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(columns, ["id", "date", "hour", "app_name", "exe_path", "seconds"]);
    }

    #[test]
    fn the_shell_is_not_an_application() {
        assert!(is_shell_process("LockApp.exe"));
        assert!(is_shell_process("SEARCHHOST.EXE"));
        assert!(!is_shell_process("Code.exe"));
    }
}
