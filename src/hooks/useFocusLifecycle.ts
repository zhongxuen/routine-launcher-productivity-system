/**
 * Everything about a focus session that outlives the page it started on.
 *
 * Three things, all mounted from the app shell rather than from the Focus
 * page, because a session started from a task (section 19) runs while the
 * user is anywhere in the app:
 *
 * 1. **Picking a running session back up on load.** `FocusTimer` is only
 *    mounted while the user is looking at it, and a session that survived a
 *    reload has to be found before anyone can look — and the reloaded window
 *    could have landed on any page.
 * 2. **Starting the session a task asked for.** This is the other end of
 *    `src/lib/focus-intent.ts`: START TASK launches the routine's workspace
 *    and then emits an intent, which is turned into a running clock here.
 *    Section 18's flow — routine launches, focus timer starts, task linked —
 *    completes at this line.
 * 3. **Re-reading a task once its session is recorded.** A task's
 *    `focus_seconds` is summed by the backend from the sessions that named
 *    it, so section 17's "Actual focus time" appears on the row as soon as
 *    the list is read again. `src/lib/focus-events.ts` is what says when.
 *
 * Two and three are why this is a hook in the shell and not code in a store:
 * they join the task side to the focus side, and neither store should have to
 * know the other exists.
 *
 * The *end* of a session's life is not here, and deliberately so. A session
 * the window closes on is recorded in Rust (`on_window_event` in
 * `src-tauri/src/lib.rs`), because the JS way of hooking a close —
 * `onCloseRequested`, which closes the window itself by calling `destroy()` —
 * needs a permission `core:window:default` does not grant. A close handler
 * that could not close the window would be a far worse bug than the pause
 * arithmetic Rust has to do without.
 *
 * That also makes restoring safe: `close_abandoned` runs at startup before
 * any window can ask, so anything a previous run left open has already been
 * recorded as interrupted, and a session `restoreSession` finds is always one
 * this run started and genuinely still being focused on.
 */

import { useEffect } from "react";

import { onFocusSessionEnded } from "@/lib/focus-events";
import { onFocusIntent } from "@/lib/focus-intent";
import { startFocusFor } from "@/hooks/useStartFocus";
import { useFocusStore } from "@/stores/focusStore";
import { useTaskStore } from "@/stores/taskStore";

export function useFocusLifecycle(): void {
  const restoreSession = useFocusStore((state) => state.restoreSession);

  useEffect(() => {
    void restoreSession();
  }, [restoreSession]);

  // Section 18/89's chain, closed: the workspace has finished opening, so the
  // session it was opened for begins. `routineStore` emits the intent after
  // the run settles — the timer should not start against a workspace that is
  // still opening — and it arrives here carrying the task, the routine and
  // the length, which is exactly what a session is attached to and sized by.
  useEffect(
    () =>
      onFocusIntent((intent) => {
        // Nothing named a length: neither the task's estimate nor the
        // routine's own timer action. Section 88 would rather start no
        // session than invent one — a surprise 25-minute clock recorded
        // against a task nobody sized is worse than no clock at all. The
        // launch panel draws no timer line in this case either, so the two
        // agree.
        if (intent.minutes === null) return;

        void startFocusFor({
          minutes: intent.minutes,
          taskId: intent.taskId,
          taskTitle: intent.taskTitle,
          routineId: intent.routineId,
          routineName: intent.routineName,
        });
      }),
    [],
  );

  // A session that was against a task has just changed what that task's
  // focus time is. The row shows it (section 17), so the list re-reads —
  // rather than the store guessing at a figure the database owns.
  //
  // Unconditional beyond that: it is one local query, and a task list that is
  // not on screen re-reads on its next mount anyway.
  useEffect(
    () =>
      onFocusSessionEnded((session) => {
        if (session.task_id === null) return;
        void useTaskStore.getState().refresh();
      }),
    [],
  );
}
