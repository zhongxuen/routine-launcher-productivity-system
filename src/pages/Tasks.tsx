import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Plus } from "lucide-react";

import SubNav from "../components/common/SubNav";
import RoutineLaunchDialog from "../components/routines/RoutineLaunchDialog";
import QuickAddTask from "../components/tasks/QuickAddTask";
import TaskEditDialog from "../components/tasks/TaskEditDialog";
import { Button } from "@/components/ui/button";
import { hasOpenOverlay, isTypingTarget } from "@/lib/keyboard";
import { useRoutineStore } from "@/stores/routineStore";
import { useTaskStore } from "@/stores/taskStore";

const SUB_NAV_ITEMS = [
  { to: "/tasks/today", label: "Today" },
  { to: "/tasks/upcoming", label: "Upcoming" },
  { to: "/tasks/inbox", label: "Inbox" },
  { to: "/tasks/completed", label: "Completed" },
  { to: "/tasks/recurring", label: "Recurring" },
];

/**
 * Tasks section layout: the view tabs from section 15, the quick-add
 * affordance from section 16, the edit dialog, and the active view via
 * <Outlet />. Each sub-route reads its own view from SQLite through
 * `useTaskView`, so switching tabs is a fresh read rather than a re-filter.
 *
 * Routines are read here too, once for the whole section: the task forms
 * offer them (section 18's optional Routine field), the rows name the one
 * they were given, and START TASK launches it. Doing it at the layout rather
 * than in each of those means one read per visit instead of one per row.
 */
function Tasks() {
  const openQuickAdd = useTaskStore((state) => state.openQuickAdd);
  const loadRoutines = useRoutineStore((state) => state.loadRoutines);

  useEffect(() => {
    void loadRoutines();
  }, [loadRoutines]);

  // Ctrl+N from anywhere on the Tasks page (section 16). Bound on the window so
  // it fires whatever has focus; the global-shortcut variant that works while
  // the app is in the background belongs to the Tauri stage.
  //
  // The three guards below are section 84's audit of this shortcut against
  // everything the app grew after Stage 8. It does not collide with the global
  // `Ctrl+Alt+Space` — `event.altKey` rules that combination out, and in any
  // case the launcher is a separate webview where this page is never mounted
  // — but it does reach places that did not exist when it was written:
  //
  // * **Dialogs.** The Tasks page now hosts three (quick-add, the task editor,
  //   the routine launch panel of section 32) and a routine launch can be in
  //   flight in the third. Opening quick-add over one of those would be a
  //   second modal on top of a modal.
  // * **Text fields.** Those dialogs are forms, and the Windows convention for
  //   `Ctrl+N` inside a field is that the field keeps it.
  // * **Held keys.** `repeat` is a key someone is leaning on, not a shortcut
  //   they are pressing.
  //
  // `event.code` rather than `event.key` for the same reason
  // `lib/shortcut-accelerator.ts` records codes: a shortcut is a position on
  // the keyboard. On a layout where N sits elsewhere, `key` would move the
  // shortcut out from under the `Ctrl+N` printed on the button below.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.code !== "KeyN" || event.repeat || event.defaultPrevented) return;
      if (hasOpenOverlay() || isTypingTarget(event.target)) return;

      event.preventDefault();
      openQuickAdd();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openQuickAdd]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <Button size="sm" variant="outline" onClick={openQuickAdd}>
          <Plus className="size-4" />
          Add Task
          {/* A reminder of the shortcut, not part of what the button is
              called: without this the button announces itself as "Add Task
              Ctrl+N", which is not a thing anyone would say. */}
          <kbd aria-hidden className="ml-1 rounded border px-1 text-[10px] text-muted-foreground">
            Ctrl+N
          </kbd>
        </Button>
      </div>

      <SubNav items={SUB_NAV_ITEMS} label="Task views" />
      <Outlet />
      <QuickAddTask />
      <TaskEditDialog />
      {/* Section 18's START TASK opens the section 32 launch panel, so the
          Tasks section hosts it the same way the Routines section does. */}
      <RoutineLaunchDialog />
    </div>
  );
}

export default Tasks;
