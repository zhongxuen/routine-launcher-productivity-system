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
 *
 * One more thing happens on start, pause, resume and finish, and it is there
 * because section 26's desktop widget is a second webview holding a second
 * copy of this store. Each of those four announces the clock's new state to
 * the app's other windows, which adopt it through `adoptSession`. Re-reading
 * the database would not do: pausing is arithmetic here rather than a column
 * there, so a window that only heard "something changed" would resume a
 * paused session and count minutes nobody focused. See `src/lib/focus-sync.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE BREAK
 *
 * A completed session whose preset names a break — 25/5's five minutes, or
 * the length set beside Custom — leaves a `breakOffer` next to its completion
 * card, and `startBreak` turns it into a second, smaller clock: `focusBreak`.
 *
 * Everything above about the record is deliberately untrue of it. A break is
 * not focus, so it writes no row, earns no XP and appears in no statistic,
 * history or streak (sections 35, 36, 88). It lives here and nowhere else,
 * which is why closing the app during one loses it — and why the other
 * windows can only learn of it through `announceFocusBreak`, there being
 * nothing for them to re-read.
 *
 * Every window counts the break down and every one reaches its end. The
 * notification goes out through Rust, which shows it for the first window to
 * ask and tells the rest they were not first; that answer is also what keeps
 * the sound to one window. Starting the next session — from the break or from
 * anywhere else — is what ends a break that is still on screen.
 * ---------------------------------------------------------------------------
 */

import { create, type StoreApi } from "zustand";

import { emitFocusSessionEnded } from "@/lib/focus-events";
import { announceFocusBreak, announceFocusSession } from "@/lib/focus-sync";
import {
  breakBackTo,
  breakMinutesFor,
  breakRemainingSeconds,
  hasReachedTarget,
  sortSessionsByRecency,
  sqliteTimestamp,
} from "@/lib/focus-utils";
import { playSound } from "@/lib/sounds";
import { emitProgressChanged } from "@/lib/progress-events";
import { announceDataChanged } from "@/lib/window-sync";
import {
  endFocusSession,
  getActiveFocusSession,
  getFocusSession,
  listFocusHistory,
  newFocusSession,
  startFocusSession,
} from "@/services/focusService";
import { announceBreakOver } from "@/services/notificationService";
import {
  DEFAULT_CUSTOM_BREAK_MINUTES,
  DEFAULT_CUSTOM_MINUTES,
  FOCUS_PRESETS,
  MAX_CUSTOM_BREAK_MINUTES,
  MAX_CUSTOM_MINUTES,
  MIN_CUSTOM_MINUTES,
  focusPreset,
  type FocusPresetId,
  type FocusSession,
} from "@/types/focus";
import type { ActiveFocusSession, FocusBreak, StartFocusOptions } from "@/types/focus-ui";

/**
 * The break a completed session has earned, before anyone has taken it: its
 * length, and the session to start again afterwards.
 */
export interface BreakOffer {
  minutes: number;
  next: StartFocusOptions;
}

interface FocusState {
  /** The preset the picker is on. Also what the next Start uses. */
  presetId: FocusPresetId;
  /** The length behind the Custom preset, in minutes. */
  customMinutes: number;
  /**
   * Section 52's "Default focus duration": the length Custom starts at, and
   * goes on showing until somebody changes it. See `followDefaultCustomMinutes`.
   */
  defaultCustomMinutes: number;
  /** The break after a Custom session, in minutes. Zero means none. */
  customBreakMinutes: number;

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
   * The break the session in `result` can be followed by, or null when it
   * did not complete or its preset names none. Goes with `result`.
   */
  breakOffer: BreakOffer | null;
  /**
   * The break on the clock, or waiting to be dismissed once it is over. Null
   * when there is none. Never at the same time as `session`.
   */
  focusBreak: FocusBreak | null;
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
  setCustomBreakMinutes: (minutes: number) => void;
  /**
   * Takes on a new default focus duration (section 52) — read at start-up,
   * or saved from Settings in this window or another.
   *
   * Custom's length moves with it only while it still shows the old default.
   * A length the user typed, or one a task's estimate left behind, is theirs,
   * and a setting saved in another window has no business overwriting it.
   */
  followDefaultCustomMinutes: (minutes: number) => void;

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
   * Starts the break `breakOffer` describes, in place of the completion card.
   * Refused while a session is running or starting, or a break already is.
   */
  startBreak: () => void;
  /**
   * Ends a running break now, as though it had run out — minus the
   * notification and the sound, because the user is the one who ended it and
   * is looking at the button.
   */
  endBreak: () => void;
  /**
   * Starts the session the break followed, again: same preset, task and
   * routine. Skip while the break runs, and "Start another session" once it
   * is over. The break stays on screen if the session cannot be started.
   */
  continueAfterBreak: () => Promise<void>;
  /** Puts a break away without starting anything — Done, once it is over. */
  dismissBreak: () => void;

  /**
   * Picks the clock back up on a session that is still running in the
   * database — what a reloaded window does on mount.
   *
   * Does nothing when a session is already on the clock, so it is safe to
   * call from an effect that remounts.
   */
  restoreSession: () => Promise<void>;

  /**
   * Takes on the clock as another window reports it (section 26's widget).
   *
   * The counterpart of the announcements the four actions above make. There
   * is one focus session, and a second webview holding a second copy of this
   * store must show the same one — including whether it is paused, which is
   * the one thing about a running session that `focus_sessions` does not
   * record. So the reported state is adopted whole rather than merged with
   * anything local: the window that changed the clock is the one that knows
   * what it says. See `src/lib/focus-sync.ts`.
   *
   * Announces nothing itself, which is what keeps two windows from echoing a
   * pause back and forth forever. The one exception is a countdown that has
   * run out here as well, which is finished here too — and whose "nothing is
   * running" the window that sent it already agrees with.
   */
  adoptSession: (session: ActiveFocusSession | null) => void;
  /**
   * Takes on the break as another window reports it. The break's counterpart
   * of `adoptSession`, and silent for the same reason.
   */
  adoptBreak: (focusBreak: FocusBreak | null) => void;

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

/** The same, for the break's clock. Never running at the same time as the above. */
let breakTickHandle: ReturnType<typeof setInterval> | null = null;

export const useFocusStore = create<FocusState>((set, get) => ({
  presetId: "25-5",
  customMinutes: DEFAULT_CUSTOM_MINUTES,
  defaultCustomMinutes: DEFAULT_CUSTOM_MINUTES,
  customBreakMinutes: DEFAULT_CUSTOM_BREAK_MINUTES,
  session: null,
  isStarting: false,
  result: null,
  breakOffer: null,
  focusBreak: null,
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

  setCustomBreakMinutes(minutes) {
    if (get().session) return;
    set({ customBreakMinutes: clampBreakMinutes(minutes) });
  },

  followDefaultCustomMinutes(minutes) {
    const next = clampMinutes(minutes);
    const { customMinutes, defaultCustomMinutes } = get();
    if (next === defaultCustomMinutes) return;

    set({
      defaultCustomMinutes: next,
      ...(customMinutes === defaultCustomMinutes ? { customMinutes: next } : {}),
    });
  },

  async startSession(options) {
    if (get().session || get().isStarting) return;

    const minutes = startingMinutes(get(), options);
    // A session started from a task carries its own length, so the picker
    // moves to match it rather than showing a preset the clock is not using.
    // The session after a break names its preset outright, so a Custom 25
    // minutes comes back as Custom rather than as 25/5.
    const presetId =
      options?.presetId ?? (options?.minutes != null ? presetForMinutes(minutes) : get().presetId);

    set({ isStarting: true, sessionError: null, result: null, breakOffer: null });

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
      // Carried through when the caller knows it — the session after a
      // break keeps the break it had, whatever this window's Custom field
      // happens to say.
      breakMinutes:
        options?.breakMinutes !== undefined
          ? options.breakMinutes
          : breakMinutesFor(row.preset, get().customBreakMinutes),
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
      label: options?.label ?? null,
    };

    // Starting focus is what ends a break, wherever it was started from — the
    // break's own Skip, or Start Focus on the dashboard in the middle of one.
    // Only once the row exists, though: a session that could not be started
    // leaves the break where it was rather than taking it away for nothing.
    const endsBreak = get().focusBreak !== null;
    stopBreakTicking();

    set({
      session,
      isStarting: false,
      focusBreak: null,
      presetId: session.presetId,
      customMinutes:
        session.presetId === "custom" && minutes ? minutes : get().customMinutes,
    });

    startTicking(set, get);
    // `start_focus_session` closes anything already running, so a second
    // window holding the session this one just replaced has to hear about it
    // before its clock counts another second against a row that has ended.
    announceFocusSession(session);
    if (endsBreak) announceFocusBreak(null);
  },

  pauseSession() {
    const session = get().session;
    if (!session || session.status === "paused") return;

    stopTicking();

    // The elapsed count is frozen by recording *when* the pause began: from
    // here on, `elapsedSecondsOf` measures to that instant instead of to now.
    const pausedAtMs = Date.now();
    const paused: ActiveFocusSession = {
      ...session,
      status: "paused",
      pausedAtMs,
      elapsedSeconds: elapsedSecondsOf(session, pausedAtMs),
    };

    set({ session: paused });
    // Nothing is written for a pause — it is arithmetic about a clock, not a
    // fact about a row — so the other window can only learn of it here.
    announceFocusSession(paused);
  },

  resumeSession() {
    const session = get().session;
    if (!session || session.status === "running" || session.pausedAtMs === null) return;

    // Everything the pause was worth is added to `pausedMs`, which is
    // subtracted from wall-clock time for the rest of the session. Paused
    // minutes are not focused minutes, and section 88 would rather the number
    // be smaller than wrong.
    const resumed: ActiveFocusSession = {
      ...session,
      status: "running",
      pausedMs: session.pausedMs + (Date.now() - session.pausedAtMs),
      pausedAtMs: null,
    };

    set({ session: resumed });

    startTicking(set, get);
    // `pausedMs` is the whole reason this travels: a window that only heard
    // "running again" would go on counting the minutes spent paused.
    announceFocusSession(resumed);
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
    set({
      session: null,
      result: localRecord(session, outcome),
      breakOffer: outcome.completed ? breakOfferFor(session) : null,
      sessionError: null,
    });

    // Before the write, for the same reason the clock stops before it: the
    // session is over, and a second window still counting it down would be
    // showing minutes nobody is focusing.
    announceFocusSession(null);

    let row: FocusSession;
    try {
      row = await endFocusSession(session.id, {
        completed: outcome.completed,
        duration_seconds: outcome.duration,
      });
    } catch (cause) {
      // A countdown can run out in two windows within a tick of each other,
      // and the second `end_focus_session` is refused because the row is
      // already closed. That is the session having been recorded, not a
      // failure to record it — so the stored row is read back and used, and
      // only a session that genuinely did not end is reported as an error.
      const ended = await getFocusSession(session.id).catch(() => null);
      if (!ended || ended.ended_at === null) {
        set({ sessionError: String(cause) });
        return;
      }
      row = ended;
    }

    set((state) => {
      // Unless another session — or the break — has already been started on
      // top of this one, in which case the card belongs to that future, not
      // this session's past.
      const movedOn = state.session !== null || state.focusBreak !== null;
      return {
        result: movedOn ? state.result : row,
        // Decided by the stored row rather than the local guess: when another
        // window ended the session first, the row is the one that knows
        // whether it ran its full length.
        breakOffer: movedOn ? state.breakOffer : row.completed ? breakOfferFor(session) : null,
        history: [row, ...state.history.filter((past) => past.id !== row.id)],
      };
    });

    // Announced only now, once the row is stored: a subscriber that re-reads
    // the database — the task list, whose `focus_seconds` this session just
    // changed — has to be able to trust that the minutes it will find are
    // already there. See `src/lib/focus-events.ts`.
    emitFocusSessionEnded(row);

    // The same re-read, for the app's *other* windows. Section 17's "actual
    // focus time" is on the task row, and a session finished from the widget
    // has just changed it for a list the main window is still holding.
    if (row.task_id !== null) announceDataChanged("tasks");

    // And section 43's +25, which `end_focus_session` has already written for
    // a session that reached its target.
    emitProgressChanged();
  },

  dismissResult() {
    set({ result: null, breakOffer: null });
  },

  startBreak() {
    const { breakOffer, session, isStarting, focusBreak } = get();
    if (!breakOffer || session || isStarting || focusBreak) return;

    const now = Date.now();
    const started: FocusBreak = {
      // Unique enough for the one job it has — telling this break's end
      // apart from the last one's — and needs no secure context to make.
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      minutes: breakOffer.minutes,
      startedAtMs: now,
      endsAtMs: now + breakOffer.minutes * 60_000,
      remainingSeconds: breakOffer.minutes * 60,
      status: "running",
      endedEarly: false,
      next: breakOffer.next,
    };

    // The completion card goes: the break is what comes after it, and the
    // session it described is already in History.
    set({ focusBreak: started, result: null, breakOffer: null, sessionError: null });

    startBreakTicking(set, get);
    announceFocusBreak(started);
  },

  endBreak() {
    const focusBreak = get().focusBreak;
    if (!focusBreak || focusBreak.status !== "running") return;

    stopBreakTicking();

    const ended: FocusBreak = { ...focusBreak, status: "over", remainingSeconds: 0, endedEarly: true };
    set({ focusBreak: ended });
    announceFocusBreak(ended);
  },

  async continueAfterBreak() {
    const focusBreak = get().focusBreak;
    if (!focusBreak) return;

    // `startSession` ends the break once the row exists, and reports a
    // refusal — the task was deleted during the break, say — in
    // `sessionError`, next to the break it left in place.
    await get().startSession(focusBreak.next);
  },

  dismissBreak() {
    if (!get().focusBreak) return;

    stopBreakTicking();
    set({ focusBreak: null });
    announceFocusBreak(null);
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

    const session = restoredSession(row, get().customBreakMinutes);
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

  adoptSession(session) {
    // Two windows that both restored the same session from the database, and
    // then both answered a request about it, are agreeing rather than
    // disagreeing — re-setting the store would restart the interval and
    // re-render every second of it for nothing.
    if (isSameClock(get().session, session)) return;

    // Two windows count the same countdown down, and whichever ticks first
    // ends it and announces that nothing is running — often a quarter of a
    // second before this window's own tick would have got there. Taking that
    // at its word would drop this window straight to an idle clock, losing
    // the completion card and with it the break it offers. So a countdown
    // that has run out here too is finished here too: `finishSession` finds
    // the row already ended and shows the stored one. The sound is left to
    // the window that got there first.
    const local = get().session;
    if (session === null && local !== null && hasRunOut(local)) {
      void get().finishSession();
      return;
    }

    stopTicking();
    // A session on the clock means the break is over, wherever it was ended.
    if (session) stopBreakTicking();

    set({
      session,
      // A session arriving from elsewhere is news about the present, so
      // whatever this window was showing about the past goes away with it —
      // including an error about a write another window has since made.
      result: null,
      breakOffer: null,
      focusBreak: session ? null : get().focusBreak,
      sessionError: null,
      presetId: session?.presetId ?? get().presetId,
    });

    if (session?.status === "running") startTicking(set, get);
  },

  adoptBreak(focusBreak) {
    if (isSameBreak(get().focusBreak, focusBreak)) return;

    stopBreakTicking();

    if (focusBreak === null) {
      set({ focusBreak: null });
      return;
    }

    // Re-measured on arrival, so a window that heard late does not show the
    // other window's second for a tick before correcting itself.
    const adopted: FocusBreak =
      focusBreak.status === "running"
        ? { ...focusBreak, remainingSeconds: breakRemainingSeconds(focusBreak) }
        : focusBreak;

    // A break started elsewhere replaces the completion card here, exactly
    // as it did in the window it was started from.
    set({ focusBreak: adopted, result: null, breakOffer: null, sessionError: null });

    if (adopted.status === "running") startBreakTicking(set, get);
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
    // Here rather than in `finishSession`, which is also what pressing Finish
    // calls: a session the user ended themselves needs no announcement,
    // because they were looking at the button when they ended it. A session
    // that ran out did so on its own clock, and this is the one cue in the
    // app that is doing real work rather than decorating — the user may well
    // be in another window with the timer out of sight, which is exactly what
    // section 20's timer is for.
    playSound("focus-complete");
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

/**
 * The break's tick: recomputes what is left, and ends a break that has run
 * out.
 *
 * Ending one is three things, and only the first is this window's alone. The
 * face turns to "Break over" here and is announced, so a window whose timers
 * are being throttled catches up at once. The notification and the sound are
 * claimed from Rust, which says yes to the first window per break — every
 * window reaches this line within a tick of the others, and one "break over"
 * is news where two is a bug.
 */
function tickBreak(set: Set, get: Get): void {
  const focusBreak = get().focusBreak;
  if (!focusBreak || focusBreak.status !== "running") return;

  const remainingSeconds = breakRemainingSeconds(focusBreak);
  if (remainingSeconds > 0) {
    if (remainingSeconds !== focusBreak.remainingSeconds) {
      set({ focusBreak: { ...focusBreak, remainingSeconds } });
    }
    return;
  }

  stopBreakTicking();

  const over: FocusBreak = { ...focusBreak, status: "over", remainingSeconds: 0, endedEarly: false };
  set({ focusBreak: over });
  announceFocusBreak(over);

  void announceBreakOver(over.id, over.minutes, breakBackTo(over))
    .catch((cause: unknown) => {
      // The notification is lost, but the sound is still owed: a window that
      // cannot reach Rust is on its own, and one cue is better than none.
      console.error("Could not announce the end of the break:", cause);
      return true;
    })
    .then((announced) => {
      if (announced) playSound("break-over");
    });
}

function startBreakTicking(set: Set, get: Get): void {
  stopBreakTicking();
  breakTickHandle = setInterval(() => tickBreak(set, get), TICK_MS);
}

function stopBreakTicking(): void {
  if (breakTickHandle === null) return;
  clearInterval(breakTickHandle);
  breakTickHandle = null;
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

/**
 * Whether two windows are describing the same clock in the same place.
 *
 * Everything that decides what the face reads, and nothing that does not:
 * `elapsedSeconds` is left out because it is recomputed from the three fields
 * above it on every tick, and comparing it would make two windows a fraction
 * of a second apart look like a disagreement worth restarting the timer over.
 */
function isSameClock(
  a: ActiveFocusSession | null,
  b: ActiveFocusSession | null,
): boolean {
  if (a === null || b === null) return a === b;

  return (
    a.id === b.id &&
    a.status === b.status &&
    a.startedAtMs === b.startedAtMs &&
    a.pausedMs === b.pausedMs &&
    a.pausedAtMs === b.pausedAtMs
  );
}

/**
 * Whether a running countdown has reached its length by the clock, whatever
 * the last tick got round to writing into `elapsedSeconds`.
 */
function hasRunOut(session: ActiveFocusSession): boolean {
  return (
    session.status === "running" &&
    hasReachedTarget({ ...session, elapsedSeconds: elapsedSecondsOf(session) })
  );
}

/**
 * `isSameClock` for the break. The id and where it is up to are the whole
 * of it: the end instant is fixed when the break starts, and `remainingSeconds`
 * is recomputed from it by every window on every tick.
 */
function isSameBreak(a: FocusBreak | null, b: FocusBreak | null): boolean {
  if (a === null || b === null) return a === b;
  return a.id === b.id && a.status === b.status && a.endedEarly === b.endedEarly;
}

/**
 * The break a completed session has earned, and the session to start again
 * after it — or null when its preset names none.
 *
 * A stopwatch never has one: it has no length to restart with, and a break
 * implies a cycle a count-up clock does not have.
 */
function breakOfferFor(session: ActiveFocusSession): BreakOffer | null {
  if (!session.breakMinutes || session.targetSeconds === null) return null;

  return {
    minutes: session.breakMinutes,
    next: {
      presetId: session.presetId,
      minutes: Math.round(session.targetSeconds / 60),
      breakMinutes: session.breakMinutes,
      taskId: session.taskId,
      taskTitle: session.taskTitle,
      routineId: session.routineId,
      routineName: session.routineName,
      label: session.label,
    },
  };
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
 *
 * A Custom session's break is not on the row — it is the picker's, like the
 * break itself — so it comes back as whatever this window's field says. Nor is
 * a label: a planning session comes back as a session against its routine.
 */
function restoredSession(row: FocusSession, customBreakMinutes: number): ActiveFocusSession {
  return {
    id: row.id,
    presetId: row.preset,
    mode: row.planned_seconds === null ? "stopwatch" : "countdown",
    targetSeconds: row.planned_seconds,
    breakMinutes: breakMinutesFor(row.preset, customBreakMinutes),
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
    label: null,
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
  const preset = focusPreset(options?.presetId ?? state.presetId);
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

/** The same for the Custom break, where zero is allowed and means none. */
function clampBreakMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_CUSTOM_BREAK_MINUTES;
  return Math.min(MAX_CUSTOM_BREAK_MINUTES, Math.max(0, Math.round(minutes)));
}
