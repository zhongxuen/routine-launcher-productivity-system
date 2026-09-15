/**
 * Typed wrappers around the reminder and notification Tauri commands
 * (development-plan.md sections 24 and 78).
 *
 * This is the "Service" layer of React UI -> Service -> Tauri Command ->
 * Rust -> SQLite (section 86): components import from here and never call
 * `invoke` themselves.
 *
 * What is *not* here is the sending. A reminder is fired by a background
 * thread in Rust, on its own clock, whether or not the app is open — which is
 * the entire point of section 24, and why this file only configures reminders
 * and reacts to them. `startFocusSession`'s counterpart is the same story:
 * the focus-completion notification goes out when the session is written, so
 * `focusService.endFocusSession` already produces it and nothing here has to.
 *
 * ## The buttons
 *
 * Section 24 puts Start Task / Snooze / Dismiss on the notification itself.
 * No desktop platform can draw them with the plugin this app uses (the
 * reasons are set out in `src-tauri/src/services/notifications.rs`), so the
 * app draws them instead:
 *
 * ```ts
 * useEffect(() => {
 *   const unlisten = onReminderFired((reminder) => showReminderPrompt(reminder));
 *   return () => { void unlisten.then((stop) => stop()); };
 * }, []);
 * ```
 *
 * {@link snoozeTaskReminder} and {@link dismissTaskReminder} are what those
 * buttons call, wherever they end up being drawn.
 *
 * Every command rejects with a plain, user-presentable string on failure (a
 * reminder on a task with no due date, a lead time of zero, a snooze on a
 * reminder that has since been removed, ...), so callers can surface
 * `String(error)` straight to a toast.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { formatDueTime } from "@/lib/task-utils";
import type {
  NotificationCapabilities,
  ReminderInput,
  ReminderNotification,
  TaskReminder,
  TaskReminderEntry,
} from "@/types/notification";
import type { Task } from "@/types/task";

/** Emitted by the backend for every reminder it delivers. */
const REMINDER_FIRED_EVENT = "notification://reminder-fired";

// ---------------------------------------------------------------------------
// Configuring a reminder
// ---------------------------------------------------------------------------

/**
 * Sets or replaces a task's reminder and returns the task as stored, with
 * `task.reminder` filled in — so the result can go straight back into a list.
 *
 * Rejects when the task cannot carry the reminder: both forms need a due
 * date, and `minutes_before` needs a due time to count back from. Save the
 * task's dates first if the same dialog is changing both.
 *
 * Setting a reminder always clears where its delivery had got to, so a
 * reminder that has already been given — or snoozed, or dismissed — starts
 * fresh the moment it is changed.
 */
export async function setTaskReminder(
  taskId: number,
  reminder: ReminderInput,
): Promise<Task> {
  return invoke<Task>("set_task_reminder", { taskId, reminder });
}

/**
 * Removes a task's reminder. The task itself is untouched — this is "stop
 * reminding me", not "this is done".
 */
export async function clearTaskReminder(taskId: number): Promise<Task> {
  return invoke<Task>("set_task_reminder", { taskId, reminder: null });
}

/** The task's reminder, or `null` if it has none. */
export async function getTaskReminder(
  taskId: number,
): Promise<TaskReminder | null> {
  return invoke<TaskReminder | null>("get_task_reminder", { taskId });
}

/**
 * Every reminder set on a task that is still open, in due order.
 *
 * One call for the lot, so a task list can mark the rows that have a reminder
 * without a query per row. Tasks carry their own reminder as well
 * (`task.reminder`), so this is only needed where the tasks themselves are
 * not to hand.
 */
export async function listTaskReminders(): Promise<TaskReminderEntry[]> {
  return invoke<TaskReminderEntry[]>("list_task_reminders");
}

// ---------------------------------------------------------------------------
// Acting on one
// ---------------------------------------------------------------------------

/**
 * Section 24's Snooze: put the reminder back for `minutes` — defaulting to
 * the backend's ten — and let it come round once more.
 *
 * The reminder keeps its configuration and the task is not touched, so a
 * snoozed "10 minutes before" reminder is still a "10 minutes before"
 * reminder tomorrow.
 */
export async function snoozeTaskReminder(
  taskId: number,
  minutes?: number,
): Promise<Task> {
  return invoke<Task>("snooze_task_reminder", {
    taskId,
    minutes: minutes ?? null,
  });
}

