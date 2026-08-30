import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTaskView } from "@/hooks/useTaskView";
import { groupByPriority, PRIORITY_HEADINGS } from "@/lib/task-utils";
import { useTaskStore } from "@/stores/taskStore";

import TaskSection from "./TaskSection";
import TaskViewBody from "./TaskViewBody";
import TaskViewHeader from "./TaskViewHeader";

/** Unscheduled tasks (section 15) — captured but not yet given a day. */
function TasksInbox() {
  const { tasks, isLoading, error, reload } = useTaskView("inbox");
  const openQuickAdd = useTaskStore((state) => state.openQuickAdd);
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
        emptyAction={
          <Button size="sm" variant="outline" onClick={openQuickAdd}>
            <Plus className="size-4" />
            Add a task
          </Button>
        }
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
