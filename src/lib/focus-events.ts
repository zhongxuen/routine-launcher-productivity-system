/**
 * The return half of section 19's chain: a focus session has ended, and the
 * task it was against is now worth re-reading.
 *
 * ```text
 * Task  ──requestFocus──▶  Focus Session  ──focusSessionEnded──▶  Completion
 * ```
 *
 * `focus-intent.ts` carries the outbound half — a task asking for a session.
 * This is the answer coming back, and it is a separate module for the same
 * reason that one is: an ended session is an event, not a piece of state, and
 * the two ends of the chain have different subscribers.
 *
 * It also keeps the stores from having to know about each other. A task's
 * `focus_seconds` is summed by the backend from the sessions that named it
 * (see `src-tauri/src/services/tasks.rs`), so the number changes the moment a
 * session is written — but nothing would go and *read* it again. Rather than
 * have `focusStore` reach into `taskStore` to refresh a list it knows nothing
 * about, it says what happened and the app shell decides who cares. Today
 * that is the task list; Stage 7's completion notification is the next one.
 *
 * Emitted only for sessions that were really recorded — `finishSession` fires
 * it after `end_focus_session` answers, never for the local record it shows
 * while that write is in flight. A subscriber can therefore trust that
 * re-reading the database will see this session's minutes.
 */

import type { FocusSession } from "@/types/focus";

type FocusSessionEndedHandler = (session: FocusSession) => void;

const handlers = new Set<FocusSessionEndedHandler>();

/**
 * Subscribes to sessions ending. Returns the unsubscribe function, so it can
 * be returned straight out of a `useEffect`.
 */
export function onFocusSessionEnded(handler: FocusSessionEndedHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Announces one recorded session to every subscriber.
 *
 * A throwing subscriber is logged and skipped rather than allowed to stop the
 * others: the session is already on record by this point, and one broken
 * listener should not be what decides whether the rest hear about it.
 */
export function emitFocusSessionEnded(session: FocusSession): void {
  for (const handler of handlers) {
    try {
      handler(session);
    } catch (cause) {
      console.error("A focus-session subscriber threw:", cause);
    }
  }
}
