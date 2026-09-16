//! Key/value access to the `settings` table, and section 52's Daily Settings.
//!
//! The table is a plain string map (see `database/migrations/0001_init.sql`
//! and development-plan.md section 52): every feature that needs a persisted
//! preference owns its own key and its own typed accessor, and the first half
//! of this module only handles the read/write/parse mechanics they share.
//!
//! Keys are namespaced by feature (`routines.command_actions_enabled`, ...)
//! so two features can never collide on one.
//!
//! The second half is the one group of settings that belongs to no single
//! feature: section 52's Daily Settings, under the `daily.` prefix. They are
//! read by the focus timer, the task forms, the quests, the statistics and the
//! start- and end-of-day flows alike, so they live beside the table rather
//! than inside any one of those. See [`DailySettings`].

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::error::{ServiceError, ServiceResult};
use super::tasks::TaskPriority;
use super::validate::validate_time;

/// Returns the raw stored string, or `None` if the key was never written.
pub fn get(conn: &Connection, key: &str) -> ServiceResult<Option<String>> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(ServiceError::from)
}

/// Writes `value`, replacing whatever was there and refreshing `updated_at`.
pub fn set(conn: &Connection, key: &str, value: &str) -> ServiceResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at)
         VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at",
        params![key, value],
    )?;
    Ok(())
}

/// Reads a boolean flag, falling back to `default` when the key is unset.
///
/// Anything that is not exactly `"true"` reads as false, so a corrupted or
/// hand-edited value can never accidentally *enable* a flag — which matters
/// for the command-execution switch in development-plan.md section 66.
pub fn get_bool(conn: &Connection, key: &str, default: bool) -> ServiceResult<bool> {
    Ok(get(conn, key)?.map_or(default, |value| value == "true"))
}

pub fn set_bool(conn: &Connection, key: &str, value: bool) -> ServiceResult<()> {
    set(conn, key, if value { "true" } else { "false" })
}

// ---------------------------------------------------------------------------
// Daily settings (section 52)
// ---------------------------------------------------------------------------

const DAY_START_KEY: &str = "daily.day_start_time";
const DAY_END_KEY: &str = "daily.day_end_time";
const FOCUS_MINUTES_KEY: &str = "daily.default_focus_minutes";
const TASK_PRIORITY_KEY: &str = "daily.default_task_priority";
const REMINDER_KEY: &str = "daily.default_reminder_minutes";
const START_ROUTINE_KEY: &str = "daily.start_of_day_routine_id";
const END_ROUTINE_KEY: &str = "daily.end_of_day_routine_id";
const QUEST_COUNT_KEY: &str = "daily.quest_count";
const WEEK_START_KEY: &str = "daily.week_start";
const END_OF_DAY_NOTIFICATION_KEY: &str = "daily.end_of_day_notification";

/// How an unset optional value — no reminder, no routine — is written, so the
/// row says what was chosen rather than being an empty string.
const NONE_VALUE: &str = "none";

/// The range of the default focus length, in minutes. Narrower than what the
/// Custom preset accepts on its own: this is the length a day is *planned*
/// around, and four hours is already a long way past section 34's longest
/// preset.
pub const MIN_FOCUS_MINUTES: i64 = 5;
pub const MAX_FOCUS_MINUTES: i64 = 240;

/// The lead times a default reminder may have — the same five the task forms
/// offer (section 24), so the default is always one of the form's options.
pub const REMINDER_LEAD_TIMES: [i64; 5] = [5, 10, 15, 30, 60];

/// Section 44: "Only 2–3 quests should appear per day."
pub const MIN_QUEST_COUNT: i64 = 2;
pub const MAX_QUEST_COUNT: i64 = 3;

/// The first day of the week the statistics count within (sections 36, 82).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WeekStart {
    #[default]
    Monday,
    Sunday,
}

impl WeekStart {
    fn as_str(self) -> &'static str {
        match self {
            Self::Monday => "monday",
            Self::Sunday => "sunday",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "monday" => Some(Self::Monday),
            "sunday" => Some(Self::Sunday),
            _ => None,
        }
    }

    /// SQLite's modifier for moving a date forward to this weekday, the date
    /// itself included — `weekday 0` is Sunday and `weekday 1` Monday.
    pub fn sqlite_modifier(self) -> &'static str {
        match self {
            Self::Monday => "weekday 1",
            Self::Sunday => "weekday 0",
        }
    }
}