/**
 * Section 24's Dismiss: silence this reminder without deleting it and without
 * touching the task — dismissing a notification is not doing the work, and
 * not cancelling it either.
 *
 * The reminder stays configured: moving the task's due date forward will
 * remind about it again.
 */
export async function dismissTaskReminder(taskId: number): Promise<Task> {
  return invoke<Task>("dismiss_task_reminder", { taskId });
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Subscribes to reminders as they are delivered, and resolves to the
 * unsubscribe function.
 *
 * This is how the app offers section 24's three buttons on a platform whose
 * notifications cannot carry them. It fires for every reminder the backend
 * sends, including ones sent while the window was closed and ones a
 * {@link checkTaskReminders} call produced.
 */
export async function onReminderFired(
  handler: (reminder: ReminderNotification) => void,
): Promise<UnlistenFn> {
  return listen<ReminderNotification>(REMINDER_FIRED_EVENT, (event) =>
    handler(event.payload),
  );
}

/**
 * Checks for reminders that have come due right now, and answers with the
 * ones it sent.
 *
 * The backend does this on its own every half minute, so this is only for the
 * moments where waiting would look broken: the app coming back to the
 * foreground, or a reminder just configured for a time that has already
 * passed.
 */
export async function checkTaskReminders(): Promise<ReminderNotification[]> {
  return invoke<ReminderNotification[]>("check_task_reminders");
}

/**
 * What notifications can do on this machine — whether the OS will show them,
 * whether it can draw the reminder's buttons, and how late a reminder may be.
 */
export async function getNotificationCapabilities(): Promise<NotificationCapabilities> {
  return invoke<NotificationCapabilities>("notification_capabilities");
}

/**
 * Sends one notification now, so a user whose OS is quietly swallowing them
 * finds out from a button they pressed rather than from a reminder that never
 * arrived.
 */
export async function sendTestNotification(): Promise<void> {
  return invoke<void>("send_test_notification");
}

/**
 * Sends the "break over" notification for a focus break (section 34), and
 * answers whether this window was the one that sent it.
 *
 * Every window running the focus store reaches the end of the same break, and
 * every one calls this; the backend shows the notification for the first call
 * per `breakId` and answers false to the rest. The answer is what lets the
 * caller play the sound once rather than once per window.
 *
 * `backTo` is the task or routine the next session is for, so the
 * notification can say what the user is getting back to.
 */
export async function announceBreakOver(
  breakId: string,
  minutes: number,
  backTo: string | null,
): Promise<boolean> {
  return invoke<boolean>("announce_break_over", { breakId, minutes, backTo });
}

// ---------------------------------------------------------------------------
// Building and describing a reminder
// ---------------------------------------------------------------------------

/** Section 24's "10 minutes before". */
export function minutesBeforeReminder(minutes: number): ReminderInput {
  return { kind: "minutes_before", minutes_before: minutes, at_time: null };
}

/** Section 24's "At 5:00 PM", from a local 24-hour `HH:MM`. */
export function atTimeReminder(time: string): ReminderInput {
  return { kind: "at_time", minutes_before: null, at_time: time };
}

/**
 * A lead time in words: `"10 minutes before"`, `"1 hour before"`,
 * `"1 day before"`.
 */
export function formatLeadTime(minutes: number): string {
  if (minutes % 1440 === 0) return `${plural(minutes / 1440, "day")} before`;
  if (minutes % 60 === 0) return `${plural(minutes / 60, "hour")} before`;
  return `${plural(minutes, "minute")} before`;
}

/**
 * A reminder in words, for a task row or an edit dialog: `"10 minutes
 * before"` or `"At 5:00 PM"`. Returns null for a task with no reminder, so it
 * can be dropped straight into a conditional.
 */
export function describeReminder(
  reminder: TaskReminder | null | undefined,
): string | null {
  if (!reminder) return null;

  if (reminder.kind === "minutes_before") {
    return reminder.minutes_before === null
      ? null
      : formatLeadTime(reminder.minutes_before);
  }

  const time = formatDueTime(reminder.at_time);
  return time === null ? null : `At ${time}`;
}

/**
 * Whether a reminder is currently snoozed — its return is in the future.
 *
 * A snooze that has already come round is not a snooze any more; it is a
 * reminder that has been given, which is why this compares rather than just
 * testing for a value.
 */
export function isSnoozed(reminder: TaskReminder | null | undefined): boolean {
  if (!reminder?.snoozed_until) return false;
  return new Date(`${reminder.snoozed_until.replace(" ", "T")}Z`) > new Date();
}

function plural(count: number, noun: string): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}
