//! What a notification says.
//!
//! Section 24 shows a reminder as a title, a line about the task and three
//! buttons; section 34's timer needs the same treatment when a session runs
//! out, and again when the break after it does. All are assembled here, as
//! plain values, and `commands/
//! notification.rs` is what hands them to the OS — services stay free of the
//! Tauri runtime, the same split `routine_exec` and `commands/routines.rs`
//! use for launching and emitting.
//!
//! Keeping the wording here rather than at the point of delivery is what lets
//! the frontend show *the same* reminder when the notification cannot: the
//! payload that goes to the OS and the payload emitted to the app are one
//! struct, built once, so an in-app prompt and a desktop toast can never
//! describe the same reminder differently.
//!
//! ## Action buttons
//!
//! Section 24 asks for Start Task / Snooze / Dismiss on the notification
//! itself, "where the OS supports them". With `tauri-plugin-notification`
//! 2.3.3 no desktop platform does:
//!
//! * the desktop implementation builds its toast from title, body, icon and
//!   sound only, and drops `action_type_id` on the floor
//!   (`tauri-plugin-notification/src/desktop.rs`);
//! * the `ActionType`/`Action` models that describe buttons are compiled
//!   `#[cfg(mobile)]` and have no public constructor, so a Rust caller cannot
//!   build one on any platform;
//! * and nothing in the desktop path reports a click back to the app, so
//!   there is no button *and* no callback to hang one on.
//!
//! So [`NATIVE_ACTION_BUTTONS`] is false and every notification is built for
//! the fallback: the body says where the actions are, and the same
//! [`ReminderNotification`] is emitted to the frontend, which owns the three
//! buttons instead. The three actions still travel with the payload rather
//! than being assumed by the UI, so when a platform does grow real buttons
//! the list they are built from is already the right one.

use serde::Serialize;

use super::focus::FocusSession;
use super::reminders::{PendingReminder, ReminderKind, DEFAULT_SNOOZE_MINUTES};

/// Whether the OS notification itself can carry Start Task / Snooze /
/// Dismiss buttons. See the module docs: not with this plugin, on any
/// platform this app targets.
///
/// A constant rather than a `cfg!` because it is a fact about the plugin, not
/// about the target: it is false on Windows, macOS and Linux for the same
/// reason. When that changes, this is the one place to change.
pub const NATIVE_ACTION_BUTTONS: bool = false;

/// The identifier the notification is tagged with for the buttons it would
/// carry on a platform that supports them.
///
/// Set on every reminder even though today's desktop implementation ignores
/// it: it costs nothing, and it means the notification already carries the
/// identity a future action-capable platform would attach its buttons to.
pub const REMINDER_ACTION_TYPE: &str = "task-reminder";

/// The name the fallback tells the user to go and look in. Matches
/// `productName` in `tauri.conf.json`.
///
/// Public because the tray of section 27 heads its menu with the same name,
/// and two spellings of the product in two surfaces would be one too many.
pub const PRODUCT_NAME: &str = "Routine Launcher";

/// Section 24's three buttons.
///
/// Carried on the payload rather than hardcoded in the UI so that the
/// notification and whatever renders it always offer the same choices — and
/// so a reminder can one day arrive with fewer (a task with no routine has
/// nothing to launch, for instance) without the UI having to work that out
/// for itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReminderAction {
    /// Start the task: launch its routine, if it has one, and focus on it.
    StartTask,
    /// Put the reminder back for a few minutes.
    Snooze,
    /// Silence this reminder. Never touches the task.
    Dismiss,
}