/// Section 52's nine Daily Settings, as one value, plus the switch for the
/// end-of-day notification (section 22).
///
/// Read and written whole, because two of them are only valid together (the
/// day has to end after it starts) and because every screen that reads one
/// tends to be next to a screen that reads another. Each is stored under its
/// own `daily.` key rather than as one JSON blob, so a key that was never
/// written — which on an existing install is all nine of them — reads as its
/// default without a migration, and a value that cannot be parsed costs only
/// itself.
///
/// Eight of the nine have consumers in this build: the focus length, the task
/// priority and the reminder are form defaults, the quest count and the week
/// start shape the quests and the statistics, the start-of-day routine is what
/// Start My Day opens, and the day's start and end times bound PLAN TODAY's
/// time left (both read on the frontend). The end-of-day routine is what End
/// My Day opens, and the day's end is when the dashboard offers the review
/// and, if switched on, when [`super::end_of_day`] sends its one notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailySettings {
    /// Local 24-hour `HH:MM`.
    pub day_start_time: String,
    /// Local 24-hour `HH:MM`, after `day_start_time`.
    pub day_end_time: String,
    /// The length the Custom focus preset starts at.
    pub default_focus_minutes: i64,
    /// The priority a new task starts with.
    pub default_task_priority: TaskPriority,
    /// "Remind me N minutes before" for a new task with a due time, or none.
    pub default_reminder_minutes: Option<i64>,
    pub start_of_day_routine_id: Option<i64>,
    pub end_of_day_routine_id: Option<i64>,
    /// How many of the day's quests appear: 2 or 3.
    pub daily_quest_count: i64,
    pub week_start: WeekStart,
    /// One native notification at the day's end, offering the review. Off
    /// unless turned on: section 22's review is optional, so it does not
    /// announce itself to someone who never asked. `serde(default)` so a
    /// payload from before the switch existed still reads.
    #[serde(default)]
    pub end_of_day_notification: bool,
}

impl Default for DailySettings {
    fn default() -> Self {
        Self {
            day_start_time: "09:00".to_owned(),
            day_end_time: "18:00".to_owned(),
            default_focus_minutes: 50,
            default_task_priority: TaskPriority::Normal,
            default_reminder_minutes: None,
            start_of_day_routine_id: None,
            end_of_day_routine_id: None,
            daily_quest_count: MAX_QUEST_COUNT,
            week_start: WeekStart::Monday,
            end_of_day_notification: false,
        }
    }
}

/// The stored Daily Settings, each missing or unreadable one as its default.
///
/// Reading is forgiving where writing is strict: a value [`set_daily_settings`]
/// would refuse — hand-edited, or left by a routine that has since been
/// deleted — reads as the default rather than failing the read, so the
/// Settings card always opens on something it can save.
pub fn daily_settings(conn: &Connection) -> ServiceResult<DailySettings> {
    let defaults = DailySettings::default();

    let start = read(conn, DAY_START_KEY, |value| validate_time("", value).ok())?
        .unwrap_or_else(|| defaults.day_start_time.clone());
    let end = read(conn, DAY_END_KEY, |value| validate_time("", value).ok())?
        .unwrap_or_else(|| defaults.day_end_time.clone());
    // Kept only as a pair: one readable time and one default could otherwise
    // make a day that ends before it begins.
    let (day_start_time, day_end_time) = if end > start {
        (start, end)
    } else {
        (defaults.day_start_time, defaults.day_end_time)
    };

    Ok(DailySettings {
        day_start_time,
        day_end_time,
        default_focus_minutes: read(conn, FOCUS_MINUTES_KEY, |value| {
            value.parse().ok().filter(|minutes| focus_minutes_allowed(*minutes))
        })?
        .unwrap_or(defaults.default_focus_minutes),
        default_task_priority: read(conn, TASK_PRIORITY_KEY, TaskPriority::parse)?
            .unwrap_or(defaults.default_task_priority),
        default_reminder_minutes: read(conn, REMINDER_KEY, |value| {
            value.parse().ok().filter(|minutes| REMINDER_LEAD_TIMES.contains(minutes))
        })?,
        start_of_day_routine_id: stored_routine(conn, START_ROUTINE_KEY)?,
        end_of_day_routine_id: stored_routine(conn, END_ROUTINE_KEY)?,
        daily_quest_count: read(conn, QUEST_COUNT_KEY, |value| {
            value.parse().ok().filter(|count| quest_count_allowed(*count))
        })?
        .unwrap_or(defaults.daily_quest_count),
        week_start: week_start(conn)?,
        end_of_day_notification: get_bool(conn, END_OF_DAY_NOTIFICATION_KEY, false)?,
    })
}

