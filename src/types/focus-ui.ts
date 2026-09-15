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
  /**
   * The break that follows a completed session: the preset's own, or the
   * length set beside Custom. Null when there is none.
   */
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
  /**
   * What the session is for when that is not a task — `"Planning"` for Start
   * My Day's session (section 21). Held here and sent to the other windows,
   * never stored, so a session picked back up after a reload comes back as the
   * routine's session without it.
   */
  label: string | null;
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
  /**
   * The preset to start, when the caller knows it rather than a length.
   *
   * Only the session after a break passes it: a Custom 25 minutes is still
   * Custom the second time round, where `minutes` alone would read it as the
   * 25/5 preset.
   */
  presetId?: FocusPresetId;
  /**
   * The break to follow the session, when the caller knows it. Absent means
   * whatever the preset, or the Custom break field, says.
   */
  breakMinutes?: number | null;
  taskId?: number | null;
  taskTitle?: string | null;
  routineId?: number | null;
  routineName?: string | null;
  /** See {@link ActiveFocusSession.label}. */
  label?: string | null;
}

/**
 * Counting down the break, or finished counting and waiting to be dismissed.
 *
 * There is no paused state. A break is time off the clock by definition, and
 * pausing one would be a way of saying "not yet" that Skip and End early
 * already say better.
 */
export type FocusBreakStatus = "running" | "over";

/**
 * The break after a completed session (section 34's 5 of 25/5).
 *
 * Deliberately not a session. It has no row, earns no XP, and is in no
 * statistic, history or streak (sections 35, 36, 88) — it lives in
 * `focusStore` and nowhere else, which is also why closing the app during
 * one loses it. The other windows hear about it through
 * `src/lib/focus-sync.ts`, the same way they hear about a paused clock.
 */
export interface FocusBreak {
  /**
   * Which break this is, across windows. Every window counts the break down
   * and every one reaches its end, so the notification is sent against this
   * id and only the first window to ask gets to send it.
   */
  id: string;
  minutes: number;
  /** Epoch milliseconds the break began and runs out at. */
  startedAtMs: number;
  endsAtMs: number;
  /** Whole seconds left, recomputed from `endsAtMs` on every tick. */
  remainingSeconds: number;
  status: FocusBreakStatus;
  /** True when the user ended it rather than the clock. Only `over` can be. */
  endedEarly: boolean;
  /**
   * The session the break followed, as a start request: same preset, same
   * length, same task and routine. What Skip and "Start another session"
   * start.
   */
  next: StartFocusOptions;
}
