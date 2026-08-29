import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Plus } from "lucide-react";

import SubNav from "../components/common/SubNav";
import RoutineLaunchDialog from "../components/routines/RoutineLaunchDialog";
import QuickAddTask from "../components/tasks/QuickAddTask";
import TaskEditDialog from "../components/tasks/TaskEditDialog";
import { Button } from "@/components/ui/button";
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
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "n") return;

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
          <kbd className="ml-1 rounded border px-1 text-[10px] text-muted-foreground">Ctrl+N</kbd>
        </Button>
      </div>

      <SubNav items={SUB_NAV_ITEMS} />
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
