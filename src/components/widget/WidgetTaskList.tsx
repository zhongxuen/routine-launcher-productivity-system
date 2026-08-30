import { useState } from "react";

import EmptyState from "@/components/common/states/EmptyState";
import ErrorState from "@/components/common/states/ErrorState";
import InlineError from "@/components/common/states/InlineError";
import { Skeleton } from "@/components/ui/skeleton";
import { completionCounts, sortTasks } from "@/lib/task-utils";
import { useTaskStore } from "@/stores/taskStore";
import type { Task } from "@/types/task";

import WidgetHeading from "./WidgetHeading";
import WidgetTaskRow, { WIDGET_TASK_ROW_HEIGHT } from "./WidgetTaskRow";
import { useFittedRows } from "./useFittedRows";

interface WidgetTaskListProps {
  /** Section 26's `3/7`. The combined mode's mockup does without it. */
  showCount?: boolean;
  /** True when this is the widget's first line, so it clears the controls. */
  topmost?: boolean;
  /** Rows to draw even in a window too short for them. */
  minimumRows?: number;
}

/**
 * Section 26's TODAY list, with the count and the working checkboxes.
 *
 * ```text
 * │ TODAY             3/7   │
 * │ □ Finish report         │
 * │ □ Study JavaScript      │
 * │ ✓ Check emails          │
 * ```
 *
 * Shared by the task widget and the combined one, which want the same list at
 * different lengths — the combined mockup gives half its height to the focus
 * section below, so its copy simply has less room and truncates sooner. That
 * is the whole difference, and it is a matter of layout rather than of
 * policy: both are reading the backend's `today` view, the same query the
 * dashboard, `/tasks/today` and the popup run, so no two of the four can
 * disagree about what today is.
 *
 * **Truncated, never scrolled.** Whatever does not fit is counted in one line
 * at the bottom rather than hidden behind a scrollbar — see `useFittedRows`
 * for why a widget is the one list in the app that works this way. The line
 * says the rest are in the app, because they are: the widget is a glance, and
 * nine tasks is not a glance.
 *
 * **Ticked tasks stay**, sunk below the open ones and struck through, exactly
 * as the mockup's `✓ Check emails` sits under two unticked boxes. In a list
 * this short a task vanishing when you tick it reads as a mistake, and the
 * completed half of the day is what makes `3/7` mean anything.
 */
function WidgetTaskList({ showCount, topmost, minimumRows = 1 }: WidgetTaskListProps) {
  const tasks = useTaskStore((state) => state.tasks);
  const view = useTaskStore((state) => state.view);
  const isLoading = useTaskStore((state) => state.isLoading);
  const readError = useTaskStore((state) => state.error);
  const refresh = useTaskStore((state) => state.refresh);
  const toggleTaskCompletion = useTaskStore((state) => state.toggleTaskCompletion);

  /** The task whose checkbox is mid-write, so its row can stop taking clicks. */
  const [busyTaskId, setBusyTaskId] = useState<number | null>(null);
  /** A failed *write*. Reads report themselves through the store. */
  const [writeError, setWriteError] = useState<string | null>(null);

  // Between mount and the load landing the store may still hold another
  // view — showing it under TODAY would be a different day's list.
  const isCurrent = view === "today";
  const ordered = isCurrent ? orderForWidget(tasks) : [];
  const { completed, total } = completionCounts(ordered);
  const isReading = isLoading || !isCurrent;

  const { ref, visible, hidden } = useFittedRows<HTMLDivElement>(
    ordered.length,
    WIDGET_TASK_ROW_HEIGHT,
    minimumRows,
  );

  async function handleToggle(task: Task) {
    setBusyTaskId(task.id);
    setWriteError(null);
    try {
      await toggleTaskCompletion(task.id);
    } catch (cause) {
      // The checkbox reflects the stored status, so it snaps back by itself
      // when the write fails; this line is what explains the snap-back. There
      // is no Toaster in this window, and a toast over a 300px widget would
      // cover the widget.
      setWriteError(String(cause));
    } finally {
      setBusyTaskId(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <WidgetHeading
        label="Today"
        topmost={topmost}
        trailing={
          showCount && !isReading && !readError ? (
            <span className="text-[0.7rem] tabular-nums text-muted-foreground">
              <span className="font-semibold text-foreground">{completed}</span>/{total}
            </span>
          ) : null
        }
      />

      {/* The measured box, and the reason the "+N more" line lives inside it:
          the box is what `useFittedRows` counts rows into, so a line that
          appeared *below* it would shrink it, drop the capacity, hide another
          task and go round again. Inside, it spends part of the row the hook
          already gave up for it and the measurement never moves. */}
      <div ref={ref} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {isReading ? (
          <LoadingRows />
        ) : readError ? (
          // The retry is the whole point of stating it here. The widget has
          // no navigation and no toaster, so without a link to press a failed
          // read left the user with a dead 300px box until they went and
          // opened the app.
          <ErrorState
            size="compact"
            title="Could not read today's tasks."
            onRetry={() => void refresh()}
            retryLabel="Retry"
          />
        ) : ordered.length === 0 ? (
          <EmptyState size="compact" title="Nothing scheduled for today." />
        ) : (
          <ul className="flex flex-col">
            {ordered.slice(0, visible).map((task) => (
              <WidgetTaskRow
                key={task.id}
                task={task}
                isBusy={busyTaskId === task.id}
                onToggle={handleToggle}
              />
            ))}
          </ul>
        )}

        {hidden > 0 && !isReading && !readError && (
          <p className="shrink-0 px-1 pt-1 text-[0.65rem] leading-none text-muted-subtle">
            +{hidden} more in the app
          </p>
        )}
      </div>

      {writeError && (
        <InlineError
          className="shrink-0 px-1 py-1 text-[0.65rem] leading-tight"
          message={writeError}
          onDismiss={() => setWriteError(null)}
        />
      )}
    </div>
  );
}

/**
 * Open tasks first, in the order the rest of the app sorts them, then the
 * ones already ticked off.
 *
 * `sortTasks` is applied within each half rather than across the whole list,
 * because its first rule is overdue-first and a *completed* overdue task is
 * not something to put at the top of the day. It matters more here than
 * anywhere else in the app: this list is truncated, so its order decides what
 * the user sees at all rather than only what they see first.
 */
function orderForWidget(tasks: Task[]): Task[] {
  const relevant = tasks.filter((task) => task.status !== "cancelled");
  const done = (task: Task) => task.status === "completed";

  return [
    ...sortTasks(relevant.filter((task) => !done(task))),
    ...sortTasks(relevant.filter(done)),
  ];
}

/** Three bars where the rows will be. Fewer than the list will hold, so a
 *  short window does not fill with skeleton and then empty out. */
function LoadingRows() {
  return (
    <ul className="flex flex-col">
      {Array.from({ length: 3 }, (_, index) => (
        <li
          key={index}
          className="flex h-7 items-center gap-2 px-1"
          aria-hidden
        >
          <Skeleton className="size-3.5 rounded" />
          <Skeleton className="h-2 flex-1" />
        </li>
      ))}
      <li className="sr-only">Loading today&apos;s tasks</li>
    </ul>
  );
}

export default WidgetTaskList;
