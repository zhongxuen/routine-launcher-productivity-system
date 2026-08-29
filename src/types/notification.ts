/**
 * Reminder and notification types.
 *
 * These mirror the Rust payloads in `src-tauri/src/services/reminders.rs` and
 * `src-tauri/src/services/notifications.rs` exactly, field name for field
 * name, so a value crossing the `invoke` boundary needs no reshaping in
 * either direction. Field names stay snake_case to match the columns added in
 * `database/migrations/0004_task_reminders.sql`.
 *
 * Dates are `YYYY-MM-DD` and times are 24-hour `HH:MM` on the user's local
 * clock — a reminder set for `"17:00"` means 5pm where the user is. The two
 * delivery timestamps (`snoozed_until`, `fired_at`) are UTC
 * `YYYY-MM-DD HH:MM:SS` strings written by SQLite, so pass them through
 * `parseTimestamp` from `@/lib/task-utils` before showing them.
 */

/** Section 24's two forms of reminder. */
export const REMINDER_KINDS = ["minutes_before", "at_time"] as const;

export type ReminderKind = (typeof REMINDER_KINDS)[number];

/**
 * A task's reminder as stored: what was configured, plus how far its delivery
 * has got.
 *
 * The delivery fields are not something to set — `snooze` and `dismiss` write
 * them, and configuring a reminder clears them — but they are worth reading:
 * `snoozed_until` in the future is a reminder that has been put off, and a
 * `fired_at` is a reminder that has already been given.
 */
export interface TaskReminder {
  kind: ReminderKind;
  /** Lead time for `minutes_before`; null for an `at_time` reminder. */
  minutes_before: number | null;
  /** Local 24-hour `HH:MM` for `at_time`; null for `minutes_before`. */
  at_time: string | null;
  /** UTC timestamp a snoozed reminder comes back at, or null. */
  snoozed_until: string | null;
  /** UTC timestamp of the last notification sent, or null if never. */
  fired_at: string | null;
}

/**
 * What to send when configuring a reminder. `kind` decides which of the other
 * two matters; the one it does not is ignored and stored as null, so
 * switching a reminder between the two forms never leaves the old value
 * behind.
 *
 * The backend rejects a reminder the task cannot support — both forms need a
 * due date, and `minutes_before` also needs a due *time* to count back from —
 * so save the task's dates before its reminder.
 */
export interface ReminderInput {
  kind: ReminderKind;
  /** Required for `minutes_before`. From 1 minute to a week. */
  minutes_before?: number | null;
  /** Required for `at_time`. Local 24-hour `HH:MM`. */
  at_time?: string | null;
}

/** One task's reminder, as listed by `listTaskReminders`. */
export interface TaskReminderEntry {
  task_id: number;
  task_title: string;
  reminder: TaskReminder;
}

/**
 * Section 24's three buttons. Which of them a reminder offers travels with
 * the reminder rather than being assumed here, so the notification and
 * whatever draws it always agree.
 */
export const REMINDER_ACTIONS = ["start_task", "snooze", "dismiss"] as const;

export type ReminderAction = (typeof REMINDER_ACTIONS)[number];

export const REMINDER_ACTION_LABELS: Record<ReminderAction, string> = {
  start_task: "Start Task",
  snooze: "Snooze",
  dismiss: "Dismiss",
};

/**
 * A reminder that has just been delivered — the payload of the
 * `notification://reminder-fired` event, and the same one the OS notification
 * was built from.
 *
 * This is the click-through half of section 24. No desktop platform can put
 * Start Task / Snooze / Dismiss on the toast itself (see
 * `src-tauri/src/services/notifications.rs` for exactly why), so
 * `native_actions` is false and the app is where those buttons live: subscribe
 * with `onReminderFired` and raise them from `actions`.
 */
export interface ReminderNotification {
  task_id: number;
  task_title: string;
  /** The routine the task starts with (section 18), or null. */
  routine_id: number | null;
  /** What the OS notification's heading says. */
  title: string;
  /** What its body says, countdown and all. */
  body: string;
  /**
   * The countdown on its own — "Due in 10 minutes." — without the line `body`
   * adds telling the user where the buttons are.
   *
   * This is the one to render inside the app: `body` ends with "Open Routine
   * Launcher to start, snooze or dismiss", which is nonsense next to the
   * buttons themselves. Worded by the backend rather than derived here from
   * `minutes_until_due`, so the toast and the in-app prompt can never
   * describe the same reminder differently.
   */
  due_phrase: string;
  /** Which of section 24's buttons this reminder offers. */
  actions: ReminderAction[];
  /** False when those buttons are the app's to draw rather than the OS's. */
  native_actions: boolean;
  /** The snooze length to offer when the user does not choose one. */
  snooze_minutes: number;
  /** True when this is a snooze coming back rather than a first delivery. */
  snoozed: boolean;
  due_date: string;
  due_time: string | null;
  /**
   * Minutes until the task is due, measured when the notification was built:
   * negative once it is late, null when the task has no due time.
   */
  minutes_until_due: number | null;
}

/** What the backend can and cannot do with notifications on this machine. */
export interface NotificationCapabilities {
  /** Whether the OS will show what we send it. */
  permission_granted: boolean;
  /**
   * Whether the OS notification can carry section 24's buttons itself. False
   * on every desktop platform today — when it is false the app has to offer
   * them, which is what `onReminderFired` is for.
   */
  native_action_buttons: boolean;
  /** The snooze length used when none is given. */
  default_snooze_minutes: number;
  /**
   * How often reminders are checked, in seconds. A reminder can therefore be
   * up to this late — worth knowing before promising a user "at 5:00 PM"
   * means 5:00:00 PM.
   */
  poll_seconds: number;
}

/**
 * The lead times to offer in a reminder picker. Section 24's example is "10
 * minutes before"; the rest are the round numbers either side of it.
 *
 * A picker is not limited to these — the backend takes any lead from one
 * minute to a week — they are just the ones worth one click.
 */
export const REMINDER_LEAD_TIMES = [5, 10, 15, 30, 60, 120, 1440] as const;
