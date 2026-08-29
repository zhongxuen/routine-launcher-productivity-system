import { Checkbox } from "@/components/ui/checkbox";
import { formatDueTime, formatOverdue, PRIORITY_DOT } from "@/lib/task-utils";
import { cn } from "@/lib/utils";
import type { Task } from "@/types/task";

interface PopupTaskRowProps {
  task: Task;
  /** Ticks the box. The caller owns the write, so it owns the error too. */
  onToggle: (task: Task) => void;
  /** True while this row's write is in flight. */
  isBusy: boolean;
}

/**
 * One line of the popup's list — the `□ Finish report` and `✓ Check emails`
 * of section 25's mockup.
 *
 * The thinnest task row in the app, and the thinnest one it is possible to
 * draw and still make a decision from: a priority dot, the title, and a time
 * only when the task is late or due at one. No estimate, no category, no
 * focus total, no link — a 340px window has no room to be a task manager, and
 * section 25 is explicit that this is a glance you can act on rather than a
 * small copy of the Tasks page.
 *
 * Not clickable, deliberately. Everything a row offers here is the checkbox;
 * opening a task means opening the app, which is exactly what this window
 * exists to avoid making necessary. The one thing the title does is carry its
 * full text in a tooltip, since a narrow window truncates a lot of them.
 */
function PopupTaskRow({ task, onToggle, isBusy }: PopupTaskRowProps) {
  const isCompleted = task.status === "completed";
  const overdue = formatOverdue(task);
  const dueTime = formatDueTime(task.due_time);

  return (
    <li
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50",
        isBusy && "opacity-60",
      )}
    >
      <Checkbox
        checked={isCompleted}
        disabled={isBusy}
        onCheckedChange={() => onToggle(task)}
        className="size-4"
        aria-label={
          isCompleted ? `Mark "${task.title}" as not done` : `Complete "${task.title}"`
        }
      />

      {/* The dot alone, with no tooltip: section 12 wants a subtle indicator,
          and a hover card in a window this size covers the list it explains. */}
      <span
        className={cn("size-1.5 shrink-0 rounded-full", PRIORITY_DOT[task.priority])}
        aria-hidden
      />

      <span
        title={task.title}
        className={cn(
          "min-w-0 flex-1 truncate text-sm leading-5",
          isCompleted && "text-muted-foreground line-through decoration-muted-foreground/50",
        )}
      >
        {task.title}
      </span>

      {/* One piece of meta at most, and none once the task is done — a
          finished task cannot be late. Late beats due-at: a task already
          overdue is not helped by being told when it was meant to start. */}
      {!isCompleted &&
        (overdue ? (
          <span className="shrink-0 text-[11px] text-priority-urgent">{overdue}</span>
        ) : (
          dueTime && (
            <span className="shrink-0 text-[11px] text-muted-foreground">{dueTime}</span>
          )
        ))}
    </li>
  );
}

export default PopupTaskRow;
