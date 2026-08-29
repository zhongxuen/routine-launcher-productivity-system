/**
 * Focus store — the running timer, and the sessions it has produced.
 *
 * The whole reason this is a store and not component state is the last line
 * of Prompt 4.2: the clock has to keep time while the user is on another
 * page. `FocusTimer` is therefore a *view of* the session rather than the
 * thing running it — unmounting it stops nothing, and coming back shows the
 * session exactly where it got to, because the elapsed count is measured
 * against `Date.now()` rather than accumulated by the interval.
 *
 * The same property makes the timer immune to a throttled background window
 * and to the machine sleeping: the interval decides how often the display is
 * refreshed, never what it says.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CLOCK ENDS AND THE RECORD BEGINS
 *
 * The clock runs here; the record lives in SQLite. Three calls join them, and
 * they are the only three points where something worth keeping happens:
 *
 * - `startSession` writes the row *before* the clock starts, so `started_at`
 *   is stamped at the moment the user pressed Start rather than reconstructed
 *   afterwards. A session therefore exists in the database from its first
 *   second — which is what makes every other case below possible.
 * - `finishSession` ends that row with the seconds this store measured, not
 *   the wall clock, so a session paused for ten minutes records the work
 *   rather than the gap.
 * - `restoreSession` asks what is still running and rebuilds the clock from
 *   `started_at`/`elapsed_seconds`, so reloading the window resumes a session
 *   instead of losing it.
 *
 * A fourth thing happens on the way out of `finishSession`, and it is not a
 * write: the stored row is announced through `src/lib/focus-events.ts`, which
 * is how a session attached to a task (section 19) gets that task re-read.
 * The store deliberately does not do the re-reading itself — it knows what
 * ended, not who was interested.
 *
 * A session that is neither ended nor resumed — the window closed on it, or
 * the app was killed — is closed as interrupted by `close_abandoned` in
 * `src-tauri/src/lib.rs`, which runs both when a window closes and at the next
 * launch. That is Rust's job rather than this store's because the JS hook for
 * a closing window needs a permission the app does not grant; the cost is that
 * a session closed on records the time it was open for rather than the time it
 * was focused on, capped at the length it was started for.
 *
 * The startup half of that sweep runs before any window can ask what is
 * running, which is exactly what makes `restoreSession` safe: an open session
 * at that point is always one *this* run started.
 * ---------------------------------------------------------------------------
 */

import { create, type StoreApi } from "zustand";

import { emitFocusSessionEnded } from "@/lib/focus-events";
import { hasReachedTarget, sortSessionsByRecency, sqliteTimestamp } from "@/lib/focus-utils";
import {
  endFocusSession,
  getActiveFocusSession,
  listFocusHistory,
  newFocusSession,
  startFocusSession,
} from "@/services/focusService";
import {
  DEFAULT_CUSTOM_MINUTES,
  FOCUS_PRESETS,
  MAX_CUSTOM_MINUTES,
  MIN_CUSTOM_MINUTES,
  focusPreset,
  type FocusPresetId,
  type FocusSession,
} from "@/types/focus";
import type { ActiveFocusSession, StartFocusOptions } from "@/types/focus-ui";

interface FocusState {
  /** The preset the picker is on. Also what the next Start uses. */
  presetId: FocusPresetId;
  /** The length behind the Custom preset, in minutes. */
  customMinutes: number;

  /** The session on the clock, or null when nothing is running. */
  session: ActiveFocusSession | null;
  /**
   * True between pressing Start and the row coming back.
   *
   * The clock only starts once the session exists in the database, so there
   * is a moment — brief, it is a local file — with no session and no idle
   * state either. Start is disabled for it, which is also what stops a second
   * click from writing a second row.
   */
  isStarting: boolean;
  /**
   * The session that just ended, still on screen as the completion state.
   * Cleared by `dismissResult`, or by starting the next session.
   */
  result: FocusSession | null;
  /**
   * A failed *write* — the row could not be started, or could not be ended.
   *
   * Kept rather than thrown because both happen around a clock the user is
   * looking at: a session that could not be recorded is worth saying out loud
   * next to the timer, and neither failure is something a caller could
   * usefully handle.
   */
  sessionError: string | null;

  /** Past sessions, newest first — the History view's list. */
  history: FocusSession[];
  isHistoryLoading: boolean;
  historyError: string | null;

  selectPreset: (id: FocusPresetId) => void;
  setCustomMinutes: (minutes: number) => void;

