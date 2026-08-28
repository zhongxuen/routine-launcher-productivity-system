import { groupByPriority, PRIORITY_HEADINGS } from "@/lib/task-utils";
import { useTaskView } from "@/hooks/useTaskView";

import TaskSection from "./TaskSection";
import TaskViewBody from "./TaskViewBody";
import TaskViewHeader from "./TaskViewHeader";

/** Unscheduled tasks (section 15) — captured but not yet given a day. */
function TasksInbox() {
  const { tasks, isLoading, error, reload } = useTaskView("inbox");
  const groups = groupByPriority(tasks);

  return (
    <div className="flex flex-col gap-6 py-2">
      <TaskViewHeader eyebrow="INBOX" subtitle={`${tasks.length} unscheduled`} />

      <TaskViewBody
        isLoading={isLoading}
        error={error}
        onRetry={reload}
        isEmpty={groups.length === 0}
        emptyTitle="Inbox is empty."
        emptyHint="Tasks added without a due date land here."
      >
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <TaskSection
              key={group.key}
              heading={PRIORITY_HEADINGS[group.key]}
              tasks={group.tasks}
            />
          ))}
        </div>
      </TaskViewBody>
    </div>
  );
}

export default TasksInbox;
