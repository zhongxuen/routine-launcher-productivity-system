/**
 * Routine store — the single place the routine UI talks to the routine
 * backend.
 *
 * It is written exactly as `taskStore.ts` is: every action goes through a
 * service module, and the store holds no opinion about routine data the
 * service does not also hold. That module is `routineService.ts`, which wraps
 * the Tauri commands in `src-tauri/src/commands/routines.rs`.
 *
 * Two things about the shape of a run are worth knowing.
 *
 * 1. `launch_routine` runs the whole routine and answers once, so the panel's
 *    lines resolve together at the end rather than one at a time. The
 *    per-action callback below is consequently never invoked today; it stays
 *    because it is where a future per-action event would attach, and because
 *    the panel renders correctly either way — every action is on screen from
 *    the first frame and the result writes its outcome into each line.
 * 2. Retry answers about the actions it retried, not about the whole routine,
 *    so its results are merged into the run rather than replacing it.
 */

import { create, type StoreApi } from "zustand";

import { playSound } from "@/lib/sounds";
import { requestFocus } from "@/lib/focus-intent";
import { emitProgressChanged } from "@/lib/progress-events";
import { announceDataChanged } from "@/lib/window-sync";
import { listRoutineStatistics } from "@/services/analyticsService";
import {
  createRoutine as createRoutineCommand,
  deleteRoutine as deleteRoutineCommand,
  launchRoutine as launchRoutineCommand,
  listRoutines,
  retryRoutineActions,
  updateRoutine as updateRoutineCommand,
} from "@/services/routineService";
import type {
  ActionResult,
  NewRoutine,
  RoutineRunResult,
  RoutineUpdate,
  RoutineWithActions,
} from "@/types/routine";
import type { RoutineStatistics } from "@/types/analytics";
import type {
  RoutineLaunchOptions,
  RoutineRun,
  RoutineRunAction,
} from "@/types/routine-ui";

interface RoutineState {
  /** Every routine with its ordered actions, as the service returned them. */
  routines: RoutineWithActions[];
  /** True only while the list is being read for the first time. */
  isLoading: boolean;
  /** A failed *read*. Mutations reject instead, so the caller can toast. */
  error: string | null;

  /**
   * The launch in progress, or the finished one still on screen. Null when
   * the launch panel is closed. Only ever one at a time: starting a routine
   * while another is running is refused rather than queued, because two
   * routines fighting over the foreground is not a thing anyone wants.
   */
  run: RoutineRun | null;

  /** The routine whose statistics panel is open, if any. */
  statisticsRoutineId: number | null;

  /**
   * Section 33's figures, keyed by routine id.
   *
   * Read alongside the routines rather than when a panel opens, because the
   * cards show two of them ("36h 20m focused · 37 tasks") and would otherwise
   * pop in a beat after the list. A missing key is a load that has not
   * finished or has failed; the card falls back to the launch count it
   * already has rather than showing zeroes it cannot vouch for.
   */
  statistics: Record<number, RoutineStatistics>;

  /**
   * A failed statistics read.
   *
   * Kept apart from `error` because the two failures mean different things to
   * the page: `error` is "there are no routines to show", this is "the
   * routines are fine, their figures are not". The cards ignore it and fall
   * back to the launch count on the row; the statistics panel, which is
   * nothing *but* these figures, reports it and offers a retry.
   */
  statisticsError: string | null;

  loadRoutines: () => Promise<void>;
  /** Re-read section 33's figures for every routine. */
  loadStatistics: () => Promise<void>;

  createRoutine: (input: NewRoutine) => Promise<RoutineWithActions>;
  updateRoutine: (id: number, updates: RoutineUpdate) => Promise<RoutineWithActions>;
  deleteRoutine: (id: number) => Promise<void>;

  /**
   * Run the routine, updating the panel as each action resolves.
   *
   * `options.task` is section 18's START TASK: the same launch, plus the task
   * it is for. Passing one makes the panel show the task and its focus length,
   * and emits a focus intent once the workspace is open — see
   * `launchRoutine`'s body for the Stage 5 seam. `options.planning` is section
   * 21's Start My Day, which does the same with a labelled planning session in
   * place of the task's.
   */
  launchRoutine: (id: number, options?: RoutineLaunchOptions) => Promise<void>;
  /** Section 32's Retry: run the failed actions again, and only those. */
  retryFailedActions: () => Promise<void>;
  /** Section 32's Continue: accept the partial result and move on. */
  continueRun: () => void;
  /** Close the launch panel. Refused while actions are still running. */
  closeRun: () => void;

  openStatistics: (id: number) => void;
  closeStatistics: () => void;
}

type Set = StoreApi<RoutineState>["setState"];

/**
 * The two execution calls, typed with a progress callback the service does
 * not currently take.
 *
 * `launchRoutine(id)` and `retryRoutineActions(routineId, actionIds)` answer
 * once, at the end; a function that ignores a parameter is assignable to a
 * type that declares it, so these bindings let the call sites below pass a
 * per-action callback that is simply never called. That is the seam a
 * per-action Tauri event would arrive through — `applyResult` already handles
 * outcomes landing one at a time — and it costs one type alias to leave open.
 */
