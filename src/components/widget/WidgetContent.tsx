import { useCallback, useEffect } from "react";

import { useFocusSync } from "@/hooks/useFocusSync";
import { useWindowSync } from "@/hooks/useWindowSync";
import { onWidgetShown, type WidgetMode } from "@/services/widgetService";
import { useFocusStore } from "@/stores/focusStore";
import { useRoutineStore } from "@/stores/routineStore";
import { useTaskStore } from "@/stores/taskStore";

import WidgetCombinedMode from "./WidgetCombinedMode";
import WidgetFocusMode from "./WidgetFocusMode";
import WidgetRoutineMode from "./WidgetRoutineMode";
import WidgetTaskMode from "./WidgetTaskMode";

interface WidgetContentProps {
  /** Which of section 26's four layouts is on screen. Chosen in Settings. */
  mode: WidgetMode;
}

/**
 * Whichever of section 26's four modes the user picked, and everything that
 * keeps it honest.
 *
 * The switch at the bottom is the small half. The large half is that this is
 * a *second window*, with a second webview holding a second copy of every
 * store, and the whole point of a widget is that it sits there for hours
 * while the user works somewhere else. Four things stop it drifting:
 *
 * 1. **`useWindowSync`** — a task ticked off or a routine launched in the
 *    main window announces itself, and this one re-reads. The reverse is
 *    already true: the writes the widget makes go through the same stores,
 *    which announce them. See `src/lib/window-sync.ts`.
 * 2. **`useFocusSync`** — the same for the running clock, which needs its
 *    live state carried rather than re-read, because pausing is not something
 *    `focus_sessions` records. See `src/lib/focus-sync.ts`.
 * 3. **`widget://shown`** — a hidden widget's webview is never torn down, so
 *    one put away yesterday comes back holding yesterday's list. Rust says
 *    when it is shown again and everything is re-read.
 * 4. **The DOM `focus` event** — the cheapest catch-all, for anything the
 *    other three miss. Clicking into a window that has been sitting on the
 *    desktop since this morning is the moment its list is most likely to be
 *    wrong, and it costs one local query.
 *
 * The reload below asks only for what the current mode shows: a focus widget
 * has no reason to run the `today` query every time the user clicks on it, and
 * a widget is the one surface in the app that is asked to do this all day.
 * `useWindowSync` is coarser than that — it re-reads both stores on any
 * announcement — because a hook cannot be called conditionally and one local
 * query is not worth restructuring this around.
 */
function WidgetContent({ mode }: WidgetContentProps) {
  useWindowSync();
  useFocusSync();

  const needsTasks = mode === "task" || mode === "combined";
  const needsRoutines = mode === "routine";
  const needsFocus = mode === "focus" || mode === "combined";

  const reload = useCallback(() => {
    // The backend's `today` view — the same query the dashboard, /tasks/today
    // and the popup run, so the four can never disagree about what today is.
    if (needsTasks) void useTaskStore.getState().loadView("today");
    if (needsRoutines) void useRoutineStore.getState().loadRoutines();
    // A no-op when a session is already on the clock, so this is safe to call
    // as often as the widget is looked at.
    if (needsFocus) void useFocusStore.getState().restoreSession();
  }, [needsTasks, needsRoutines, needsFocus]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void onWidgetShown(reload)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((cause: unknown) => {
        // A widget that cannot hear this is a re-read behind until the next
        // time it is clicked on, which the listener below covers.
        console.error("Could not listen for the widget being shown:", cause);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reload]);

  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  switch (mode) {
    case "focus":
      return <WidgetFocusMode />;
    case "routine":
      return <WidgetRoutineMode />;
    case "combined":
      return <WidgetCombinedMode />;
    case "task":
    default:
      // `task` is the stored default, and the fallback for a `settings` row
      // that names a mode this build does not have — a widget with no layout
      // is not a state worth being able to reach.
      return <WidgetTaskMode />;
  }
}

export default WidgetContent;
