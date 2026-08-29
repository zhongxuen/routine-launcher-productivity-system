/**
 * Routine, routine-action and routine-execution types.
 *
 * The stored shapes mirror the Rust payloads in
 * `src-tauri/src/services/routines.rs` and
 * `src-tauri/src/services/routine_exec.rs` exactly, field name for field
 * name, so a value crossing the `invoke` boundary needs no reshaping in
 * either direction. Field names stay snake_case to match the columns in
 * development-plan.md sections 59-60.
 *
 * This file is the wire contract and nothing else. The state a *view* needs —
 * an action that has not been attempted yet, the section 33 statistics block —
 * lives in `src/types/routine-ui.ts`, so neither side has to move when the
 * other changes.
 *
 * `created_at`, `updated_at` and `last_launched_at` are UTC
 * `YYYY-MM-DD HH:MM:SS` strings written by SQLite, so convert them to local
 * time before display (`parseTimestamp` in `src/lib/task-utils.ts`).
 */

/* -------------------------------------------------------------------------- */
/* Stored shapes (development-plan.md sections 59-60)                         */
/* -------------------------------------------------------------------------- */

/** The action types from development-plan.md section 30, in builder order. */
export const ROUTINE_ACTION_TYPES = [
  "application",
  "url",
  "folder",
  "file",
  "timer",
  "command",
] as const;

export type RoutineActionType = (typeof ROUTINE_ACTION_TYPES)[number];

/** Display names for the wire values above — the section 31 type selector. */
export const ROUTINE_ACTION_TYPE_LABELS: Record<RoutineActionType, string> = {
  application: "Application",
  url: "URL",
  folder: "Folder",
  file: "File",
  timer: "Timer",
  command: "Command",
};

/** Longest timer a `timer` action may ask for, matching the backend. */
export const MAX_TIMER_MINUTES = 24 * 60;

/** One step of a routine, exactly as stored (section 60). */
export interface RoutineAction {
  id: number;
  routine_id: number;
  type: RoutineActionType;
  /**
   * What to act on: an executable path, a URL, a directory, a file, or — for
   * `timer` — the number of minutes as a string. Normalised by the backend,
   * so a URL saved as `github.com` reads back as `https://github.com`.
   */
  target: string;
  /** Extra command-line arguments; only used by `application` actions. */
  arguments: string | null;
  /** Dense `0..n-1`. List position and `sort_order` always agree. */
  sort_order: number;
  /**
   * A disabled action stays in the routine and is reported as `skipped` when
   * it runs, so a step can be parked without deleting it.
   */
  enabled: boolean;
}

/** A routine row on its own (section 59), without its actions. */
export interface Routine {
  id: number;
  name: string;
  description: string | null;
  /** Emoji or icon name, as picked in the section 31 builder. */
  icon: string | null;
  created_at: string;
  updated_at: string;
  /** Null until the routine has been launched at least once. */
  last_launched_at: string | null;
  launch_count: number;
}

/**
 * A routine with its ordered action list attached — what every read returns,
 * because a routine without its actions is not something the UI ever shows.
 */
export interface RoutineWithActions extends Routine {
  /** Always in run order. */
  actions: RoutineAction[];
}

/** A new action. Omitted fields fall back to the backend's defaults. */
export interface NewRoutineAction {
  type: RoutineActionType;
  target: string;
  arguments?: string | null;
  /**
   * The position to insert at. Only honoured by `addRoutineAction` — when
   * actions are sent as a list, position in the list wins.
   */
  sort_order?: number;
  /** Defaults to true. */
  enabled?: boolean;
}

export interface NewRoutine {
  name: string;
  description?: string | null;
  icon?: string | null;
  /** Stored in the order given. */
  actions?: NewRoutineAction[];
}

/**
 * A partial routine update: omitted fields are left alone, and passing `null`
 * clears `description` or `icon`.
 */
export interface RoutineUpdate {
  name?: string;
  description?: string | null;
  icon?: string | null;
  /**
   * Replaces the whole action list in one shot — what the builder's Save
   * button wants. Omit to leave the existing actions untouched.
   */
  actions?: NewRoutineAction[];
}

/**
 * A partial action update. `type` and `target` are validated together, so
 * switching a step to `timer` needs a target the new type accepts.
 *
 * `sort_order` is the position the action should end up at; the actions it
 * moves past shuffle around it.
 */
export interface RoutineActionUpdate {
  type?: RoutineActionType;
  target?: string;
  arguments?: string | null;
  sort_order?: number;
  enabled?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Execution results (development-plan.md sections 32 and 87)                 */
/* -------------------------------------------------------------------------- */

/** How a single action ended (section 87). */
export const ACTION_STATUSES = ["success", "failure", "skipped"] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];

/**
 * The per-action result of a launch, as the backend reports it.
 *
 * This is what came back from a run; `RoutineRunAction` in
 * `src/types/routine-ui.ts` is what is on screen. The store folds one into
 * the other.
 */
export interface ActionResult {
  action_id: number;
  type: RoutineActionType;
  target: string;
  /** Backend-derived short name. The UI prefers `actionLabel()`. */
  label: string;
  status: ActionStatus;
  /** Why it failed, or why it was skipped. Null on success. */
  message: string | null;
  /**
   * For `timer` actions: the focus length that was requested. The timer
   * itself arrives in Stage 4 — this is the signal that asks for it.
   */
  timer_minutes: number | null;
  /**
   * For `command` actions: the exact command line, echoed back whether it ran
   * or was skipped, so it can be shown verbatim (section 66).
   */
  echoed_command: string | null;
}

/** Everything one launch produced. */
export interface RoutineRunResult {
  routine_id: number;
  routine_name: string;
  /** Launch stats after this run. Unchanged by a retry. */
  launch_count: number;
  last_launched_at: string | null;
  /** Every action considered, in run order. */
  actions: ActionResult[];
  total: number;
  /** `total` minus skipped — the denominator in "3 / 4 actions completed". */
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** `"3 / 4 actions completed"`. */
  completed_label: string;
  /** A full sentence: `"Ready."`, or the count plus what went wrong. */
  summary: string;
  /** The first focus length any timer action asked for. */
  timer_minutes: number | null;
}

/**
 * Payload of the `routine://timer-requested` event, emitted once per timer
 * action a routine ran. Stage 4's focus timer listens for it.
 */
export interface RoutineTimerRequest {
  routine_id: number;
  routine_name: string;
  action_id: number;
  minutes: number;
}
