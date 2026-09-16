//! When the end-of-day notification is owed (development-plan.md section 22).
//!
//! Section 22 calls the review optional, so nothing here opens it. The most
//! the app does on its own is one native notification at the day's end from
//! Settings > Daily — and only when the user has switched that on, which is
//! off by default. The review itself is opened from the dashboard, the tray
//! or the quick launcher.
//!
//! The rule is kept here, free of the Tauri runtime, so it can be tested; the
//! reminder scheduler in `commands/notification.rs` asks it on every poll and
//! does the showing.

use rusqlite::Connection;

use super::error::ServiceResult;
use super::settings;

/// The local date the notification was last sent on, so it is sent once a
/// day however many polls land after the end time.
const NOTIFIED_ON_KEY: &str = "daily.end_of_day_notified_on";

/// How late after the day's end the notification may still go out.
///
/// The scheduler polls every 30 seconds, so a running app is well inside
/// this. What it rules out is the app being started at 11 PM and greeting the
/// user with "your day has ended" hours after it did — a notification about
/// the end time belongs at the end time.
pub const GRACE_MINUTES: i64 = 30;

/// Whether the notification is owed now, recording it as sent if it is.
///
/// The check and the record are one call because they are one decision: the
/// notification is owed at most once a day, and a caller that could check
/// without recording could send it twice. Recording comes before showing, so
/// a notification the OS then fails to show is lost for the day rather than
/// retried every 30 seconds.
pub fn take_notification(conn: &Connection) -> ServiceResult<bool> {
    let daily = settings::daily_settings(conn)?;
    if !daily.end_of_day_notification {
        return Ok(false);
    }

    let (today, now): (String, String) = conn.query_row(
        "SELECT date('now', 'localtime'), strftime('%H:%M', 'now', 'localtime')",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let last = settings::get(conn, NOTIFIED_ON_KEY)?;

    if !is_owed(&daily.day_end_time, &now, &today, last.as_deref()) {
        return Ok(false);
    }

    settings::set(conn, NOTIFIED_ON_KEY, &today)?;
    Ok(true)
}

/// The rule, on plain values: at or after the day's end, inside the grace
/// period, and not already sent today. Times are 24-hour `HH:MM`.
fn is_owed(day_end: &str, now: &str, today: &str, last_notified_on: Option<&str>) -> bool {
    if last_notified_on == Some(today) {
        return false;
    }

    match (minutes_of(day_end), minutes_of(now)) {
        (Some(end), Some(now)) => (end..end + GRACE_MINUTES).contains(&now),
        _ => false,
    }
}

fn minutes_of(time: &str) -> Option<i64> {
    let (hours, minutes) = time.split_once(':')?;
    Some(hours.parse::<i64>().ok()? * 60 + minutes.parse::<i64>().ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;
    use crate::services::settings::{set_daily_settings, DailySettings};

    #[test]
    fn owed_from_the_end_time_until_the_grace_period_runs_out() {
        assert!(!is_owed("18:00", "17:59", "2026-09-16", None));
        assert!(is_owed("18:00", "18:00", "2026-09-16", None));
        assert!(is_owed("18:00", "18:29", "2026-09-16", None));
        assert!(!is_owed("18:00", "18:30", "2026-09-16", None));
        assert!(!is_owed("18:00", "23:00", "2026-09-16", None));
    }

    #[test]
    fn sent_once_a_day() {
        assert!(!is_owed("18:00", "18:05", "2026-09-16", Some("2026-09-16")));
        // Yesterday's notification does not stand in for today's.
        assert!(is_owed("18:00", "18:05", "2026-09-16", Some("2026-09-15")));
    }

    #[test]
    fn a_grace_period_past_midnight_does_not_wrap() {
        // 23:50 + 30 minutes would be 00:20 tomorrow, which is tomorrow's
        // day rather than the end of this one.
        assert!(is_owed("23:50", "23:59", "2026-09-16", None));
        assert!(!is_owed("23:50", "00:05", "2026-09-17", None));
    }

    #[test]
    fn unreadable_times_are_never_owed() {
        assert!(!is_owed("6pm", "18:00", "2026-09-16", None));
        assert!(!is_owed("18:00", "", "2026-09-16", None));
    }

    #[test]
    fn nothing_is_sent_while_the_switch_is_off() {
        let conn = init_memory_db().unwrap();
        // The default: off.
        assert!(!take_notification(&conn).unwrap());
        assert_eq!(settings::get(&conn, NOTIFIED_ON_KEY).unwrap(), None);
    }

    #[test]
    fn a_day_already_notified_is_not_notified_again() {
        let conn = init_memory_db().unwrap();
        set_daily_settings(
            &conn,
            DailySettings {
                day_start_time: "00:00".to_owned(),
                day_end_time: "00:01".to_owned(),
                end_of_day_notification: true,
                ..Default::default()
            },
        )
        .unwrap();
        let today: String = conn
            .query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))
            .unwrap();
        settings::set(&conn, NOTIFIED_ON_KEY, &today).unwrap();

        assert!(!take_notification(&conn).unwrap());
    }
}
