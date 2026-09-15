import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Plus } from "lucide-react";

import SubNav from "../components/common/SubNav";
import RoutineLaunchDialog from "../components/routines/RoutineLaunchDialog";
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
 * Tasks section layout: the view tabs from section 15, the quick-add button
 * from section 16, the edit dialog, and the active view via <Outlet />. Each
 * sub-route reads its own view from SQLite through `useTaskView`, so switching
 * tabs is a fresh read rather than a re-filter.
 *
 * The quick-add *dialog*, and the `Ctrl+N` that opens it, are not here: they
 * belong to every page, so `AppLayout` mounts them (see
 * `useQuickAddShortcut`). The button below raises that same dialog through
 * the task store's `openQuickAdd`.
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
      <TaskEditDialog />
      {/* Section 18's START TASK opens the section 32 launch panel, so the
          Tasks section hosts it the same way the Routines section does. */}
      <RoutineLaunchDialog />
    </div>
  );
}

export default Tasks;
