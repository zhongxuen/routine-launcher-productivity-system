/**
 * The running session, as the timer UI needs it.
 *
 * Kept apart from `src/types/focus.ts` for the same reason `routine-ui.ts` is
 * kept apart from `routine.ts`: this is a live thing on screen, not a row.
 * Field names are camelCase because nothing here crosses the `invoke`
 * boundary — only the finished session does, and that is a {@link
 * import("./focus").FocusSession}.
 *
 * Elapsed time is measured from `startedAtMs` against the clock, never
 * accumulated a tick at a time. That is what makes the timer survive being
 * navigated away from, throttled by a background tab, or slept through: the
 * interval only decides how often the display is refreshed, not what it says.
 */

import type { FocusMode, FocusPresetId } from "./focus";

/** Running, or paused and waiting to be resumed. A finished session is a row. */
export type FocusStatus = "running" | "paused";

export interface ActiveFocusSession {
  /**
   * The `focus_sessions` row this session is being written to.
   *
   * Never absent: the clock is only started once `start_focus_session` has
   * answered, so a session on screen is always a session on record — and
   * ending one is always an update to a row that exists rather than an insert
   * that might still fail.
   */
  id: number;

  presetId: FocusPresetId;
  mode: FocusMode;
  /** The length being counted down to, or null for a stopwatch. */
  targetSeconds: number | null;
  /** The break the preset suggests afterwards, if it named one. */
  breakMinutes: number | null;

  /** UTC `YYYY-MM-DD HH:MM:SS` — the value the row is started with. */
  startedAt: string;
  /** Epoch milliseconds of the same instant, which elapsed time is measured against. */
  startedAtMs: number;

  status: FocusStatus;
  /** Whole seconds focused so far, excluding time spent paused. */
  elapsedSeconds: number;
  /** Total milliseconds already spent paused. */
  pausedMs: number;
  /** Epoch milliseconds the current pause began, or null while running. */
  pausedAtMs: number | null;

  /** What the session is attached to (section 34), or nulls when it stands alone. */
  taskId: number | null;
  taskTitle: string | null;
  routineId: number | null;
  routineName: string | null;
}

/**
 * What a session can be started with.
 *
 * Every field is optional because the Focus page starts sessions that are
 * attached to nothing. What fills them in is section 19's two ways of
 * starting one from a task: the row's Start Focus button, and the focus
 * intent a routine launch emits — both of which end up in `startFocusFor`
 * (`src/hooks/useStartFocus.ts`), which passes them straight through.
 */
export interface StartFocusOptions {
  /** Overrides the picked preset — a task's estimate arrives as minutes, not a preset. */
  minutes?: number | null;
  taskId?: number | null;
  taskTitle?: string | null;
  routineId?: number | null;
  routineName?: string | null;
}
