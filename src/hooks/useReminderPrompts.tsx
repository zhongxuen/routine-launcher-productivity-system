/**
 * The app shell's end of section 24: reminders arriving, and Start Task
 * actually starting one.
 *
 * A reminder is delivered twice over — once as an OS notification, once as
 * `notification://reminder-fired` — because no desktop platform can put
 * section 24's three buttons on the toast itself. This hook is what turns the
 * second half into those buttons: one persistent toast per reminder, drawn by
 * `ReminderPrompt`, whether the reminder came from the background scheduler,
 * from a snooze coming back, or from the catch-up check below.
 *
 * ## Start Task
 *
 * Start Task is section 18's START TASK, and it needs somewhere to happen.
 * The launch panel (section 32's checklist, `RoutineLaunchDialog`) is mounted
 * by the Tasks, Routines and Dashboard pages, and the session it ends in is
 * started by `useFocusLifecycle` in this window. So it is not enough to fire
 * the launch and hope:
 *
 * ```text
 * focus the window ▶ read the task ▶ go to its view ▶ call out the row
 *                                                   ▶ launch its routine
 * ```
 *
 * Each step is worth its line. **Focus**, because the reminder may have been
 * acted on from the popup, which is always-on-top and sitting over the window
 * the work is about to happen in. **Read**, because a notification carries
 * only what a notification needs, and starting a task needs the routine and
 * the estimate the session is sized from. **Go**, because a launch started
 * from Settings would run with nothing on screen to report it. **Call out**,
 * because "scoped to that task" has to survive the list arriving a moment
 * later — see `taskStore.revealTask`. And the routine is launched *last*, so
 * the navigation has had a chance to mount the panel that reports it.
 *
 * A task with no routine has nothing to launch, and that is not a failure:
 * the window still comes forward on the task, which is the whole of what
 * Start Task can honestly mean for it.
 *
 * ## Catching up
 *
 * Rust checks for owed reminders every 30 seconds regardless. `checkNow` is
 * for the two moments where waiting would look broken — the app starting, and
 * the user coming back to it — and its *return value is deliberately
 * ignored*: the check emits the same `reminder-fired` event the scheduler
 * does, so reading the answer as well would raise every prompt twice.
 */

import { useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import ReminderPrompt from "@/components/notifications/ReminderPrompt";
import { useReminderActions } from "@/hooks/useReminderActions";
import { startTaskNow } from "@/hooks/useStartTask";
import { onReminderHandedOff, onReminderHandled } from "@/lib/reminder-events";
import { todayKey } from "@/lib/task-utils";
import { checkTaskReminders, onReminderFired } from "@/services/notificationService";
import { focusMainWindow } from "@/services/popupService";
import { getTask } from "@/services/taskService";
import { useRoutineStore } from "@/stores/routineStore";
import { useTaskStore } from "@/stores/taskStore";
import type { ReminderNotification } from "@/types/notification";
import type { Task } from "@/types/task";

/** One toast per task, so a snooze coming back replaces its own prompt. */
const promptId = (taskId: number) => `reminder-${taskId}`;

export function useReminderPrompts(): void {
  const navigate = useNavigate();

  /**
   * Start Task, from the reminder's point of view: take the user to the task
   * and set it going.
   *
   * Rejects with a user-presentable message when the task has gone, which the
   * prompt shows while staying open — the reminder is still owed, and Snooze
   * and Dismiss are still honest things to offer for it.
   */
  const startFromReminder = useCallback(
    async (taskId: number) => {
      // The window comes forward before anything is read, so a slow query
      // does not leave the user looking at whatever was in front of the app
      // when they pressed the button.
      await focusMainWindow().catch((cause) => {
        // A window that would not come forward is still a window the user can
        // reach. The launch below is the part worth failing over.
        console.error("Could not bring the app forward:", cause);
      });

      const task = await getTask(taskId);
      if (!task) throw new Error("That task is no longer there.");

      navigate(viewPathFor(task));
      useTaskStore.getState().revealTask(task.id);

      if (task.routine_id === null) return;

      // `startTaskNow` looks the routine up in the store rather than
      // re-reading it, and the page just navigated to has not had a chance to
      // load one yet — the reminder could have been acted on from Settings.
      await useRoutineStore.getState().loadRoutines();
      startTaskNow(task);
    },
    [navigate],
  );

  const onStartTask = useCallback(
    (reminder: ReminderNotification) => startFromReminder(reminder.task_id),
    [startFromReminder],
  );

  const { runAction } = useReminderActions({ onStartTask });

  const raise = useCallback(
    (reminder: ReminderNotification) => {
      const id = promptId(reminder.task_id);

      toast.custom(
        () => (
          <ReminderPrompt
            reminder={reminder}
            onAction={(action) => runAction(reminder, action)}
            onClose={() => toast.dismiss(id)}
          />
        ),
        // A reminder that expired unread is a reminder that did not happen.
        { id, duration: Infinity },
      );
    },
    [runAction],
  );

  // Reminders as they are delivered.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void onReminderFired(raise)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((cause) => {
        // Without this the app is only as good as the OS toast, which has no
        // buttons — worth logging loudly, not worth an error in the user's
        // face.
        console.error("Could not subscribe to reminders:", cause);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [raise]);

  // Anything already owed when this window appeared, and again whenever the
  // user comes back to it — a reminder owed a minute ago should not have to
  // wait out the next poll just because the app was in the background.
  useEffect(() => {
    function catchUp() {
      void checkTaskReminders().catch((cause) => {
        console.error("Could not check for reminders:", cause);
      });
    }

    catchUp();
    window.addEventListener("focus", catchUp);
    return () => window.removeEventListener("focus", catchUp);
  }, []);

  // The popup dealt with a reminder this window is also showing.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void onReminderHandled((taskId) => toast.dismiss(promptId(taskId)))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((cause) => {
        console.error("Could not listen for reminders handled elsewhere:", cause);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // The popup's Start Task. It can neither launch a routine nor start a
  // session, so it asks this window to — see `src/lib/reminder-events.ts`.
  // The popup has put itself away by the time this runs, which is why the
  // report belongs here.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void onReminderHandedOff((taskId) => {
      void startFromReminder(taskId).catch((cause) => {
        toast.error("Could not start that task", { description: String(cause) });
      });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((cause) => {
        console.error("Could not listen for tasks handed over by the popup:", cause);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [startFromReminder]);
}

/**
 * The view a task can be found in — where Start Task sends the window.
 *
 * The same rule the store's own view filters apply (`filterForView` in
 * `src/stores/taskStore.ts`), so the row really is in the list the user lands
 * on. A reminder always implies a due date, which makes Today and Upcoming
 * the two answers that matter; the other two are here because a task can be
 * finished, or have its date cleared, between the reminder firing and the
 * button being pressed.
 */
function viewPathFor(task: Task): string {
  if (task.status === "completed") return "/tasks/completed";
  if (task.due_date === null) return "/tasks/inbox";
  return task.due_date <= todayKey() ? "/tasks/today" : "/tasks/upcoming";
}