  /**
   * Starts a session with the picked preset, or with whatever `options`
   * names instead.
   *
   * Refused while one is already running: two focus sessions at once is not a
   * thing that can be true, and silently replacing the first would throw away
   * the minutes it had already measured.
   */
  startSession: (options?: StartFocusOptions) => Promise<void>;
  pauseSession: () => void;
  resumeSession: () => void;
  /**
   * Ends the session and records it.
   *
   * Completed when it ran the length it was started for — which a stopwatch
   * always has, having been started for no particular length — and
   * interrupted when it did not. That is the section 35 / 76 distinction
   * between a finished session and an abandoned one.
   */
  finishSession: () => Promise<void>;
  /** Puts the completion card away. */
  dismissResult: () => void;

  /**
   * Picks the clock back up on a session that is still running in the
   * database — what a reloaded window does on mount.
   *
   * Does nothing when a session is already on the clock, so it is safe to
   * call from an effect that remounts.
   */
  restoreSession: () => Promise<void>;

  loadHistory: () => Promise<void>;
}

type Set = StoreApi<FocusState>["setState"];
type Get = StoreApi<FocusState>["getState"];

/**
 * How often the display is recomputed.
 *
 * Faster than the second it shows, so the clock changes within a frame or two
 * of the second actually turning over rather than drifting up to a second
 * behind it. The extra ticks cost nothing: `tick` only writes to the store
 * when the whole second has changed, so React re-renders once a second either
 * way.
 */
const TICK_MS = 250;

/**
 * The interval driving the display, or null when nothing is running.
 *
 * Module-level rather than in the store because nothing renders it, and
 * because it must outlive every component that shows the timer — the point of
 * the whole design. A zustand store lives for the lifetime of the page, so
 * this handle does too.
 */
let tickHandle: ReturnType<typeof setInterval> | null = null;

