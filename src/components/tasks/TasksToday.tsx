import { differenceInCalendarDays } from "date-fns";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useDailyPlan } from "@/hooks/useDailyPlan";
import { useDayParam } from "@/hooks/useDayParam";
import { useTaskView } from "@/hooks/useTaskView";
import { splitPlan } from "@/lib/daily-plan";
import {
  formatDayHeading,
  groupByPriority,
  parseDateKey,
  PRIORITY_HEADINGS,
} from "@/lib/task-utils";
import { useTaskStore } from "@/stores/taskStore";

import DayNav from "./DayNav";
import PlanToday from "./PlanToday";
import RepeatsSection from "./RepeatsSection";
import TaskSection from "./TaskSection";
import TaskViewBody from "./TaskViewBody";
import TaskViewHeader from "./TaskViewHeader";

/** `TODAY`, `YESTERDAY`, `TOMORROW`, then `3 DAYS AGO` / `IN 3 DAYS`. */
function eyebrowFor(offset: number): string {
  if (offset === 0) return "TODAY";
  if (offset === -1) return "YESTERDAY";
  if (offset === 1) return "TOMORROW";
  return offset < 0 ? `${-offset} DAYS AGO` : `IN ${offset} DAYS`;
}

/** The empty state for the day on screen. Only today offers quick-add. */
function emptyCopy(offset: number, heading: string): { title: string; hint?: string } {
  if (offset === 0) {
    return { title: "Nothing scheduled for today.", hint: "Press Ctrl+N to add a task." };
  }
  if (offset < 0) {
    return { title: offset === -1 ? "Nothing was due yesterday." : `Nothing was due on ${heading}.` };
  }
  return { title: offset === 1 ? "Nothing scheduled for tomorrow." : `Nothing scheduled for ${heading}.` };
}

/**
 * The daily task view (section 14): today's work, plus anything still
 * unfinished from an earlier day, grouped by priority with a completion count
 * on top.
 *
 * The carry-forward and the overdue flags are the backend's `today` view —
 * they are computed against the user's local today on every read, so this
 * component only groups what it is given.
 *
 * Section 53's `< Today >` pages the same view through other days, with the
 * day kept in the URL (`?date=`, see `useDayParam`). Another day shows only
 * what was due on it. Nothing is carried over, because carry-over answers
 * "what do I still owe", and that is today's page's job. Two things differ
 * on other days:
 *
 * - **Earlier days.** Ticking a task off still stamps `completed_at` with the
 *   current time. The header says so, and nothing is backdated to the day
 *   being viewed.
 * - **Later days.** Repeating tasks are created on their own day, so a future
 *   day's instances do not exist yet. They are listed as a read-only Repeats
 *   group, and looking at them does not create them.
 *
 * Today's page also carries PLAN TODAY (sections 20 and 51) above the list,
 * and marks the tasks picked there. Other days do not: the plan is for the
 * day being worked through, and a past day's picks are history rather than
 * something to act on.
 */
function TasksToday() {
  const { date, dayKey, step, goToToday } = useDayParam();
  const { tasks, repeats, isLoading, error, reload } = useTaskView("today", date);
  const openQuickAdd = useTaskStore((state) => state.openQuickAdd);
  const groups = groupByPriority(tasks);

  const isToday = date === null;
  const plan = useDailyPlan(isToday ? dayKey : null);
  const priorityRanks = new Map(
    splitPlan(tasks, plan.taskIds).priorities.map((task, index) => [task.id, index + 1]),
  );

  const now = new Date();
  const day = parseDateKey(dayKey) ?? now;
  const offset = date === null ? 0 : differenceInCalendarDays(day, now);
  const heading = formatDayHeading(day);
  const empty = emptyCopy(offset, heading);

  const note =
    offset < 0
      ? `Ticking a task off here records it as completed now, not ${
          offset === -1 ? "yesterday" : `on ${heading}`
        }.`
      : undefined;

  return (
    <div className="flex flex-col gap-6 py-2">
      <TaskViewHeader
        eyebrow={eyebrowFor(offset)}
        subtitle={heading}
        tasks={tasks}
        note={note}
        actions={
          <DayNav
            isToday={isToday}
            onPrevious={() => step(-1)}
            onNext={() => step(1)}
            onToday={goToToday}
          />
        }
      />

      {isToday && (
        <PlanToday tasks={tasks} tasksLoading={isLoading} tasksError={error} plan={plan} />
      )}

      <TaskViewBody
        isLoading={isLoading}
        error={error}
        onRetry={reload}
        isEmpty={groups.length === 0 && repeats.length === 0}
        emptyTitle={empty.title}
        emptyHint={empty.hint}
        emptyAction={
          offset === 0 ? (
            <Button size="sm" variant="outline" onClick={openQuickAdd}>
              <Plus className="size-4" />
              Add a task
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <TaskSection
              key={group.key}
              heading={PRIORITY_HEADINGS[group.key]}
              tasks={group.tasks}
              priorityRanks={priorityRanks}
            />
          ))}
          <RepeatsSection repeats={repeats} />
        </div>
      </TaskViewBody>
    </div>
  );
}

export default TasksToday;
