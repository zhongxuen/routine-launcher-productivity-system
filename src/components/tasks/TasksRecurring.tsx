import { useTaskView } from "@/hooks/useTaskView";

import TaskSection from "./TaskSection";
import TaskViewBody from "./TaskViewBody";
import TaskViewHeader from "./TaskViewHeader";

/**
 * Recurring tasks (section 15): one row per repeating series, not per
 * instance. The backend's `recurring` view returns each series' most recent
 * task — the live one, and the one tomorrow's is cloned from — so an edit
 * here changes the schedule and carries into the days that follow.
 */
function TasksRecurring() {
  const { tasks, isLoading, error, reload } = useTaskView("recurring");

  return (
    <div className="flex flex-col gap-6 py-2">
      <TaskViewHeader eyebrow="RECURRING" subtitle={`${tasks.length} repeating`} />

      <TaskViewBody
        isLoading={isLoading}
        error={error}
        onRetry={reload}
        isEmpty={tasks.length === 0}
        emptyTitle="No recurring tasks."
        emptyHint="Set a repeat when you add a task and its schedule shows up here."
      >
        <TaskSection heading="REPEATS" tasks={tasks} showDate showRecurrence />
      </TaskViewBody>
    </div>
  );
}

export default TasksRecurring;