/// One reminder, ready both to show and to send to the frontend.
///
/// `title` and `body` are what the OS displays; everything below them is what
/// the app needs to act on the reminder — which is the whole of the fallback,
/// since the buttons live in the app rather than on the toast.
#[derive(Debug, Clone, Serialize)]
pub struct ReminderNotification {
    pub task_id: i64,
    pub task_title: String,
    /// The routine the task starts with (section 18), or null. Start Task
    /// launches it before the timer, so the payload carries it rather than
    /// making the handler re-read the task.
    pub routine_id: Option<i64>,
    pub title: String,
    pub body: String,
    /// The countdown on its own — section 24's "Due in 10 minutes." — without
    /// the line `body` adds telling the user where the buttons went.
    ///
    /// Carried separately rather than left for the frontend to re-derive from
    /// `minutes_until_due`: this module's whole point is that one reminder is
    /// worded once, and an in-app prompt that computed its own sentence would
    /// be the second wording. It is also the only part of `body` that still
    /// makes sense in a window where the buttons are right there.
    pub due_phrase: String,
    /// Which of section 24's buttons this reminder offers.
    pub actions: Vec<ReminderAction>,
    /// False when those buttons are the app's to draw rather than the OS's —
    /// see [`NATIVE_ACTION_BUTTONS`]. The frontend uses it to decide whether
    /// to raise its own prompt or leave the toast to it.
    pub native_actions: bool,
    /// What Snooze should ask for when the user does not choose a length.
    pub snooze_minutes: i64,
    /// True when this is a snooze coming back rather than the reminder's
    /// first delivery.
    pub snoozed: bool,
    pub due_date: String,
    pub due_time: Option<String>,
    /// Minutes until the task is due at the moment the notification was
    /// built; null when the task has no due time. Negative once it is late.
    pub minutes_until_due: Option<i64>,
}

/// The notification for one owed reminder.
pub fn for_reminder(pending: &PendingReminder) -> ReminderNotification {
    let due_phrase = due_phrase(pending);

    ReminderNotification {
        task_id: pending.task_id,
        task_title: pending.task_title.clone(),
        routine_id: pending.routine_id,
        // The mockup in section 24 heads the notification "🔔 Reminder" and
        // puts the task on the next line. Here the task *is* the title,
        // because the OS already labels every toast with the app it came
        // from: a second line saying it is a reminder would push the only
        // thing worth reading at a glance further down.
        title: format!("🔔 {}", pending.task_title),
        body: reminder_body(&due_phrase),
        due_phrase,
        actions: vec![
            ReminderAction::StartTask,
            ReminderAction::Snooze,
            ReminderAction::Dismiss,
        ],
        native_actions: NATIVE_ACTION_BUTTONS,
        snooze_minutes: DEFAULT_SNOOZE_MINUTES,
        snoozed: pending.snoozed,
        due_date: pending.due_date.clone(),
        due_time: pending.due_time.clone(),
        minutes_until_due: pending.minutes_until_due,
    }
}

/// A finished focus session, announced (section 34's timer running out).
#[derive(Debug, Clone, Serialize)]
pub struct FocusCompleteNotification {
    pub session_id: i64,
    pub task_id: Option<i64>,
    pub task_title: Option<String>,
    pub title: String,
    pub body: String,
}

/// The notification for a focus session that has just finished.
///
/// Only worth sending for a session that *completed*: an abandoned one was
/// stopped by the user, who was therefore looking at the app and does not
/// need to be told. The caller decides — see `commands/focus.rs`.
pub fn for_focus_session(session: &FocusSession) -> FocusCompleteNotification {
    let length = describe_length(session.duration_seconds.unwrap_or(session.elapsed_seconds));

    let mut body = match &session.task_title {
        Some(task) => format!("{length} of focus on {task}."),
        None => format!("{length} of focus."),
    };

    // The break is half the point of a Pomodoro preset (section 34's 25/5,
    // 50/10 and 90/15), and the moment it is owed is exactly now. Custom and
    // Stopwatch sessions have no break to suggest, so they are not given one.
    if let Some(minutes) = break_minutes(session) {
        body.push_str(&format!(" Take a {minutes}-minute break."));
    }

    FocusCompleteNotification {
        session_id: session.id,
        task_id: session.task_id,
        task_title: session.task_title.clone(),
        title: "✅ Focus session complete".to_owned(),
        body,
    }
}

/// The notification for a focus break that has run out (section 34's 5 of
/// 25/5).
///
/// The break is the one clock with nothing on record — it is not focus, so
/// there is no row for this to hang off the way [`for_focus_session`] hangs
/// off an ended session — and it arrives with only what the frontend knows:
/// how long the break was, and the task or routine the next session is for.
/// That name is the whole point of the body: the break is over, and the thing
/// to get back to is the thing the user was on.
pub fn break_over(minutes: i64, back_to: Option<&str>) -> (String, String) {
    let mut body = format!("Your {}-minute break is over.", minutes.max(1));

    match back_to {
        Some(name) => body.push_str(&format!(" Back to {name} when you're ready.")),
        None => body.push_str(" Start another session when you're ready."),
    }

    ("☕ Break over".to_owned(), body)
}

