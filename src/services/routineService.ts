/**
 * Typed wrappers around the routine Tauri commands.
 *
 * This is the "Service" layer of React UI -> Service -> Tauri Command ->
 * Rust -> SQLite / Windows (development-plan.md section 86): components
 * import from here and never call `invoke` themselves, and no component ever
 * touches the OS directly.
 *
 * Every command rejects with a plain, user-presentable string on failure
 * (blank name, a timer target that is not a number of minutes, a routine that
 * no longer exists, ...), so callers can surface `String(error)` straight to
 * a toast.
 *
 * The one exception is {@link launchRoutine}: launching *resolves* even when
 * actions failed, because a partly-successful routine is a result to render
 * (section 32's "3 / 4 actions completed"), not an error to throw. It rejects
 * only when the routine itself could not be read.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  NewRoutine,
  NewRoutineAction,
  RoutineAction,
  RoutineActionUpdate,
  RoutineRunResult,
  RoutineTimerRequest,
  RoutineUpdate,
  RoutineWithActions,
} from "@/types/routine";

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

/**
 * Every routine with its actions attached, most-recently-launched first so
 * the workspaces actually in use stay at the top of the section 29 list.
 * Routines that have never run follow, newest first.
 */
export async function listRoutines(): Promise<RoutineWithActions[]> {
  return invoke<RoutineWithActions[]>("list_routines");
}

/** Returns the routine and its actions, or `null` if it no longer exists. */
export async function getRoutine(id: number): Promise<RoutineWithActions | null> {
  return invoke<RoutineWithActions | null>("get_routine", { id });
}

/**
 * Creates a routine and its actions together, in the order given. Only `name`
 * is required — a routine with no actions yet is a valid draft.
 */
export async function createRoutine(routine: NewRoutine): Promise<RoutineWithActions> {
  return invoke<RoutineWithActions>("create_routine", { routine });
}

/**
 * Applies a partial update and returns the routine as stored. Omitted fields
 * are left alone and `null` clears a field; passing `actions` replaces the
 * whole list — see {@link RoutineUpdate}.
 */
export async function updateRoutine(
  id: number,
  updates: RoutineUpdate,
): Promise<RoutineWithActions> {
  return invoke<RoutineWithActions>("update_routine", { id, updates });
}

/**
 * Deletes a routine and its actions. Tasks and focus sessions that referenced
 * it are kept and simply lose the link.
 */
export async function deleteRoutine(id: number): Promise<void> {
  return invoke<void>("delete_routine", { id });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * The routine's actions in run order. `getRoutine` already includes these —
 * use this only when refreshing the action list on its own.
 */
export async function listRoutineActions(
  routineId: number,
): Promise<RoutineAction[]> {
  return invoke<RoutineAction[]>("list_routine_actions", {
    routineId,
  });
}

/**
 * Appends an action, or inserts it at `action.sort_order` when one is given.
 * The returned action carries its real final position.
 */
export async function addRoutineAction(
  routineId: number,
  action: NewRoutineAction,
): Promise<RoutineAction> {
  return invoke<RoutineAction>("add_routine_action", { routineId, action });
}

/**
 * Edits one action. Changing `type` re-validates `target` against the new
 * type, and `sort_order` moves the action to that position.
 */
export async function updateRoutineAction(
  id: number,
  updates: RoutineActionUpdate,
): Promise<RoutineAction> {
  return invoke<RoutineAction>("update_routine_action", { id, updates });
}

export async function deleteRoutineAction(id: number): Promise<void> {
  return invoke<void>("delete_routine_action", { id });
}

/**
 * Sets the run order from a full list of the routine's action ids — what
 * drag-to-reorder (section 31) should send on drop. The list must name every
 * action of the routine exactly once.
 */
export async function reorderRoutineActions(
  routineId: number,
  actionIds: number[],
): Promise<RoutineAction[]> {
  return invoke<RoutineAction[]>("reorder_routine_actions", {
    routineId,
    actionIds,
  });
}

/**
 * Swaps the whole action list for a new one, in the order given — the
 * builder's Save button when the routine's name and icon have not changed.
 */
export async function replaceRoutineActions(
  routineId: number,
  actions: NewRoutineAction[],
): Promise<RoutineAction[]> {
  return invoke<RoutineAction[]>("replace_routine_actions", {
    routineId,
    actions,
  });
}

/** Turns a single action on or off without deleting it. */
export async function setRoutineActionEnabled(
  id: number,
  enabled: boolean,
): Promise<RoutineAction> {
  return updateRoutineAction(id, { enabled });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Launches a routine: records the launch and runs every action in order.
 *
 * One failed action never stops the rest (section 87), so this resolves with
 * a result describing all of them — `actions[]` for the per-step checklist,
 * `completed_label` for "3 / 4 actions completed", and `summary` for the
 * sentence underneath. Check `failed > 0` rather than catching.
 *
 * `launch_count` and `last_launched_at` on the result are already updated,
 * so the statistics in section 33 can be refreshed without re-fetching.
 */
export async function launchRoutine(id: number): Promise<RoutineRunResult> {
  return invoke<RoutineRunResult>("launch_routine", { id });
}

/**
 * Re-runs just the given actions — the Retry button in section 32.
 *
 * This is not a new launch: `launch_count` is left alone, because retrying
 * the one app that failed to open is still the same trip to the workspace.
 * The result covers only the actions retried, so merge it into the existing
 * one by `action_id` rather than replacing it.
 */
export async function retryRoutineActions(
  routineId: number,
  actionIds: number[],
): Promise<RoutineRunResult> {
  return invoke<RoutineRunResult>("retry_routine_actions", {
    routineId,
    actionIds,
  });
}

/** Convenience for retrying every action that failed in a previous run. */
export async function retryFailedActions(
  result: RoutineRunResult,
): Promise<RoutineRunResult> {
  const failed = result.actions
    .filter((action) => action.status === "failure")
    .map((action) => action.action_id);

  return retryRoutineActions(result.routine_id, failed);
}

/**
 * Subscribes to the timer requests a routine emits, one per `timer` action it
 * ran. Stage 4's focus timer is the real consumer; until then this is what
 * puts "⏱ Focus timer started" on the launch panel.
 *
 * Returns the unsubscribe function — call it on unmount.
 */
export async function onRoutineTimerRequested(
  handler: (request: RoutineTimerRequest) => void,
): Promise<UnlistenFn> {
  return listen<RoutineTimerRequest>("routine://timer-requested", (event) =>
    handler(event.payload),
  );
}

// ---------------------------------------------------------------------------
// Command-action opt-in (development-plan.md section 66)
// ---------------------------------------------------------------------------

/**
 * Whether `command` actions are allowed to run. False on a fresh install:
 * until this is switched on, command actions can be saved but are reported as
 * `skipped` every time a routine runs.
 */
export async function getCommandActionsEnabled(): Promise<boolean> {
  return invoke<boolean>("get_command_actions_enabled");
}

/**
 * Turns command execution on or off for every routine at once. Setting it to
 * false is the kill switch: command actions stay saved but stop running, so
 * the user never has to edit routines to make the app safe again.
 *
 * The UI should confirm before enabling and make clear what it allows — the
 * exact command line is always shown on the launch result
 * (`ActionResult.echoed_command`), run or not.
 */
export async function setCommandActionsEnabled(
  enabled: boolean,
): Promise<boolean> {
  return invoke<boolean>("set_command_actions_enabled", { enabled });
}
