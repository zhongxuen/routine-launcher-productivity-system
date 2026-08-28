import { formatRelativeDate, groupByCompletionDate } from "@/lib/task-utils";
import { useTaskView } from "@/hooks/useTaskView";

import TaskSection from "./TaskSection";
import TaskViewBody from "./TaskViewBody";
import TaskViewHeader from "./TaskViewHeader";

/**
 * Completed task history (section 15), newest day first. Each row carries its
 * completion time — written by the backend when the task entered `completed`
 * — and the focus-time placeholder from section 17.
 */
function TasksCompleted() {
  const { tasks, isLoading, error, reload } = useTaskView("completed");
  const groups = groupByCompletionDate(tasks);

  return (
    <div className="flex flex-col gap-6 py-2">
      <TaskViewHeader eyebrow="COMPLETED" subtitle={`${tasks.length} finished`} />

      <TaskViewBody
        isLoading={isLoading}
        error={error}
        onRetry={reload}
        isEmpty={groups.length === 0}
        emptyTitle="No completed tasks yet."
      >
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <TaskSection
              key={group.key}
              heading={group.key ? formatRelativeDate(group.key) : "Earlier"}
              tasks={group.tasks}
            />
          ))}
        </div>
      </TaskViewBody>
    </div>
  );
}

export default TasksCompleted;
