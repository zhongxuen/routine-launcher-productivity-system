/**
 * What happens after a reminder has fired, across two windows.
 *
 * `notification://reminder-fired` (see `src/services/notificationService.ts`)
 * is broadcast by Rust to *every* webview, because either of them might be
 * the one the user can see: the main window may be buried behind three other
 * applications while the always-on-top popup of section 25 sits in the
 * corner. So both raise section 24's Start Task / Snooze / Dismiss, and this
 * module is what keeps two prompts for one reminder from behaving like two
 * reminders.
 *
 * Two announcements, and they point in opposite directions:
 *
 * ```text
 * popup ──handOffReminder──▶ main window   "you take this one"
 * main  ──reminderHandled──▶ popup         "this one is dealt with"
 * ```
 *
 * **Handled** is the cheap half: whichever window ran Snooze or Dismiss says
 * so, and the other closes its copy of the prompt rather than leaving a
 * button that would fail — the reminder has already been marked delivered,
 * and `snooze`/`dismiss` on a reminder that is no longer owed is a write
 * nobody asked for.
 *
 * **Hand-off** is the one that carries real work. Start Task means section
 * 18's START TASK — launch the workspace, start the session — and neither
 * half of that exists in the popup: `RoutineLaunchDialog` (section 32's
 * checklist) and `useFocusLifecycle` are mounted by the app shell, and a
 * session started from a 340px window would be a clock in a window with no
 * clock. So the popup does not try; it asks the main window, which is where
 * the user is being sent anyway.
 *
 * Both go through Tauri's event bus rather than a `Set` of handlers, for the
 * same reason `window-sync.ts` does: the two ends are in different webviews.
 * They share that module's `WEBVIEW_ID` so a window never answers its own
 * broadcast.
 */

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import { WEBVIEW_ID } from "@/lib/window-sync";
import type { ReminderAction } from "@/types/notification";

/** "This reminder has been dealt with — stop offering it." */
const REMINDER_HANDLED_EVENT = "app://reminder-handled";

/** "Start this task in the full app." */
const REMINDER_HANDOFF_EVENT = "app://reminder-start-task";

interface HandledPayload {
  taskId: number;
  action: ReminderAction;
  source: string;
}

interface HandoffPayload {
  taskId: number;
  source: string;
}

/**
 * Tells the other windows that this reminder has been acted on, so they can
 * drop their copy of the prompt.
 *
 * Fire-and-forget, like `announceDataChanged`: the write it follows has
 * already landed, and a broadcast that fails leaves a stale prompt in another
 * window rather than an unrecorded action. It must never be the reason
 * Snooze or Dismiss reports failure.
 */
export function announceReminderHandled(
  taskId: number,
  action: ReminderAction,
): void {
  const payload: HandledPayload = { taskId, action, source: WEBVIEW_ID };

  void emit(REMINDER_HANDLED_EVENT, payload).catch((cause) => {
    console.error("Could not tell the other windows about a reminder:", cause);
  });
}

/**
 * Subscribes to reminders acted on in *other* windows. Returns the
 * unsubscribe function, so it can be returned straight out of a `useEffect`.
 */
export async function onReminderHandled(
  handler: (taskId: number, action: ReminderAction) => void,
): Promise<UnlistenFn> {
  return listen<HandledPayload>(REMINDER_HANDLED_EVENT, (event) => {
    if (event.payload.source === WEBVIEW_ID) return;
    handler(event.payload.taskId, event.payload.action);
  });
}

/**
 * Asks the full app to start this task — the popup's Start Task.
 *
 * Nothing comes back. The main window brings itself forward and reports there,
 * which is where the user is by the time anything can go wrong; a popup that
 * waited on the answer would be a window sitting over the workspace it just
 * asked for.
 */
export function handOffReminderToApp(taskId: number): void {
  const payload: HandoffPayload = { taskId, source: WEBVIEW_ID };

  void emit(REMINDER_HANDOFF_EVENT, payload).catch((cause) => {
    console.error("Could not hand the task over to the app:", cause);
  });
}

/**
 * Subscribes to tasks handed over by another window. Only the app shell
 * listens — it is the window that can actually start one.
 */
export async function onReminderHandedOff(
  handler: (taskId: number) => void,
): Promise<UnlistenFn> {
  return listen<HandoffPayload>(REMINDER_HANDOFF_EVENT, (event) => {
    if (event.payload.source === WEBVIEW_ID) return;
    handler(event.payload.taskId);
  });
}
