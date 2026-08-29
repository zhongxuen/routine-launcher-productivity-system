/**
 * START TASK (development-plan.md sections 18 and 75).
 *
 * "Convert a to-do item directly into an executable work session": one click
 * launches the task's assigned routine, and the session that work happens in
 * is sized from the task itself.
 *
 * It lives here rather than in the task row because starting a task is one
 * rule — *which* routine, *how long* — and the row is not the only place that
 * wants it: the dashboard (section 21's "Start My Day"), section 24's
 * reminder prompt, the tray popup and the widget all start tasks, and none of
 * them should be re-deciding what starting one means.
 *
 * Two shapes of the same thing. {@link startTaskNow} is the rule;
 * {@link useStartTask} is the rule plus the one piece of state a *button*
 * needs, which is whether a launch is already running.
 */

import { toast } from "sonner";

import { focusMinutesFor } from "@/lib/focus-intent";
import { routineTimerMinutes } from "@/lib/routine-utils";
import { useRoutineStore } from "@/stores/routineStore";
import type { RoutineWithActions } from "@/types/routine";
import type { Task } from "@/types/task";

export interface StartTaskState {
  /**
   * Starts the task: launches its routine and asks for the focus session that
   * follows. A task with no routine, or one whose routine has gone missing,
   * is reported rather than silently doing nothing.
   */
  startTask: (task: Task) => void;
  /**
   * True while any launch is in flight. Only one routine runs at a time —
   * two workspaces fighting over the foreground is nobody's idea of focus —
   * so every START TASK button is disabled for the duration, not just the one
   * that was clicked.
   */
  isLaunching: boolean;
}

/**
 * Starting a task, with no component attached.
 *
 * The rule itself never needed one: every value it works from is read through
 * `getState` at the moment of the click, so nothing here has anything to
 * subscribe to. Exported separately because two of its callers are not
 * buttons — section 24's reminder prompt is one, and a hook that made the app
 * shell re-render on every action of a running routine would be paying for a
 * disabled state it does not draw.
 */
export function startTaskNow(task: Task): void {
  if (task.routine_id === null) return;

  // Read through `getState` rather than subscribing: the routine list is
  // only needed at the moment of the click, and a row that re-rendered on
  // every routine edit would be paying for something it never shows.
  const { launchRoutine, routines } = useRoutineStore.getState();
  const routine = routines.find((candidate) => candidate.id === task.routine_id);

  if (!routine) {
    // The task still points at a routine the list has not caught up with
    // — deleted in another view, or not loaded yet.
    toast.error("Could not start task", {
      description: "That routine is no longer available.",
    });
    return;
  }

  void launchRoutine(routine.id, {
    taskId: task.id,
    title: task.title,
    focusMinutes: focusMinutesFor(
      task.estimated_minutes,
      routineTimerMinutes(routine.actions),
    ),
  });
}

export function useStartTask(): StartTaskState {
  const isLaunching = useRoutineStore((state) => state.run?.status === "running");

  return { startTask: startTaskNow, isLaunching };
}

/**
 * Whether a task can be started right now: it has to name a routine, that
 * routine has to still exist, and it has to have something to launch.
 *
 * Exported alongside the hook so a row can decide whether to *draw* the
 * button from the same rule the hook enforces when it is pressed.
 */
export function startableRoutine(
  task: Task,
  routines: RoutineWithActions[],
): RoutineWithActions | null {
  if (task.routine_id === null) return null;
  return routines.find((routine) => routine.id === task.routine_id) ?? null;
}
