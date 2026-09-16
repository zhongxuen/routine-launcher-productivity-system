/**
 * The one thing the quick launcher cannot finish on its own
 * (development-plan.md section 28).
 *
 * The launcher does its other work where it stands: it filters routines and
 * launches them through the same `launch_routine` command everything else
 * uses, and it adds a task through the same `create_task`. Both are database
 * operations, and the database is the shared state, so a second webview doing
 * them is no different from the first one doing them.
 *
 * `⏱ Start Focus` is not like that. A focus session is a *clock*, and the
 * clock lives in the main window's `focusStore` — see the "where the clock
 * ends and the record begins" note in that file. A row written from this
 * window would be a session nobody is watching: the timer the user asked for
 * would exist in SQLite and appear on screen only when the main window next
 * happened to restore it.
 *
 * So the launcher asks, and the main window starts it and shows it. Which is
 * also the right thing on its own terms — someone who pressed Start Focus
 * wants to see the clock, so bringing the app forward is the answer rather
 * than the cost.
 *
 * The same shape as `src/lib/window-sync.ts`, and for the same reason: an
 * announcement across a process-level boundary, so it goes through Tauri's
 * event bus rather than a `Set` of handlers. Nothing but the request travels.
 */

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import { WEBVIEW_ID } from "./window-sync";

const START_FOCUS_EVENT = "launcher://start-focus";

/**
 * Section 21's Start My Day, asked for the same way and for the same reason:
 * its dialog, the launch panel it hands over to and the planning session's
 * clock are all the main window's.
 */
const START_MY_DAY_EVENT = "launcher://start-my-day";

/** Section 22's end-of-day review, for the same reason as Start My Day. */
const REVIEW_MY_DAY_EVENT = "launcher://review-my-day";

interface LauncherRequest {
  /** Which webview asked, so nobody answers their own request. */
  source: string;
}

/**
 * Asks the main window for a focus session.
 *
 * Fire-and-forget, and deliberately so: the launcher hides itself either way,
 * and there is nothing it could usefully do about a broadcast that failed
 * except keep an overlay on screen over an app that is not listening.
 */
export function requestFocusSession(): void {
  const payload: LauncherRequest = { source: WEBVIEW_ID };

  void emit(START_FOCUS_EVENT, payload).catch((cause) => {
    console.error("Could not ask the app for a focus session:", cause);
  });
}

/**
 * Subscribes to focus sessions requested from *another* window. Returns the
 * unsubscribe function, so it can be returned straight out of a `useEffect`.
 */
export async function onFocusSessionRequested(handler: () => void): Promise<UnlistenFn> {
  return listen<LauncherRequest>(START_FOCUS_EVENT, (event) => {
    if (event.payload.source === WEBVIEW_ID) return;
    handler();
  });
}

/** Asks the main window to open Start My Day. Fire-and-forget, as above. */
export function requestStartMyDay(): void {
  const payload: LauncherRequest = { source: WEBVIEW_ID };

  void emit(START_MY_DAY_EVENT, payload).catch((cause) => {
    console.error("Could not ask the app to open Start My Day:", cause);
  });
}

/** Subscribes to Start My Day requested from *another* window. */
export async function onStartMyDayRequested(handler: () => void): Promise<UnlistenFn> {
  return listen<LauncherRequest>(START_MY_DAY_EVENT, (event) => {
    if (event.payload.source === WEBVIEW_ID) return;
    handler();
  });
}

/** Asks the main window to open the end-of-day review. Fire-and-forget, as above. */
export function requestReviewMyDay(): void {
  const payload: LauncherRequest = { source: WEBVIEW_ID };

  void emit(REVIEW_MY_DAY_EVENT, payload).catch((cause) => {
    console.error("Could not ask the app to open the day's review:", cause);
  });
}

/** Subscribes to the end-of-day review requested from *another* window. */
export async function onReviewMyDayRequested(handler: () => void): Promise<UnlistenFn> {
  return listen<LauncherRequest>(REVIEW_MY_DAY_EVENT, (event) => {
    if (event.payload.source === WEBVIEW_ID) return;
    handler();
  });
}