export const useFocusStore = create<FocusState>((set, get) => ({
  presetId: "25-5",
  customMinutes: DEFAULT_CUSTOM_MINUTES,
  session: null,
  isStarting: false,
  result: null,
  sessionError: null,
  history: [],
  isHistoryLoading: false,
  historyError: null,

  selectPreset(id) {
    // Switching presets mid-session would change the length of a clock that
    // is already counting against it. The picker is disabled while a session
    // runs; this is the same rule, stated where it can be enforced.
    if (get().session) return;
    set({ presetId: id });
  },

  setCustomMinutes(minutes) {
    if (get().session) return;
    set({ customMinutes: clampMinutes(minutes) });
  },

  async startSession(options) {
    if (get().session || get().isStarting) return;

    const minutes = startingMinutes(get(), options);
    // A session started from a task carries its own length, so the picker
    // moves to match it rather than showing a preset the clock is not using.
    const presetId = options?.minutes != null ? presetForMinutes(minutes) : get().presetId;

    set({ isStarting: true, sessionError: null, result: null });

    // The clock is deliberately started from the row rather than alongside
    // it: until `start_focus_session` answers there is nothing to end, and a
    // timer counting against a session that was refused — a custom length out
    // of range, a task that has since been deleted — would be counting for
    // nothing.
    const startedAtMs = Date.now();
    let row: FocusSession;
    try {
      row = await startFocusSession(
        newFocusSession(presetId, {
          minutes,
          taskId: options?.taskId ?? null,
          routineId: options?.routineId ?? null,
        }),
      );
    } catch (cause) {
      set({ isStarting: false, sessionError: String(cause) });
      return;
    }

    const session: ActiveFocusSession = {
      id: row.id,
      presetId: row.preset,
      mode: row.planned_seconds === null ? "stopwatch" : "countdown",
      // The backend derives a fixed preset's length itself, so the target is
      // read back off the row rather than recomputed here — one answer to
      // "how long is this session", not two that could differ.
      targetSeconds: row.planned_seconds,
      breakMinutes: focusPreset(row.preset).breakMinutes,
      startedAt: row.started_at,
      // Measured locally rather than parsed back out of `started_at`, which
      // SQLite writes to the nearest second: the row and this number come
      // from the same machine clock a millisecond apart, and the clock face
      // is smoother for keeping the finer one.
      startedAtMs,
      status: "running",
      elapsedSeconds: 0,
      pausedMs: 0,
      pausedAtMs: null,
      taskId: row.task_id,
      taskTitle: row.task_title ?? options?.taskTitle ?? null,
      routineId: row.routine_id,
      routineName: row.routine_name ?? options?.routineName ?? null,
    };

    set({
      session,
      isStarting: false,
      presetId: session.presetId,
      customMinutes:
        session.presetId === "custom" && minutes ? minutes : get().customMinutes,
    });

    startTicking(set, get);
  },

  pauseSession() {
    const session = get().session;
    if (!session || session.status === "paused") return;

    stopTicking();

    // The elapsed count is frozen by recording *when* the pause began: from
    // here on, `elapsedSecondsOf` measures to that instant instead of to now.
    const pausedAtMs = Date.now();
    set({
      session: {
        ...session,
        status: "paused",
        pausedAtMs,
        elapsedSeconds: elapsedSecondsOf(session, pausedAtMs),
      },
    });
  },

  resumeSession() {
    const session = get().session;
    if (!session || session.status === "running" || session.pausedAtMs === null) return;

    // Everything the pause was worth is added to `pausedMs`, which is
    // subtracted from wall-clock time for the rest of the session. Paused
    // minutes are not focused minutes, and section 88 would rather the number
    // be smaller than wrong.
    set({
      session: {
        ...session,
        status: "running",
        pausedMs: session.pausedMs + (Date.now() - session.pausedAtMs),
        pausedAtMs: null,
      },
    });

    startTicking(set, get);
  },

  async finishSession() {
    const session = get().session;
    if (!session) return;

    const outcome = outcomeOf(session);

    // The clock stops now, not when the write comes back. The session is over
    // either way, and a Finish that visibly hung on the database would be
    // reporting the wrong thing about what just happened. The local record
    // stands in until the stored row replaces it — and stays if the write
    // fails, so the user still sees the minutes they earned.
    stopTicking();
    set({ session: null, result: localRecord(session, outcome), sessionError: null });

    try {
      const row = await endFocusSession(session.id, {
        completed: outcome.completed,
        duration_seconds: outcome.duration,
      });
      set((state) => ({
        // Unless another session has already been started on top of this one,
        // in which case the card belongs to that session's future, not this
        // session's past.
        result: state.session ? state.result : row,
        history: [row, ...state.history.filter((past) => past.id !== row.id)],
      }));

      // Announced only now, once the row is stored: a subscriber that
      // re-reads the database — the task list, whose `focus_seconds` this
      // session just changed — has to be able to trust that the minutes it
      // will find are already there. See `src/lib/focus-events.ts`.
      emitFocusSessionEnded(row);
    } catch (cause) {
      set({ sessionError: String(cause) });
    }
  },

  dismissResult() {
    set({ result: null });
  },

  async restoreSession() {
    if (get().session || get().isStarting) return;

    let row: FocusSession | null;
    try {
      row = await getActiveFocusSession();
    } catch (cause) {
      set({ sessionError: String(cause) });
      return;
    }

    if (!row) return;

    const session = restoredSession(row);
    set({
      session,
      result: null,
      presetId: session.presetId,
      customMinutes:
        session.presetId === "custom" && session.targetSeconds !== null
          ? clampMinutes(Math.round(session.targetSeconds / 60))
          : get().customMinutes,
    });

    startTicking(set, get);
  },

  async loadHistory() {
    set({ isHistoryLoading: get().history.length === 0, historyError: null });

    try {
      const sessions = await listFocusHistory();
      set({
        history: sortSessionsByRecency(sessions),
        isHistoryLoading: false,
        historyError: null,
      });
    } catch (cause) {
      set({ isHistoryLoading: false, historyError: String(cause) });
    }
  },
}));

/* -------------------------------------------------------------------------- */
/* The tick                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Recomputes the elapsed count, and ends a countdown that has run out.
 *
 * Writes to the store only when the displayed second has actually changed, so
 * the four ticks a second cost three no-ops rather than three re-renders.
 */
function tick(set: Set, get: Get): void {
  const session = get().session;
  if (!session || session.status !== "running") return;

  const elapsedSeconds = elapsedSecondsOf(session);
  if (elapsedSeconds !== session.elapsedSeconds) {
    set({ session: { ...session, elapsedSeconds } });
  }

  // Reaching the end is the same event as pressing Finish at the end, so it
  // goes through the same path — and is recorded as completed, because the
  // session ran its full length. `finishSession` clears the session and stops
  // the interval before it waits on the database, so the tick that lands
  // during the write finds nothing to end twice.
  if (hasReachedTarget({ ...session, elapsedSeconds })) {
    void get().finishSession();
  }
}

function startTicking(set: Set, get: Get): void {
  stopTicking();
  tickHandle = setInterval(() => tick(set, get), TICK_MS);
}

function stopTicking(): void {
  if (tickHandle === null) return;
  clearInterval(tickHandle);
  tickHandle = null;
}

