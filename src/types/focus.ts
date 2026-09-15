/**
 * Focus session types — the presets of development-plan.md section 34 and the
 * stored session of sections 35 and 61.
 *
 * {@link FocusSession} mirrors the `focus_sessions` row exactly, field name
 * for field name, so a value crossing the `invoke` boundary needs no
 * reshaping in either direction: snake_case field names, `0`/`1` integers
 * read as booleans, and UTC `YYYY-MM-DD HH:MM:SS` timestamps written by
 * SQLite. That is the same contract `src/types/task.ts` keeps.
 *
 * The preset ids below are the wire values too: `FocusPreset` in
 * `src-tauri/src/services/focus.rs` serialises to exactly these strings and
 * stores them in the `preset` column, so a preset is called the same thing in
 * the picker, in `invoke`, and in the database.
 */

/** The five session presets of section 34. */
export const FOCUS_PRESET_IDS = ["25-5", "50-10", "90-15", "custom", "stopwatch"] as const;

export type FocusPresetId = (typeof FOCUS_PRESET_IDS)[number];

/**
 * How a preset's clock behaves: counting down to a length the user chose, or
 * counting up with no end at all.
 *
 * The distinction runs through the whole timer — a stopwatch has no target,
 * so it has no progress to show and can never be stopped "early".
 */
export type FocusMode = "countdown" | "stopwatch";

export interface FocusPreset {
  id: FocusPresetId;
  /** The picker's label, written the way section 34 writes it. */
  label: string;
  mode: FocusMode;
  /**
   * The session length. Null for Stopwatch, which has none, and for Custom,
   * whose length is whatever the user typed — see the store's `customMinutes`.
   */
  focusMinutes: number | null;
  /** The break that follows, when the preset names one. */
  breakMinutes: number | null;
}

export const FOCUS_PRESETS: FocusPreset[] = [
  { id: "25-5", label: "25 / 5", mode: "countdown", focusMinutes: 25, breakMinutes: 5 },
  { id: "50-10", label: "50 / 10", mode: "countdown", focusMinutes: 50, breakMinutes: 10 },
  { id: "90-15", label: "90 / 15", mode: "countdown", focusMinutes: 90, breakMinutes: 15 },
  { id: "custom", label: "Custom", mode: "countdown", focusMinutes: null, breakMinutes: null },
  { id: "stopwatch", label: "Stopwatch", mode: "stopwatch", focusMinutes: null, breakMinutes: null },
];

export const focusPreset = (id: FocusPresetId): FocusPreset =>
  FOCUS_PRESETS.find((preset) => preset.id === id) ?? FOCUS_PRESETS[0];

/**
 * What the Custom field starts at, and the range it accepts.
 *
 * The starting length is really section 52's "Default focus duration" (see
 * `followDefaultCustomMinutes` in the focus store). This is that setting's
 * own default, so a window shows the same number before its first read of
 * the settings as after it on a fresh install.
 */
export const DEFAULT_CUSTOM_MINUTES = 50;
export const MIN_CUSTOM_MINUTES = 1;
export const MAX_CUSTOM_MINUTES = 480;

/**
 * The break beside Custom. Zero means none, and is the default: a Custom
 * length is one the user chose, not a Pomodoro, so it only gets a break when
 * they ask for one. An hour is the longest of the presets' breaks four times
 * over — anything longer is not a break.
 */
export const DEFAULT_CUSTOM_BREAK_MINUTES = 0;
export const MAX_CUSTOM_BREAK_MINUTES = 60;

/**
 * A stored session (section 61), plus the three values the backend derives
 * when it reads the row.
 *
 * `completed` and `interrupted` are stored separately rather than derived
 * from one another because section 35 asks for both, and because they are not
 * quite opposites: a session that is still running is neither.
 *
 * `elapsed_seconds`, `task_title` and `routine_name` are not columns.
 * Elapsed time is measured against SQLite's clock, so a session read back
 * after a reload already knows how far in it is; the two names come from the
 * join that reads the row, so History can label a line without a lookup per
 * row. A deleted task clears `task_id` (`ON DELETE SET NULL`) and its title
 * goes with it — the focused time stays.
 */
export interface FocusSession {
  id: number;
  task_id: number | null;
  routine_id: number | null;
  /** The preset the session was started with. */
  preset: FocusPresetId;
  /** The length it was started for, in seconds; null for a stopwatch. */
  planned_seconds: number | null;
  /** UTC `YYYY-MM-DD HH:MM:SS`. */
  started_at: string;
  /** UTC `YYYY-MM-DD HH:MM:SS`, or null while the session is still running. */
  ended_at: string | null;
  /**
   * Focused seconds, excluding time the session spent paused. Null while it
   * is still running — `elapsed_seconds` is the live count.
   */
  duration_seconds: number | null;
  /** The session ran to the end of the length it was started for. */
  completed: boolean;
  /** The session was stopped before that — section 76's "abandoned". */
  interrupted: boolean;
  /**
   * Derived: focused seconds so far. Wall-clock seconds since `started_at`
   * while the session runs, and `duration_seconds` once it has ended.
   */
  elapsed_seconds: number;
  /** Derived: the title of the task the session was attached to, if any. */
  task_title: string | null;
  /** Derived: the name of the routine it was attached to, if any. */
  routine_name: string | null;
}

/**
 * What starting a session takes (`start_focus_session`).
 *
 * `started_at` is not here: the backend stamps it the moment the row is
 * written, which is the point of calling this on Start rather than on Finish.
 * Everything else is optional — an independent 25/5 session is
 * `{ preset: "25-5" }` and nothing more.
 */
export interface NewFocusSession {
  task_id?: number | null;
  routine_id?: number | null;
  preset: FocusPresetId;
  /**
   * Required for `custom` (1 minute to 12 hours) and refused for the rest:
   * the fixed presets carry their own length and a stopwatch has none.
   */
  planned_seconds?: number | null;
}

/** How a session ended (`end_focus_session`). */
export interface FocusSessionOutcome {
  /**
   * True when the session reached its target — or a stopwatch was
   * deliberately stopped — and false when it was abandoned part-way. This is
   * the finished/interrupted distinction of section 35.
   */
  completed: boolean;
  /**
   * The focused seconds the timer measured, excluding pauses. Omit it and the
   * backend uses wall-clock time since `started_at`. A value larger than that
   * is clamped down to it, so a paused session records less than it was open
   * for but nothing can record more.
   */
  duration_seconds?: number | null;
}

/** Which sessions to list. Everything combines with AND. */
export interface FocusFilter {
  task_id?: number | null;
  routine_id?: number | null;
  /** Only sessions started on or after this local `YYYY-MM-DD` date. */
  since?: string | null;
  /** Drop the session that is still running — what History wants. */
  only_ended?: boolean;
  limit?: number | null;
}