/// The one-off notice that closing the window did not close the app
/// (development-plan.md section 27).
///
/// Shown the first time the main window is closed to the tray and never
/// again. A window that vanishes while the process keeps running is the one
/// genuinely surprising thing about a tray app, and the surprise is worth
/// exactly one sentence — after which the behaviour is learned, and a toast
/// every time would be nagging. The Settings toggle is named in the body
/// because a user who does not want this needs to know where to turn it off.
pub fn minimized_to_tray() -> (String, String) {
    (
        format!("{PRODUCT_NAME} is still running"),
        "It is in the notification area — click the icon to bring it back. \
         Turn this off in Settings to quit on close instead."
            .to_owned(),
    )
}

/// A one-off notification for the Settings page's "send a test" button, so a
/// user whose OS has notifications muted finds out before a reminder is the
/// thing that goes missing.
pub fn test_notification() -> (String, String) {
    (
        format!("🔔 {PRODUCT_NAME}"),
        "Notifications are working. Task reminders will arrive like this.".to_owned(),
    )
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/// Section 24's "Due in 10 minutes.", plus the line that says where the
/// buttons went when the OS cannot draw them.
fn reminder_body(due_phrase: &str) -> String {
    let mut body = due_phrase.to_owned();

    if !NATIVE_ACTION_BUTTONS {
        body.push(' ');
        body.push_str(&format!("Open {PRODUCT_NAME} to start, snooze or dismiss."));
    }

    body
}

/// How long there is left, in words.
///
/// Read from the countdown at the moment the notification is built rather
/// than from the lead time it was configured with, so a reminder delayed by a
/// closed lid or a busy machine tells the truth: "10 minutes before" that
/// arrives eight minutes late says two minutes, not ten.
fn due_phrase(pending: &PendingReminder) -> String {
    let Some(minutes) = pending.minutes_until_due else {
        // No due time to count towards. An `at_time` reminder on a task due
        // "today" is the ordinary way to get here, and today is all there is
        // to say.
        return match pending.kind {
            ReminderKind::AtTime => "Due today.".to_owned(),
            ReminderKind::MinutesBefore => "Due soon.".to_owned(),
        };
    };

    match minutes {
        0 => "Due now.".to_owned(),
        minutes if minutes < 0 => format!("Overdue by {}.", plain_length(-minutes)),
        minutes => format!("Due in {}.", plain_length(minutes)),
    }
}

/// "1 minute", "45 minutes", "1 hour", "2 hours 5 minutes".
fn plain_length(minutes: i64) -> String {
    let (hours, minutes) = (minutes / 60, minutes % 60);

    match (hours, minutes) {
        (0, minutes) => pluralize(minutes, "minute"),
        (hours, 0) => pluralize(hours, "hour"),
        (hours, minutes) => format!("{} {}", pluralize(hours, "hour"), pluralize(minutes, "minute")),
    }
}

/// A focus session's length, rounded to the minute it is worth reporting.
///
/// A session is measured in seconds but nobody wants "1500 seconds", and a
/// session shorter than a minute has no useful number at all — section 88
/// would rather say nothing precise than round it to a misleading "0
/// minutes".
fn describe_length(seconds: i64) -> String {
    let minutes = seconds / 60;
    if minutes < 1 {
        return "Under a minute".to_owned();
    }
    plain_length(minutes)
}

fn pluralize(count: i64, noun: &str) -> String {
    if count == 1 {
        format!("1 {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

/// The break the session's preset calls for, in minutes, or `None` for a
/// preset that does not define one.
fn break_minutes(session: &FocusSession) -> Option<i64> {
    session.preset.break_minutes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::focus::FocusPreset;

    fn pending(minutes_until_due: Option<i64>, kind: ReminderKind) -> PendingReminder {
        PendingReminder {
            task_id: 7,
            task_title: "Finish project documentation".to_owned(),
            kind,
            minutes_before: Some(10),
            due_date: "2026-08-28".to_owned(),
            due_time: minutes_until_due.map(|_| "17:00".to_owned()),
            minutes_until_due,
            snoozed: false,
            routine_id: Some(3),
        }
    }

    fn session(preset: FocusPreset, seconds: i64, task: Option<&str>) -> FocusSession {
        FocusSession {
            id: 12,
            task_id: task.map(|_| 7),
            routine_id: None,
            preset,
            planned_seconds: Some(seconds),
            started_at: "2026-08-28 09:00:00".to_owned(),
            ended_at: Some("2026-08-28 09:50:00".to_owned()),
            duration_seconds: Some(seconds),
            completed: true,
            interrupted: false,
            elapsed_seconds: seconds,
            task_title: task.map(str::to_owned),
            routine_name: None,
        }
    }

    #[test]
    fn a_reminder_leads_with_the_task_and_says_how_long_is_left() {
        let notification = for_reminder(&pending(Some(10), ReminderKind::MinutesBefore));

        assert_eq!(notification.title, "🔔 Finish project documentation");
        assert!(
            notification.body.starts_with("Due in 10 minutes."),
            "{}",
            notification.body
        );
        // The countdown on its own: what an in-app prompt shows, without the
        // line telling the user to go and open the app they are looking at.
        assert_eq!(notification.due_phrase, "Due in 10 minutes.");
        assert!(!notification.due_phrase.contains("Open"));
        assert_eq!(notification.task_id, 7);
        assert_eq!(notification.routine_id, Some(3));
        assert_eq!(
            notification.actions,
            vec![
                ReminderAction::StartTask,
                ReminderAction::Snooze,
                ReminderAction::Dismiss
            ]
        );
    }

    #[test]
    fn a_reminder_says_where_the_buttons_are_when_the_os_has_none() {
        let notification = for_reminder(&pending(Some(10), ReminderKind::MinutesBefore));

        assert_eq!(notification.native_actions, NATIVE_ACTION_BUTTONS);
        assert_eq!(
            notification.body.contains("Open Routine Launcher"),
            !NATIVE_ACTION_BUTTONS,
            "the fallback line belongs on the body exactly when the OS draws no buttons"
        );
    }

    #[test]
    fn the_countdown_is_worded_from_what_is_actually_left() {
        let phrases = [
            (Some(1), "Due in 1 minute."),
            (Some(45), "Due in 45 minutes."),
            (Some(60), "Due in 1 hour."),
            (Some(125), "Due in 2 hours 5 minutes."),
            (Some(0), "Due now."),
            (Some(-3), "Overdue by 3 minutes."),
        ];

        for (minutes, expected) in phrases {
            let body = for_reminder(&pending(minutes, ReminderKind::MinutesBefore)).body;
            assert!(body.starts_with(expected), "{minutes:?} read as {body:?}");
        }

        // A task due on a day rather than at an hour has no countdown.
        let body = for_reminder(&pending(None, ReminderKind::AtTime)).body;
        assert!(body.starts_with("Due today."), "{body}");
    }

    #[test]
    fn a_finished_session_reports_its_length_and_its_break() {
        let notification = for_focus_session(&session(
            FocusPreset::Pomodoro50,
            50 * 60,
            Some("Finish report"),
        ));

        assert_eq!(notification.title, "✅ Focus session complete");
        assert_eq!(
            notification.body,
            "50 minutes of focus on Finish report. Take a 10-minute break."
        );
        assert_eq!(notification.task_id, Some(7));
    }

    #[test]
    fn a_session_with_no_task_and_no_break_still_reads_properly() {
        let notification = for_focus_session(&session(FocusPreset::Stopwatch, 90 * 60, None));

        assert_eq!(notification.body, "1 hour 30 minutes of focus.");

        let brief = for_focus_session(&session(FocusPreset::Custom, 30, None));
        assert_eq!(brief.body, "Under a minute of focus.");
    }

    #[test]
    fn a_break_that_ran_out_names_what_to_get_back_to() {
        let (title, body) = break_over(5, Some("Finish report"));

        assert_eq!(title, "☕ Break over");
        assert_eq!(
            body,
            "Your 5-minute break is over. Back to Finish report when you're ready."
        );
    }

    #[test]
    fn a_break_after_a_session_attached_to_nothing_still_reads_properly() {
        let (_, body) = break_over(15, None);
        assert_eq!(
            body,
            "Your 15-minute break is over. Start another session when you're ready."
        );

        // A length the frontend should never send is not worded as "0-minute".
        let (_, body) = break_over(0, None);
        assert!(body.starts_with("Your 1-minute break"), "{body}");
    }
}