type LaunchCommand = (
  id: number,
  onAction?: (result: ActionResult) => void,
) => Promise<RoutineRunResult>;

type RetryCommand = (
  routineId: number,
  actionIds: number[],
  onAction?: (result: ActionResult) => void,
) => Promise<RoutineRunResult>;

const launch: LaunchCommand = launchRoutineCommand;
const retry: RetryCommand = retryRoutineActions;

/**
 * Identifies the current run.
 *
 * Every launch and retry takes a new token, and results are dropped the
 * moment the token they started with is no longer the live one — which is how
 * a run the user closed, or replaced with another launch, stops writing into
 * a panel that has moved on. It lives outside the store because nothing
 * renders it.
 */
let runToken = 0;

export const useRoutineStore = create<RoutineState>((set, get) => ({
  routines: [],
  isLoading: true,
  error: null,
  run: null,
  statisticsRoutineId: null,
  statistics: {},
  statisticsError: null,

  async loadRoutines() {
    // The skeleton is for the first read only. A re-read after a launch or a
    // save should refresh the cards in place, not blank the page.
    set({ isLoading: get().routines.length === 0, error: null });
    try {
      set({ routines: await listRoutines(), isLoading: false, error: null });
    } catch (cause) {
      set({ isLoading: false, error: String(cause) });
      return;
    }

    // Separately, and after the list has already been set: statistics are a
    // second query, and a routine you cannot see the focus time of is far
    // better than a page of routines you cannot see at all.
    await get().loadStatistics();
  },

  /**
   * Section 33's figures for every routine, in one query.
   *
   * A failure leaves the previous figures in place and is silent on the
   * cards, which fall back to the launch count on the row. It is *not*
   * silent in the store, though: the statistics panel is made of nothing
   * else, and before Stage 13 a failure here left that panel showing its
   * skeleton for ever with no way to ask again.
   */
  async loadStatistics() {
    set({ statisticsError: null });
    try {
      const statistics = await listRoutineStatistics();
      set({
        statistics: Object.fromEntries(
          statistics.map((entry) => [entry.routineId, entry]),
        ),
        statisticsError: null,
      });
    } catch (cause) {
      set({ statisticsError: String(cause) });
    }
  },

  async createRoutine(input) {
    const created = await createRoutineCommand(input);
    await get().loadRoutines();
    announceDataChanged("routines");
    return created;
  },

  async updateRoutine(id, updates) {
    const updated = await updateRoutineCommand(id, updates);
    await get().loadRoutines();
    announceDataChanged("routines");
    return updated;
  },

  async deleteRoutine(id) {
    await deleteRoutineCommand(id);

    // A deleted routine's open statistics panel goes with it.
    if (get().statisticsRoutineId === id) set({ statisticsRoutineId: null });

    await get().loadRoutines();
    announceDataChanged("routines");
  },

  async launchRoutine(id, options = {}) {
    if (get().run?.status === "running") return;

    const routine = get().routines.find((candidate) => candidate.id === id);
    if (!routine) return;

    const task = options.task ?? null;
    const planning = task ? null : (options.planning ?? null);
    const token = ++runToken;

    // Every action is on screen from the first frame, greyed out and waiting,
    // so the panel does not grow line by line as it runs.
    set({
      run: {
        routineId: routine.id,
        routineName: routine.name,
        routineIcon: routine.icon,
        status: "running",
        task,
        planning,
        actions: markNextRunning(
          routine.actions.map((action) => ({
            action,
            status: "pending",
            message: null,
          })),
        ),
      },
    });

    try {
      const result = await launch(id, (action) =>
        applyResult(set, token, action),
      );
      applyResults(set, token, result.actions);
    } catch (cause) {
      // The command itself failed — the routine never ran — which is a
      // different thing from an action failing, and the only case where the
      // panel has nothing per-action to say.
      failWholeRun(set, token, String(cause));
    }

    settle(set, token);

    // The workspace is open; the session it was opened for is what comes
    // next — section 18's "routine launches, focus timer starts, task linked",
    // in that order. Emitted after the run rather than before it so the timer
    // does not start against a workspace that is still opening, and emitted
    // even on a partial run because section 87 is clear that one app failing
    // to open is not a verdict on the launch.
    //
    // `useFocusLifecycle` subscribes and starts the session; see
    // `src/lib/focus-intent.ts` for why it is announced rather than started
    // here.
    if (task && token === runToken) {
      requestFocus({
        taskId: task.taskId,
        taskTitle: task.title,
        label: null,
        minutes: task.focusMinutes,
        routineId: routine.id,
        routineName: routine.name,
      });
    }

    // Section 21's last line, "Start 10-minute planning session", in the same
    // place and on the same terms: after the workspace is open, and whether
    // or not all of it opened. It is an ordinary focus session attached to
    // the start-of-day routine, so it pays what any session pays and nothing
    // more (section 88) — pressing START MY DAY is itself worth only the
    // routine launch's own once-a-day XP.
    if (planning && token === runToken) {
      requestFocus({
        taskId: null,
        taskTitle: null,
        label: planning.label,
        minutes: planning.minutes,
        breakMinutes: null,
        routineId: routine.id,
        routineName: routine.name,
      });
    }

    // The launch is recorded by the backend whether or not its actions
    // worked, so the cards pick up the new count and "Last used" either way —
    // in this window and, since the popup of section 25 can launch too, in
    // the other one.
    void get().loadRoutines();
    announceDataChanged("routines");
    // Section 88's once-a-day +10, written by `prepare_launch` before any of
    // the actions ran. Announced for every launch: only the first of the day
    // pays, and the caller has no way to know which one that was.
    emitProgressChanged();
  },

  async retryFailedActions() {
    const run = get().run;
    if (!run || run.status === "running") return;

    const failedIds = run.actions
      .filter((entry) => entry.status === "failure")
      .map((entry) => entry.action.id);
    if (failedIds.length === 0) return;

    const token = ++runToken;

    set({
      run: {
        ...run,
        status: "running",
        actions: markNextRunning(
          run.actions.map((entry) =>
            failedIds.includes(entry.action.id)
              ? { ...entry, status: "pending" as const, message: null }
              : entry,
          ),
        ),
      },
    });

    try {
      const result = await retry(run.routineId, failedIds, (action) =>
        applyResult(set, token, action),
      );
      applyResults(set, token, result.actions);
    } catch (cause) {
      failWholeRun(set, token, String(cause), failedIds);
    }

    settle(set, token);
  },

  continueRun() {
    // Continue means "carry on without the action that failed" — the routine
    // has already run everything it could, so there is nothing left to do but
    // put the panel away.
    get().closeRun();
  },

  closeRun() {
    if (get().run?.status === "running") return;
    // Stops any straggler from writing into a panel that is no longer open.
    runToken += 1;
    set({ run: null });
  },

  openStatistics(id) {
    set({ statisticsRoutineId: id });
  },

  closeStatistics() {
    set({ statisticsRoutineId: null });
  },
}));

