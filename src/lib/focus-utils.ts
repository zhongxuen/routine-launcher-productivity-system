/**
 * Clock formatting and the small arithmetic behind the focus timer.
 *
 * Presentation only, and deliberately pure: given the same elapsed count
 * these functions always answer the same thing, so the display can be tested
 * without a running timer. The one exception is {@link sqliteTimestamp},
 * which reads the clock because that is its whole job.
 *
 * Session lengths are handled in *seconds* here rather than the minutes
 * `task-utils.ts` deals in — a focus session is measured, not estimated, and
 * rounding 43m 50s down to "43 min" is a decision this module makes once
 * rather than one every caller makes differently.
 */

import type { ActiveFocusSession } from "@/types/focus-ui";
import type { FocusSession } from "@/types/focus";

/* -------------------------------------------------------------------------- */
/* Timestamps                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Now as SQLite writes it: UTC `YYYY-MM-DD HH:MM:SS`, no zone marker.
 *
 * The same shape `datetime('now')` produces, so a session started in the
 * frontend and one started in Rust are indistinguishable in the table — which
 * matters because Prompt 4.1 persists `started_at` from whichever side got
 * there first. `parseTimestamp` in `task-utils.ts` reads these back.
 */
export function sqliteTimestamp(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/* -------------------------------------------------------------------------- */
/* The clock face                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `1499` becomes `"24:59"`, `3725` becomes `"1:02:05"`.
 *
 * Hours appear only once there are any, so a 25-minute session is not padded
 * out to `0:24:59` for the sake of a 90-minute one. Negative counts are
 * clamped: a countdown that overshoots between ticks shows `0:00`, never
 * `-0:01`.
 */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return hours > 0
    ? `${hours}:${mm}:${String(rest).padStart(2, "0")}`
    : `${mm}:${String(rest).padStart(2, "0")}`;
}

/**
 * How long a finished session ran, in words: `"43 min"`, `"1h 30m"`.
 *
 * Anything under a minute is `"< 1 min"` rather than `"0 min"`. Section 88 is
 * the reason: a session that lasted twenty seconds is not zero focus, and
 * saying so keeps the History list from looking like it lost something.
 */
export function formatFocusLength(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "—";
  if (seconds < 60) return "< 1 min";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** The length a session is *for*, for the line under the clock. */
export function formatTargetLength(minutes: number): string {
  if (minutes < 60) return `${minutes} minute`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hour` : `${hours}h ${rest}m`;
}

/* -------------------------------------------------------------------------- */
/* Where a running session is up to                                           */
/* -------------------------------------------------------------------------- */

/**
 * The number on the clock: seconds left for a countdown, seconds done for a
 * stopwatch.
 *
 * One function rather than two because everything downstream — the display,
 * the document title, the tray label later — wants "the number", and which
 * direction it counts is the session's business, not theirs.
 */
export function displaySeconds(session: ActiveFocusSession): number {
  if (session.targetSeconds === null) return session.elapsedSeconds;
  return Math.max(0, session.targetSeconds - session.elapsedSeconds);
}

/** How far through a countdown, 0-100. Always 0 for a stopwatch, which has no end. */
export function progressPercent(session: ActiveFocusSession): number {
  if (!session.targetSeconds) return 0;
  const fraction = session.elapsedSeconds / session.targetSeconds;
  return Math.min(100, Math.max(0, Math.round(fraction * 100)));
}

/**
 * Whether the session has run the length it was started for.
 *
 * A stopwatch has no length to reach, so it is never "reached" — which is
 * also why finishing one is never an interruption. See `finishSession`.
 */
export function hasReachedTarget(session: ActiveFocusSession): boolean {
  return session.targetSeconds !== null && session.elapsedSeconds >= session.targetSeconds;
}

/* -------------------------------------------------------------------------- */
/* Finished sessions                                                          */
/* -------------------------------------------------------------------------- */

export type FocusOutcome = "completed" | "interrupted";

/**
 * Section 35's two outcomes, read off the row.
 *
 * `completed` is the flag that decides; `interrupted` is checked only so a
 * row that somehow carries neither is called interrupted rather than
 * silently promoted to a completed session it never was.
 */
export const sessionOutcome = (session: FocusSession): FocusOutcome =>
  session.completed && !session.interrupted ? "completed" : "interrupted";

/** How each outcome is written in History and in the completion card. */
export const FOCUS_OUTCOME_LABELS: Record<FocusOutcome, string> = {
  completed: "Completed",
  interrupted: "Interrupted",
};

/** Text colour per outcome — the same tokens the task statuses use. */
export const FOCUS_OUTCOME_COLOR: Record<FocusOutcome, string> = {
  completed: "text-status-completed",
  interrupted: "text-muted-foreground",
};

/** Newest first, by start time. The order History lists sessions in. */
export const sortSessionsByRecency = (sessions: FocusSession[]): FocusSession[] =>
  [...sessions].sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id - a.id);
