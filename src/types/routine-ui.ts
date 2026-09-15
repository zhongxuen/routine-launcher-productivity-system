/**
 * Types the routine UI owns.
 *
 * `src/types/routine.ts` mirrors the Rust payloads and is the wire contract;
 * nothing in this file crosses the `invoke` boundary. What lives here is the
 * state a *view* needs and the backend has no opinion about: an action that
 * has not been attempted yet, and the section 33 statistics block.
 *
 * Keeping the two apart is what lets the backend's types be regenerated or
 * edited without touching the launch panel, and vice versa.
 */

import type { ActionStatus, RoutineAction } from "@/types/routine";

/* -------------------------------------------------------------------------- */
/* A launch in progress (development-plan.md section 32)                      */
/* -------------------------------------------------------------------------- */

/**
 * An action's state in the launch panel.
 *
 * The backend's three outcomes plus the two states an action passes through
 * before there is an outcome to report — which only the UI ever sees, because
 * only the UI is watching.
 */
export type ActionRunStatus = "pending" | "running" | ActionStatus;

export interface RoutineRunAction {
  action: RoutineAction;
  status: ActionRunStatus;
  /** Why it failed, or why it was skipped. Null until there is a reason. */
  message: string | null;
}

/**
 * How the run as a whole is doing.
 *
 * - `running` — actions are still resolving
 * - `complete` — everything attempted succeeded ("Ready.")
 * - `partial` — at least one action failed; section 32's Retry / Continue
 *
 * There is no terminal "failed" state on purpose. A routine that lost one
 * action still opened the rest, and section 87 is explicit that a failure is
 * a per-action fact, not a verdict on the launch.
 */
export type RoutineRunStatus = "running" | "complete" | "partial";

/**
 * The task a launch was started from (section 18's START TASK), when it was
 * started from one rather than from the routine's own card.
 *
 * Copied into the run for the same reason the routine's name is: the panel
 * has to keep reading correctly even if the task is edited underneath it.
 */
export interface RoutineRunTask {
  taskId: number;
  title: string;
  /**
   * The focus length this task asks for, in minutes, or null when neither the
   * task's estimate nor the routine's timer named one. Only ever *displayed*
   * here — the session itself is started by whoever subscribes to
   * `requestFocus` in `src/lib/focus-intent.ts`, which the launch fires once
   * its actions are done. A null means no session is started either.
   */
  focusMinutes: number | null;
}

/**
 * The session a Start My Day launch leads to (section 21's "Start 10-minute
 * planning session"): a labelled one, attached to the routine rather than to
 * a task. Displayed by the panel and started, like a task's, through
 * `requestFocus` once the actions are done.
 */
export interface RoutineRunPlanning {
  /** What the clock calls the session — `"Planning"`. */
  label: string;
  minutes: number;
}

/**
 * What a launch is for, beyond opening the workspace. At most one of the two:
 * a task (section 18) or Start My Day's planning session (section 21).
 * Neither is a routine started from its own card.
 */
export interface RoutineLaunchOptions {
  task?: RoutineRunTask;
  planning?: RoutineRunPlanning;
}

/**
 * One launch, as the panel in section 32 renders it.
 *
 * The routine's name and icon are copied in rather than looked up by id, so
 * the panel keeps reading correctly if the routine is edited or deleted while
 * the run is still on screen.
 *
 * The run holds outcomes only. The "3 / 4 actions completed" line is counted
 * off this list by `runCounts`, not taken from the backend's own
 * `completed_label`, because a retry reports on the actions it retried — one
 * line about one action — while the panel is still showing the whole routine.
 */
export interface RoutineRun {
  routineId: number;
  routineName: string;
  routineIcon: string | null;
  actions: RoutineRunAction[];
  status: RoutineRunStatus;
  /**
   * The task this launch is serving, or null for a routine started on its
   * own. Present is what turns section 32's launch panel into section 18's
   * combined "START TASK" feedback — same checklist, plus the task it is for
   * and the focus session it leads to.
   */
  task: RoutineRunTask | null;
  /** Start My Day's planning session, or null. Never set alongside `task`. */
  planning: RoutineRunPlanning | null;
}

/* -------------------------------------------------------------------------- */
/* Statistics (development-plan.md section 33)                                */
/* -------------------------------------------------------------------------- */

/*
 * Section 33's five figures used to be declared here, with three of them
 * nullable because nothing measured them yet.
 *
 * They now live in `@/types/analytics` as `RoutineStatistics`, mirroring what
 * `services/analytics.rs` computes. The move is the point: while the panel
 * derived what it could from the routine row, the shape belonged to the UI;
 * now that focus time, average session and tasks completed are all read
 * across `focus_sessions` and `tasks`, the shape belongs to the payload that
 * carries them. `focusSeconds` and `tasksCompleted` are consequently plain
 * numbers rather than `number | null` — a zero there is a measured zero.
 */