/// Just the week start, for the statistics — which have no business checking
/// that the day's routines still exist.
pub fn week_start(conn: &Connection) -> ServiceResult<WeekStart> {
    Ok(read(conn, WEEK_START_KEY, WeekStart::parse)?.unwrap_or_default())
}

/// Validates all nine settings and stores them, answering with what was
/// stored. Nothing is written unless every one of them is acceptable.
pub fn set_daily_settings(
    conn: &Connection,
    settings: DailySettings,
) -> ServiceResult<DailySettings> {
    let settings = validate_daily_settings(conn, settings)?;

    let transaction = conn.unchecked_transaction()?;
    set(&transaction, DAY_START_KEY, &settings.day_start_time)?;
    set(&transaction, DAY_END_KEY, &settings.day_end_time)?;
    set(
        &transaction,
        FOCUS_MINUTES_KEY,
        &settings.default_focus_minutes.to_string(),
    )?;
    set(
        &transaction,
        TASK_PRIORITY_KEY,
        settings.default_task_priority.as_str(),
    )?;
    set(
        &transaction,
        REMINDER_KEY,
        &optional_number(settings.default_reminder_minutes),
    )?;
    set(
        &transaction,
        START_ROUTINE_KEY,
        &optional_number(settings.start_of_day_routine_id),
    )?;
    set(
        &transaction,
        END_ROUTINE_KEY,
        &optional_number(settings.end_of_day_routine_id),
    )?;
    set(
        &transaction,
        QUEST_COUNT_KEY,
        &settings.daily_quest_count.to_string(),
    )?;
    set(&transaction, WEEK_START_KEY, settings.week_start.as_str())?;
    set_bool(
        &transaction,
        END_OF_DAY_NOTIFICATION_KEY,
        settings.end_of_day_notification,
    )?;
    transaction.commit()?;

    Ok(settings)
}

/// Section 52's rules, each refused with a sentence the Settings card can
/// show as it is.
///
/// The priority and the week start are not checked here because they cannot
/// be wrong by the time they arrive: both are enums, and `serde` refuses any
/// other string before a command runs.
pub fn validate_daily_settings(
    conn: &Connection,
    settings: DailySettings,
) -> ServiceResult<DailySettings> {
    let day_start_time = validate_time("Start of day", &settings.day_start_time)?;
    let day_end_time = validate_time("End of day", &settings.day_end_time)?;
    // Zero-padded HH:MM sorts the way the clock does, so the strings compare.
    if day_end_time <= day_start_time {
        return Err(ServiceError::validation(format!(
            "The end of the day ({day_end_time}) must be after its start ({day_start_time})."
        )));
    }

    if !focus_minutes_allowed(settings.default_focus_minutes) {
        return Err(ServiceError::validation(format!(
            "Default focus length must be between {MIN_FOCUS_MINUTES} and {MAX_FOCUS_MINUTES} \
             minutes."
        )));
    }

    if let Some(minutes) = settings.default_reminder_minutes {
        if !REMINDER_LEAD_TIMES.contains(&minutes) {
            return Err(ServiceError::validation(
                "Default reminder must be none, or 5, 10, 15, 30 or 60 minutes before.",
            ));
        }
    }

    for (label, routine_id) in [
        ("start-of-day", settings.start_of_day_routine_id),
        ("end-of-day", settings.end_of_day_routine_id),
    ] {
        if let Some(id) = routine_id {
            if !routine_exists(conn, id)? {
                return Err(ServiceError::validation(format!(
                    "The {label} routine no longer exists. Choose another, or none."
                )));
            }
        }
    }

    if !quest_count_allowed(settings.daily_quest_count) {
        return Err(ServiceError::validation(format!(
            "Daily quests must be {MIN_QUEST_COUNT} or {MAX_QUEST_COUNT}."
        )));
    }

    Ok(DailySettings {
        day_start_time,
        day_end_time,
        ..settings
    })
}

