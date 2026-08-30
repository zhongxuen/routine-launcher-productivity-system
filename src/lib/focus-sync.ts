/**
 * Keeping two windows from running two clocks (development-plan.md sections
 * 34, 26).
 *
 * `window-sync.ts` solves the same problem for tasks and routines by sending
 * nothing but the word "changed" and letting each window re-read SQLite. That
 * works because the database is the whole truth about a task. It is not the
 * whole truth about a *running* focus session: `focus_sessions` records that
 * one started and how far in it was, but pausing is deliberately not written
 * there — see `focusStore.ts`, where the clock is measured against
 * `Date.now()` rather than accumulated — so a window that re-read the database
 * would find a paused session and start counting it again.
 *
 * So this one carries state:
 *
 * ```text
 * widget  ──pauseSession──▶  focusStore        (the clock stops)
 *         └─announceFocusSession(session)─▶  main window adopts it verbatim
 * ```
 *
 * What travels is the live session exactly as the window that changed it
 * holds it, and the receiving window adopts it rather than deriving anything
 * of its own. There is one clock; the window that last touched it is the one
 * that knows what it says.
 *
 * `startedAtMs` crossing a window boundary is safe because both webviews are
 * on the same machine reading the same `Date.now()`, which is the same
 * assumption the timer already makes of itself between renders.
 *
 * The request half exists because announcements are only made when something
 * *changes*. A widget opened forty minutes into a session would otherwise
 * hear nothing until it ended. Asking on mount is how it finds out, and the
 * answer is an ordinary announcement — so a window that has just restored a
 * session from the database learns that it is actually paused.
 */

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

import { WEBVIEW_ID } from "@/lib/window-sync";
import type { ActiveFocusSession } from "@/types/focus-ui";

/** A window saying what the clock now reads. Null means nothing is running. */
const FOCUS_SESSION_EVENT = "focus://session";

/** A window asking whoever holds the clock to say so. */
const FOCUS_REQUEST_EVENT = "focus://request";

interface FocusSessionPayload {
  session: ActiveFocusSession | null;
  /** Which webview sent it, so nobody adopts their own announcement. */
  source: string;
}

interface FocusRequestPayload {
  source: string;
}

/**
 * Tells the other windows what the clock now reads.
 *
 * Fire-and-forget, like `announceDataChanged`: the change it follows has
 * already happened locally, and a broadcast that fails is another window a
 * beat behind rather than a session that did not pause.
 */
export function announceFocusSession(session: ActiveFocusSession | null): void {
  const payload: FocusSessionPayload = { session, source: WEBVIEW_ID };

  void emit(FOCUS_SESSION_EVENT, payload).catch((cause) => {
    console.error("Could not tell the other windows about the focus session:", cause);
  });
}

/**
 * Subscribes to the clock changing in *another* window. Returns the
 * unsubscribe function, so it can be returned straight out of a `useEffect`.
 */
export async function onFocusSessionAnnounced(
  handler: (session: ActiveFocusSession | null) => void,
): Promise<UnlistenFn> {
  return listen<FocusSessionPayload>(FOCUS_SESSION_EVENT, (event) => {
    if (event.payload.source === WEBVIEW_ID) return;
    handler(event.payload.session);
  });
}

/** Asks whichever window holds a running session to announce it. */
export function requestFocusSession(): void {
  const payload: FocusRequestPayload = { source: WEBVIEW_ID };

  void emit(FOCUS_REQUEST_EVENT, payload).catch((cause) => {
    console.error("Could not ask the other windows about the focus session:", cause);
  });
}

/**
 * Subscribes to another window asking what is running. Answer with
 * {@link announceFocusSession}, and only if there is something to answer
 * with — an empty answer would be indistinguishable from the session having
 * just ended.
 */
export async function onFocusSessionRequested(handler: () => void): Promise<UnlistenFn> {
  return listen<FocusRequestPayload>(FOCUS_REQUEST_EVENT, (event) => {
    if (event.payload.source === WEBVIEW_ID) return;
    handler();
  });
}
