/**
 * The "start a focus session for this task" intent — the joint between
 * section 18's START TASK and section 19's focus session.
 *
 * Starting a task launches its routine and then emits one `FocusIntent`
 * describing the session that should follow: which task, which routine, and
 * how long. `useFocusLifecycle` is what listens —
 *
 *     useEffect(() => onFocusIntent((intent) => startFocusFor(intent)), []);
 *
 * — so section 18's "Focus timer: 50:00" is a clock that starts the moment
 * the workspace is open, not a length the panel is only promising. Routing it
 * through a function rather than having the task row reach into the timer is
 * what keeps that true of every caller: the row, the dashboard's "Start My
 * Day", the tray popup later, all say the same thing and none of them know
 * how a session is started.
 *
 * This is deliberately a plain subscription rather than a store: an intent is
 * an event, not a piece of state, and re-rendering something because a timer
 * was *asked for* is not useful. `src/lib/focus-events.ts` is the same idea
 * pointing the other way, for when the session it asked for has ended. The
 * routine half of it already works this way too — `routine://timer-requested`,
 * see `routineService.ts` — except that one originates in Rust, because a
 * routine's timer action is a backend fact. A task's estimate is not: it is
 * read straight off the task the user clicked, so this side stays in the
 * frontend.
 */

/**
 * What a focus session started from a launch should be sized and labelled by.
 *
 * Usually a task's (section 18's START TASK). Start My Day's is the one
 * without a task: section 21's "Start 10-minute planning session" is attached
 * to the start-of-day routine and carries a {@link label} instead.
 */
export interface FocusIntent {
  taskId: number | null;
  /** The task's title, for the timer's "Task: ..." line (section 18). */
  taskTitle: string | null;
  /**
   * What the session is for when it is not a task — `"Planning"` for Start My
   * Day. Drawn on the clock and never stored: `focus_sessions` has no column
   * for it, so the recorded session is simply one against the routine.
   */
  label: string | null;
  /**
   * The break after the session, when the caller decides it. Absent means
   * whatever the preset says; Start My Day passes null, because ten minutes of
   * planning is a warm-up and not the first half of a pomodoro.
   */
  breakMinutes?: number | null;
  /**
   * How long the session should run, in minutes, or null when nothing named a
   * length — see {@link focusMinutesFor}. A null is "the user picks", not
   * "zero minutes": section 88 would rather show nothing than invent a figure,
   * which is why a null intent starts no session at all rather than falling
   * back to whatever preset the Focus page happens to be on.
   */
  minutes: number | null;
  /** The routine that was launched with the task, if it had one. */
  routineId: number | null;
  routineName: string | null;
}

type FocusIntentHandler = (intent: FocusIntent) => void;

const handlers = new Set<FocusIntentHandler>();

/**
 * Subscribes to focus intents. Returns the unsubscribe function, so it can be
 * returned straight out of a `useEffect`.
 */
export function onFocusIntent(handler: FocusIntentHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Emits one intent to every subscriber.
 *
 * A throwing subscriber is logged and skipped rather than allowed to stop the
 * others: the workspace has already opened by this point, and one broken
 * listener should not be what decides whether the rest hear about it.
 */
export function requestFocus(intent: FocusIntent): void {
  for (const handler of handlers) {
    try {
      handler(intent);
    } catch (cause) {
      console.error("A focus-intent subscriber threw:", cause);
    }
  }
}

/**
 * How long a task's focus session should be: the task's own estimate, and
 * failing that whatever timer its routine already carries.
 *
 * The task wins because it is the more specific answer — section 18's example
 * shows a 50:00 timer against "Finish React project", and section 19 sizes a
 * session from "Estimated: 45 minutes". The routine's timer action is the
 * fallback rather than the other way round: a workspace that always opens a
 * 50-minute timer should not overrule a task the user said would take 15.
 *
 * Null when neither names one, which the UI renders as no timer line at all.
 */
export function focusMinutesFor(
  estimatedMinutes: number | null,
  routineTimerMinutes: number | null,
): number | null {
  return estimatedMinutes ?? routineTimerMinutes;
}

/** `50` becomes `"50:00"` — the clock face in section 18's example. */
export function formatFocusClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0
    ? `${hours}:${String(rest).padStart(2, "0")}:00`
    : `${minutes}:00`;
}