fn focus_minutes_allowed(minutes: i64) -> bool {
    (MIN_FOCUS_MINUTES..=MAX_FOCUS_MINUTES).contains(&minutes)
}

fn quest_count_allowed(count: i64) -> bool {
    (MIN_QUEST_COUNT..=MAX_QUEST_COUNT).contains(&count)
}

fn routine_exists(conn: &Connection, id: i64) -> ServiceResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM routines WHERE id = ?1)",
        params![id],
        |row| row.get(0),
    )?)
}

/// A stored routine id, or none if it was never set, is not a number, or
/// names a routine that has since been deleted.
fn stored_routine(conn: &Connection, key: &str) -> ServiceResult<Option<i64>> {
    match read(conn, key, |value| value.parse::<i64>().ok())? {
        Some(id) if routine_exists(conn, id)? => Ok(Some(id)),
        _ => Ok(None),
    }
}

/// The stored value under `key` put through `parse`, or `None` when the key is
/// unset or `parse` refuses what is there.
fn read<T>(
    conn: &Connection,
    key: &str,
    parse: impl FnOnce(&str) -> Option<T>,
) -> ServiceResult<Option<T>> {
    Ok(get(conn, key)?.and_then(|value| parse(&value)))
}

fn optional_number(value: Option<i64>) -> String {
    value.map_or_else(|| NONE_VALUE.to_owned(), |number| number.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    #[test]
    fn round_trips_values_and_defaults_unset_keys() {
        let conn = init_memory_db().unwrap();

        assert_eq!(get(&conn, "missing").unwrap(), None);
        assert!(get_bool(&conn, "missing", true).unwrap());
        assert!(!get_bool(&conn, "missing", false).unwrap());

        set(&conn, "greeting", "hello").unwrap();
        set(&conn, "greeting", "hi").unwrap();
        assert_eq!(get(&conn, "greeting").unwrap().as_deref(), Some("hi"));

        set_bool(&conn, "flag", true).unwrap();
        assert!(get_bool(&conn, "flag", false).unwrap());
    }

    #[test]
    fn only_the_exact_string_true_reads_as_enabled() {
        let conn = init_memory_db().unwrap();
        for stored in ["TRUE", "1", "yes", "", "false"] {
            set(&conn, "flag", stored).unwrap();
            assert!(
                !get_bool(&conn, "flag", false).unwrap(),
                "{stored:?} must not enable a flag"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Daily settings
    // -----------------------------------------------------------------------

    /// A routine, returning its id.
    fn a_routine(conn: &Connection, name: &str) -> i64 {
        conn.execute("INSERT INTO routines (name) VALUES (?1)", params![name])
            .unwrap();
        conn.last_insert_rowid()
    }

    /// The defaults with one change, for a test about that one field.
    fn with(change: impl FnOnce(&mut DailySettings)) -> DailySettings {
        let mut settings = DailySettings::default();
        change(&mut settings);
        settings
    }

    fn refusal(conn: &Connection, settings: DailySettings) -> String {
        set_daily_settings(conn, settings)
            .expect_err("the settings should have been refused")
            .to_string()
    }

    #[test]
    fn unset_daily_settings_read_as_the_plan_defaults() {
        let conn = init_memory_db().unwrap();
        let settings = daily_settings(&conn).unwrap();

        assert_eq!(settings.day_start_time, "09:00");
        assert_eq!(settings.day_end_time, "18:00");
        assert_eq!(settings.default_focus_minutes, 50);
        assert_eq!(settings.default_task_priority, TaskPriority::Normal);
        assert_eq!(settings.default_reminder_minutes, None);
        assert_eq!(settings.start_of_day_routine_id, None);
        assert_eq!(settings.end_of_day_routine_id, None);
        assert_eq!(settings.daily_quest_count, 3);
        assert_eq!(settings.week_start, WeekStart::Monday);
        assert!(!settings.end_of_day_notification);
        assert_eq!(settings, DailySettings::default());
    }

    #[test]
    fn daily_settings_round_trip() {
        let conn = init_memory_db().unwrap();
        let morning = a_routine(&conn, "Start My Day");
        let evening = a_routine(&conn, "End My Day");

        let chosen = DailySettings {
            day_start_time: "07:30".to_owned(),
            day_end_time: "16:45".to_owned(),
            default_focus_minutes: 90,
            default_task_priority: TaskPriority::High,
            default_reminder_minutes: Some(10),
            start_of_day_routine_id: Some(morning),
            end_of_day_routine_id: Some(evening),
            daily_quest_count: 2,
            week_start: WeekStart::Sunday,
            end_of_day_notification: true,
        };

        assert_eq!(set_daily_settings(&conn, chosen.clone()).unwrap(), chosen);
        assert_eq!(daily_settings(&conn).unwrap(), chosen);
        assert_eq!(week_start(&conn).unwrap(), WeekStart::Sunday);

        // And back to none, which is stored as a choice rather than left over.
        let cleared = DailySettings {
            default_reminder_minutes: None,
            start_of_day_routine_id: None,
            end_of_day_routine_id: None,
            end_of_day_notification: false,
            ..chosen
        };
        set_daily_settings(&conn, cleared.clone()).unwrap();
        assert_eq!(daily_settings(&conn).unwrap(), cleared);
    }

    #[test]
    fn times_must_be_24_hour_hh_mm() {
        let conn = init_memory_db().unwrap();

        for bad in ["9:00", "24:00", "12:60", "", "noon", "09:00:00", " 09:00"] {
            let message = refusal(&conn, with(|s| s.day_start_time = bad.to_owned()));
            assert!(message.contains("Start of day"), "{bad:?}: {message}");

            let message = refusal(&conn, with(|s| s.day_end_time = bad.to_owned()));
            assert!(message.contains("End of day"), "{bad:?}: {message}");
        }

        set_daily_settings(
            &conn,
            with(|s| {
                s.day_start_time = "00:00".to_owned();
                s.day_end_time = "23:59".to_owned();
            }),
        )
        .expect("the whole day is a day");
    }

    #[test]
    fn the_day_must_end_after_it_starts() {
        let conn = init_memory_db().unwrap();

        for (start, end) in [("18:00", "09:00"), ("09:00", "09:00"), ("09:01", "09:00")] {
            let message = refusal(
                &conn,
                with(|s| {
                    s.day_start_time = start.to_owned();
                    s.day_end_time = end.to_owned();
                }),
            );
            assert!(message.contains("must be after"), "{start}–{end}: {message}");
        }

        set_daily_settings(
            &conn,
            with(|s| {
                s.day_start_time = "09:00".to_owned();
                s.day_end_time = "09:01".to_owned();
            }),
        )
        .expect("a minute is short, but it is after");
    }

    #[test]
    fn the_focus_length_is_5_to_240_minutes() {
        let conn = init_memory_db().unwrap();

        for bad in [-50, 0, 4, 241, 480] {
            let message = refusal(&conn, with(|s| s.default_focus_minutes = bad));
            assert!(message.contains("focus length"), "{bad}: {message}");
        }
        for good in [5, 25, 50, 240] {
            set_daily_settings(&conn, with(|s| s.default_focus_minutes = good))
                .unwrap_or_else(|error| panic!("{good} minutes was refused: {error}"));
        }
    }

    #[test]
    fn the_reminder_is_none_or_one_of_the_form_lead_times() {
        let conn = init_memory_db().unwrap();

        for bad in [-5, 0, 1, 20, 45, 61, 1440] {
            let message = refusal(&conn, with(|s| s.default_reminder_minutes = Some(bad)));
            assert!(message.contains("reminder"), "{bad}: {message}");
        }
        for good in [None, Some(5), Some(10), Some(15), Some(30), Some(60)] {
            set_daily_settings(&conn, with(|s| s.default_reminder_minutes = good))
                .unwrap_or_else(|error| panic!("{good:?} was refused: {error}"));
        }
    }

    #[test]
    fn each_routine_must_exist_or_be_none() {
        let conn = init_memory_db().unwrap();
        let routine = a_routine(&conn, "Coding");

        let message = refusal(&conn, with(|s| s.start_of_day_routine_id = Some(9_999)));
        assert!(message.contains("start-of-day routine"), "{message}");
        let message = refusal(&conn, with(|s| s.end_of_day_routine_id = Some(9_999)));
        assert!(message.contains("end-of-day routine"), "{message}");

        set_daily_settings(
            &conn,
            with(|s| {
                // The same routine at both ends is odd but not wrong.
                s.start_of_day_routine_id = Some(routine);
                s.end_of_day_routine_id = Some(routine);
            }),
        )
        .unwrap();
    }

    #[test]
    fn the_quest_count_is_2_or_3() {
        let conn = init_memory_db().unwrap();

        for bad in [-1, 0, 1, 4, 10] {
            let message = refusal(&conn, with(|s| s.daily_quest_count = bad));
            assert!(message.contains("Daily quests"), "{bad}: {message}");
        }
        for good in [2, 3] {
            set_daily_settings(&conn, with(|s| s.daily_quest_count = good)).unwrap();
        }
    }

    #[test]
    fn the_priority_and_week_start_accept_only_their_own_values() {
        let payload = |priority: &str, week_start: &str| {
            serde_json::json!({
                "dayStartTime": "09:00",
                "dayEndTime": "18:00",
                "defaultFocusMinutes": 50,
                "defaultTaskPriority": priority,
                "defaultReminderMinutes": null,
                "startOfDayRoutineId": null,
                "endOfDayRoutineId": null,
                "dailyQuestCount": 3,
                "weekStart": week_start,
            })
        };
        let parse = |priority, week_start| {
            serde_json::from_value::<DailySettings>(payload(priority, week_start))
        };

        for priority in ["low", "normal", "high", "urgent"] {
            assert!(parse(priority, "monday").is_ok(), "{priority} should be accepted");
        }
        for week_start in ["monday", "sunday"] {
            assert!(parse("normal", week_start).is_ok(), "{week_start} should be accepted");
        }

        for priority in ["", "Normal", "critical", "medium"] {
            assert!(parse(priority, "monday").is_err(), "{priority:?} should be refused");
        }
        for week_start in ["", "Monday", "saturday", "wednesday"] {
            assert!(parse("normal", week_start).is_err(), "{week_start:?} should be refused");
        }
    }

    #[test]
    fn a_refused_save_changes_nothing() {
        let conn = init_memory_db().unwrap();
        let saved = with(|s| s.default_focus_minutes = 25);
        set_daily_settings(&conn, saved.clone()).unwrap();

        // Every field but the last is fine, so a partial write would show.
        let refused = DailySettings {
            day_start_time: "06:00".to_owned(),
            default_focus_minutes: 90,
            daily_quest_count: 7,
            ..saved.clone()
        };
        refusal(&conn, refused);

        assert_eq!(daily_settings(&conn).unwrap(), saved);
    }

    #[test]
    fn unreadable_stored_values_read_as_their_defaults() {
        let conn = init_memory_db().unwrap();
        let defaults = DailySettings::default();

        set(&conn, DAY_START_KEY, "9am").unwrap();
        set(&conn, FOCUS_MINUTES_KEY, "1000").unwrap();
        set(&conn, TASK_PRIORITY_KEY, "extreme").unwrap();
        set(&conn, REMINDER_KEY, "20").unwrap();
        set(&conn, START_ROUTINE_KEY, "not a number").unwrap();
        set(&conn, QUEST_COUNT_KEY, "5").unwrap();
        set(&conn, WEEK_START_KEY, "friday").unwrap();

        assert_eq!(daily_settings(&conn).unwrap(), defaults);
    }

    #[test]
    fn a_stored_day_that_ends_before_it_starts_reads_as_the_default_day() {
        let conn = init_memory_db().unwrap();
        set(&conn, DAY_START_KEY, "20:00").unwrap();
        set(&conn, DAY_END_KEY, "08:00").unwrap();

        let settings = daily_settings(&conn).unwrap();
        assert_eq!(settings.day_start_time, "09:00");
        assert_eq!(settings.day_end_time, "18:00");
    }

    #[test]
    fn a_deleted_routine_reads_as_none() {
        let conn = init_memory_db().unwrap();
        let routine = a_routine(&conn, "Start My Day");
        set_daily_settings(&conn, with(|s| s.start_of_day_routine_id = Some(routine))).unwrap();

        conn.execute("DELETE FROM routines WHERE id = ?1", params![routine])
            .unwrap();

        let settings = daily_settings(&conn).unwrap();
        assert_eq!(settings.start_of_day_routine_id, None);
        // So the card can save what it opened on without being refused.
        set_daily_settings(&conn, settings).unwrap();
    }
}