/* -------------------------------------------------------------------------- */
/* Working out the numbers                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Focused seconds so far: wall-clock time since the start, minus every
 * millisecond spent paused.
 *
 * While paused, time is measured to the instant the pause began rather than
 * to now — which is what makes a paused clock stand still without anything
 * having to stop it.
 */
function elapsedSecondsOf(session: ActiveFocusSession, now: number = Date.now()): number {
  const until = session.pausedAtMs ?? now;
  return Math.max(0, Math.floor((until - session.startedAtMs - session.pausedMs) / 1000));
}

/** What a session ended as: the seconds it earned, and whether it finished. */
interface FocusOutcomeValues {
  duration: number;
  completed: boolean;
}

/**
 * How a session that is ending now should be recorded.
 *
 * Separate from `finishSession` because it is the arithmetic rather than the
 * write, and reads better next to `elapsedSecondsOf` — the two are the only
 * places that decide what a session was worth.
 *
 * A countdown that overshot — the window was asleep, or throttled hard enough
 * to miss the tick that would have ended it — is recorded as the session it
 * was, not as the wall-clock time the machine was away for.
 */
function outcomeOf(session: ActiveFocusSession): FocusOutcomeValues {
  const elapsed = elapsedSecondsOf(session);
  return {
    duration:
      session.targetSeconds === null ? elapsed : Math.min(elapsed, session.targetSeconds),
    completed: session.targetSeconds === null || elapsed >= session.targetSeconds,
  };
}

/**
 * The session as a row, for the completion card to show while the real one is
 * being written — and to keep showing if that write fails.
 *
 * It carries the id of the row it stands for, so the stored version replaces
 * it in History rather than joining it there.
 */
function localRecord(
  session: ActiveFocusSession,
  { duration, completed }: FocusOutcomeValues,
): FocusSession {
  return {
    id: session.id,
    task_id: session.taskId,
    routine_id: session.routineId,
    preset: session.presetId,
    planned_seconds: session.targetSeconds,
    started_at: session.startedAt,
    ended_at: sqliteTimestamp(),
    duration_seconds: duration,
    elapsed_seconds: duration,
    completed,
    interrupted: !completed,
    task_title: session.taskTitle,
    routine_name: session.routineName,
  };
}

/**
 * A running row, back on the clock.
 *
 * The start instant is derived from the seconds the backend counted rather
 * than by parsing `started_at`: the row's own arithmetic is the one the
 * database will use again if this window is reloaded a second time, and
 * whole-second truncation can only ever leave the clock a moment *behind*
 * the session — never ahead of it.
 *
 * A paused session comes back running. The pause was a fact about a window
 * that no longer exists, and the alternative — restoring a clock that is
 * standing still and saying nothing about why — is worse than resuming one
 * the user can pause again.
 */
function restoredSession(row: FocusSession): ActiveFocusSession {
  return {
    id: row.id,
    presetId: row.preset,
    mode: row.planned_seconds === null ? "stopwatch" : "countdown",
    targetSeconds: row.planned_seconds,
    breakMinutes: focusPreset(row.preset).breakMinutes,
    startedAt: row.started_at,
    startedAtMs: Date.now() - row.elapsed_seconds * 1000,
    status: "running",
    elapsedSeconds: row.elapsed_seconds,
    pausedMs: 0,
    pausedAtMs: null,
    taskId: row.task_id,
    taskTitle: row.task_title,
    routineId: row.routine_id,
    routineName: row.routine_name,
  };
}

/**
 * The length the next session runs for: what the caller asked for, else the
 * preset's own length, else — for Custom — whatever is in the field.
 *
 * Null means a stopwatch. A caller passing `minutes: null` is not asking for
 * one, though: null there means "nothing named a length" (see
 * `focus-intent.ts`), so it falls through to the preset exactly as an absent
 * option would.
 */
function startingMinutes(state: FocusState, options?: StartFocusOptions): number | null {
  const preset = focusPreset(state.presetId);
  const requested = options?.minutes ?? preset.focusMinutes;
  if (requested != null) return clampMinutes(requested);
  return preset.mode === "stopwatch" ? null : clampMinutes(state.customMinutes);
}

/** The preset a length belongs to — 50 minutes is the 50/10 preset, 45 is Custom. */
function presetForMinutes(minutes: number | null): FocusPresetId {
  if (minutes === null) return "stopwatch";
  return FOCUS_PRESETS.find((preset) => preset.focusMinutes === minutes)?.id ?? "custom";
}

/** Keeps a length inside the range the timer can actually run. */
function clampMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_CUSTOM_MINUTES;
  return Math.min(MAX_CUSTOM_MINUTES, Math.max(MIN_CUSTOM_MINUTES, Math.round(minutes)));
}
