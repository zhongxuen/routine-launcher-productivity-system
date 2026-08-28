import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { Plus } from "lucide-react";

import SubNav from "../components/common/SubNav";
import QuickAddTask from "../components/tasks/QuickAddTask";
import TaskEditDialog from "../components/tasks/TaskEditDialog";
import { Button } from "@/components/ui/button";
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
 */
function Tasks() {
  const openQuickAdd = useTaskStore((state) => state.openQuickAdd);

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
    </div>
  );
}

export default Tasks;