/* -------------------------------------------------------------------------- */
/* Writing results into the run                                               */
/* -------------------------------------------------------------------------- */

/**
 * Records one action's outcome, and marks the next pending action as running.
 *
 * Results are matched by action id rather than by position, so they can
 * arrive in any order and a retry — which reports on a subset — lands on the
 * right lines.
 */
function applyResult(set: Set, token: number, result: ActionResult): void {
  if (token !== runToken) return;

  set((state) => {
    if (!state.run) return state;

    const actions: RoutineRunAction[] = state.run.actions.map((entry) =>
      entry.action.id === result.action_id
        ? { ...entry, status: result.status, message: result.message }
        : entry,
    );

    return { run: { ...state.run, actions: markNextRunning(actions) } };
  });
}

/** Records a batch of outcomes — the whole-run result the command answers with. */
function applyResults(set: Set, token: number, results: ActionResult[]): void {
  for (const result of results) applyResult(set, token, result);
}

/**
 * The first action still waiting is the one being worked on.
 *
 * Derived rather than tracked because it is only ever a guess about the
 * backend's progress: it says "this is next", and the real outcome overwrites
 * it as soon as one arrives.
 */
function markNextRunning(actions: RoutineRunAction[]): RoutineRunAction[] {
  const next = actions.findIndex((entry) => entry.status === "pending");
  if (next === -1) return actions;

  return actions.map((entry, index) =>
    index === next ? { ...entry, status: "running" } : entry,
  );
}

/**
 * Marks a run as failed outright, for when the command itself rejects.
 *
 * Only the actions that had not resolved are affected — anything the backend
 * already reported on stands.
 */
function failWholeRun(
  set: Set,
  token: number,
  message: string,
  onlyIds?: number[],
): void {
  if (token !== runToken) return;

  set((state) => {
    if (!state.run) return state;

    return {
      run: {
        ...state.run,
        actions: state.run.actions.map((entry) => {
          const isUnresolved = entry.status === "pending" || entry.status === "running";
          const isTargeted = !onlyIds || onlyIds.includes(entry.action.id);
          return isUnresolved && isTargeted
            ? { ...entry, status: "failure" as const, message }
            : entry;
        }),
      },
    };
  });
}

/** Settles the run: everything that was attempted worked, or some of it did not. */
function settle(set: Set, token: number): void {
  if (token !== runToken) return;

  // Decided inside the updater, acted on outside it: the updater has to stay
  // a pure function of the state it is handed.
  let settled: "complete" | "partial" | null = null;

  set((state) => {
    if (!state.run) return state;
    const failed = state.run.actions.some((entry) => entry.status === "failure");
    settled = failed ? "partial" : "complete";
    return { run: { ...state.run, status: settled } };
  });

  // The one moment a launch is over, and the only place it is decided — which
  // is why the cue is here rather than in the dialog. A launch started from
  // the tray or the quick launcher settles the same way, with section 32's
  // panel possibly never having been looked at.
  if (settled) playSound(settled === "partial" ? "routine-failed" : "routine-complete");
}
