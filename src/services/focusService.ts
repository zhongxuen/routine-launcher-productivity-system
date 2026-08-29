/**
 * Typed wrappers around the focus session Tauri commands.
 *
 * This is the "Service" layer of React UI -> Service -> Tauri Command ->
 * Rust -> SQLite (development-plan.md section 86): components and stores
 * import from here and never call `invoke` themselves.
 *
 * The timer itself is not here and is not in Rust either — it runs in
 * `src/stores/focusStore.ts`, measured against the clock. What crosses this
 * boundary is only the three things worth keeping: a session began, a session
 * ended, and (after a reload, or in a second window) what is running right
 * now. That split is why a focus session survives the UI being reloaded:
 * `startFocusSession` writes `started_at` the moment the user presses Start,
 * so the elapsed time is recoverable from the row rather than living only in
 * a JavaScript variable.
 *
 * Every command rejects with a plain, user-presentable string on failure (a
 * custom session with no length, a task that no longer exists, a session
 * ended twice, ...), so callers can surface `String(error)` straight to a
 * toast.
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  FocusFilter,
  FocusPresetId,
  FocusSession,
  FocusSessionOutcome,
  NewFocusSession,
} from "@/types/focus";

/** How much history the History view (section 64) reads back by default. */
export const FOCUS_HISTORY_LIMIT = 200;

// ---------------------------------------------------------------------------
// Running a session
// ---------------------------------------------------------------------------

/**
 * Starts a session and returns the row as stored, `started_at` included.
 *
 * Any session still running is closed as interrupted first, so there is only
 * ever one clock: starting a second timer while the first is going would
 * double-count the same minutes, and a session left open by a crash would
 * otherwise stay open forever.
 *
 * Rejects if `planned_seconds` and the preset disagree — see
 * {@link NewFocusSession} — or if the task or routine it names is gone.
 */
export async function startFocusSession(
  session: NewFocusSession,
): Promise<FocusSession> {
  return invoke<FocusSession>("start_focus_session", { session });
}

/**
 * Ends a running session and returns it with its duration and outcome
 * stored. Rejects if the session has already ended.
 */
export async function endFocusSession(
  id: number,
  outcome: FocusSessionOutcome,
): Promise<FocusSession> {
  return invoke<FocusSession>("end_focus_session", { id, outcome });
}

/**
 * Ends whichever session is running, and answers `null` if none was.
 *
 * The startup case: a session the previous run left open was not being
 * watched by anyone, so it is recorded as interrupted rather than resumed
 * with hours of "focus" nobody did.
 */
export async function endActiveFocusSession(
  outcome: FocusSessionOutcome = { completed: false },
): Promise<FocusSession | null> {
  return invoke<FocusSession | null>("end_active_focus_session", { outcome });
}

/**
 * The session that is still running, or `null`.
 *
 * `elapsed_seconds` on the returned row is how far in it already is, so a
 * freshly loaded window picks the clock up where it was instead of starting
 * it over.
 */
export async function getActiveFocusSession(): Promise<FocusSession | null> {
  return invoke<FocusSession | null>("get_active_focus_session");
}

/** Returns the session, or `null` if it no longer exists. */
export async function getFocusSession(
  id: number,
): Promise<FocusSession | null> {
  return invoke<FocusSession | null>("get_focus_session", { id });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Lists sessions newest first. Passing no filter lists everything, including
 * the one still running.
 */
export async function listFocusSessions(
  filter: FocusFilter = {},
): Promise<FocusSession[]> {
  return invoke<FocusSession[]>("list_focus_sessions", { filter });
}

/**
 * The Focus > History list (section 64): finished sessions, newest first.
 *
 * A running session is left out on purpose — it belongs on the timer, not in
 * the record of what has already happened.
 */
export async function listFocusHistory(
  filter: Omit<FocusFilter, "only_ended"> = {},
): Promise<FocusSession[]> {
  return listFocusSessions({
    limit: FOCUS_HISTORY_LIMIT,
    ...filter,
    only_ended: true,
  });
}

/**
 * Sessions started on or after a local `YYYY-MM-DD` date — the shape "today's
 * focus time" and the weekly totals of section 36 are read in.
 */
export async function listFocusSessionsSince(
  since: string,
  filter: FocusFilter = {},
): Promise<FocusSession[]> {
  return listFocusSessions({ ...filter, since });
}

/** Every session recorded against one task (section 19). */
export async function listTaskFocusSessions(
  taskId: number,
  filter: FocusFilter = {},
): Promise<FocusSession[]> {
  return listFocusSessions({ ...filter, task_id: taskId });
}

/** Every session recorded against one routine (section 33's statistics). */
export async function listRoutineFocusSessions(
  routineId: number,
  filter: FocusFilter = {},
): Promise<FocusSession[]> {
  return listFocusSessions({ ...filter, routine_id: routineId });
}

// ---------------------------------------------------------------------------
// Building the payload
// ---------------------------------------------------------------------------

/**
 * The `planned_seconds` a preset should be started with.
 *
 * The backend derives the fixed presets' lengths itself and refuses one for a
 * stopwatch, so this sends a length only where a length is the caller's to
 * choose: `custom`. `minutes` is ignored for every other preset.
 */
export function plannedSecondsFor(
  preset: FocusPresetId,
  minutes: number | null,
): number | null {
  if (preset !== "custom") return null;
  return minutes === null ? null : Math.round(minutes * 60);
}

/**
 * Assembles the start payload for a preset, with whatever the session is
 * attached to.
 *
 * Both attachments default to null, because the Focus page starts sessions
 * that stand alone (section 34: "launched independently").
 */
export function newFocusSession(
  preset: FocusPresetId,
  options: {
    minutes?: number | null;
    taskId?: number | null;
    routineId?: number | null;
  } = {},
): NewFocusSession {
  return {
    preset,
    planned_seconds: plannedSecondsFor(preset, options.minutes ?? null),
    task_id: options.taskId ?? null,
    routine_id: options.routineId ?? null,
  };
}
