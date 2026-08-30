import { useEffect, useRef } from "react";
import { Clock, Play, Repeat, Timer } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { phaseClass, type ItemPhase } from "@/hooks/useAnimatedList";
import { reducedMotion } from "@/lib/motion";
import { playSound } from "@/lib/sounds";
import { FOCUS_TIMER_PATH, useStartFocus } from "@/hooks/useStartFocus";
import { useStartTask, startableRoutine } from "@/hooks/useStartTask";
import { cn } from "@/lib/utils";
import { focusMinutesFor } from "@/lib/focus-intent";
import { formatFocusLength } from "@/lib/focus-utils";
import { formatRecurrence } from "@/lib/recurrence";
import {
  formatDuration,
  formatDueTime,
  formatOverdue,
  formatRelativeDate,
  formatTimestampTime,
  PRIORITY_DOT,
} from "@/lib/task-utils";
import { DEFAULT_ROUTINE_ICON as RoutineGlyph, routineTimerMinutes } from "@/lib/routine-utils";
import { useRoutineStore } from "@/stores/routineStore";
import { useTaskStore } from "@/stores/taskStore";
import { TASK_PRIORITY_LABELS, type Task } from "@/types/task";

interface TaskRowProps {
  task: Task;
  /** Show the due date alongside the time — off inside a per-date group. */
  showDate?: boolean;
  /** Show the repeat schedule — on in the Recurring view, off elsewhere. */
  showRecurrence?: boolean;
  /**
   * Where this row is in its life on screen, from `TaskSection`'s
   * `useAnimatedList`. Defaults to `present`, so a row rendered outside an
   * animated list — the dashboard's `DashboardTaskRow` is its own component,
   * but a future caller need not be — simply does not animate.
   */
  phase?: ItemPhase;
}

/**
 * One task line: a completion toggle, the title, and a thin meta row of due
 * time and estimated duration (section 14). A completed task swaps that meta
 * row for its completion time and the focus time it actually took (section
 * 17's "Actual focus time", section 19's "Focus: 43 minutes").
 *
 * Focus time is shown wherever there is some — an open task that has already
 * had two sittings says so too, because that is the honest answer to "how far
 * in am I". It is `task.focus_seconds`, summed by the backend from the
 * sessions attached to this task, so it appears the moment a session ends
 * rather than being anything this row keeps track of.
 *
 * Two controls sit on the right, and they are section 18 and section 19 side
 * by side: **START FOCUS**, the quiet one, on every unfinished task — it puts
 * the task's estimate on the clock — and **START TASK**, the loud one, only on
 * the rows that name a routine, which opens the workspace *and then* focuses.
 * A task that is already being focused on shows that instead, linking to the
 * clock rather than offering to start a second one. Everything else stays as
 * quiet as section 12 asks for: the title opens the edit dialog, and the
 * checkbox is the rest.
 *
 * One thing can happen to a row from outside it: being *revealed*. Section
 * 24's Start Task navigates here and asks for a particular task, which may
 * not be on screen — a long Today list, or a read that has not landed yet.
 * The row scrolls itself into view and holds a ring until the store clears
 * it. It is a pointer, not a selection: nothing else reads it, and it goes on
 * its own.
 */
function TaskRow({
  task,
  showDate = false,
  showRecurrence = false,
  phase = "present",
}: TaskRowProps) {
  const toggleTaskCompletion = useTaskStore((state) => state.toggleTaskCompletion);
  const openTaskEditor = useTaskStore((state) => state.openTaskEditor);
  const recurrence = useTaskStore((state) =>
    task.recurrence_id === null ? undefined : state.recurrences[task.recurrence_id],
  );
  const isRevealed = useTaskStore((state) => state.revealedTaskId === task.id);

  const routines = useRoutineStore((state) => state.routines);
  const { startTask, isLaunching } = useStartTask();
  const { startFocus, isStarting, focusedTaskId, isFocusing } = useStartFocus();

  const isCompleted = task.status === "completed";
  // The session on the clock right now, if it is this task's. Compared by id
  // rather than by subscribing to the session itself, so a running timer does
  // not re-render every row in the list once a second.
  const isBeingFocused = focusedTaskId === task.id;
  // Section 18's pairing is the *assigned* routine, so a task whose routine
  // has not loaded yet — or has been deleted out from under it — shows no
  // chip and no button rather than a button that cannot do anything.
  const routine = startableRoutine(task, routines);
  const focusMinutes = routine
    ? focusMinutesFor(task.estimated_minutes, routineTimerMinutes(routine.actions))
    : null;

  const row = useRef<HTMLLIElement>(null);

  // On mount as much as on change: a reveal set before the navigation is
  // still standing when the list finally renders, and this is the render it
  // has been waiting for.
  useEffect(() => {
    if (!isRevealed) return;
    row.current?.scrollIntoView({
      block: "center",
      // A smooth scroll is motion in the plainest sense, and the one piece of
      // it in this app that moves the whole page rather than one element.
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  }, [isRevealed]);

  const dueTime = formatDueTime(task.due_time);
  const duration = formatDuration(task.estimated_minutes);
  // Zero is "nobody has focused on this yet", which is worth no line at all
  // rather than a dash on every task that was simply ticked off.
  const focusTime = task.focus_seconds > 0 ? formatFocusLength(task.focus_seconds) : null;
  const completedAt = formatTimestampTime(task.completed_at);
  const overdue = formatOverdue(task);
  const repeat = showRecurrence ? formatRecurrence(recurrence) : null;

  async function handleToggle() {
    try {
      await toggleTaskCompletion(task.id);
      // After the write, not before: a cue that played on the click and then
      // had the row snap back would be saying something that did not happen.
      // Only on the way to done — reopening a task is a correction, and
      // sounding the same note for it would make the two indistinguishable.
      if (!isCompleted) playSound("task-complete");
    } catch (cause) {
      // The checkbox is driven by the stored status, so it snaps back on its
      // own; the toast is what explains why.
      toast.error(isCompleted ? "Could not reopen task" : "Could not complete task", {
        description: String(cause),
      });
    }
  }

  return (
    <li
      ref={row}
      className={cn(
        "group flex items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/50",
        isRevealed && "bg-accent/40 ring-2 ring-primary/60 ring-offset-2 ring-offset-background",
        phaseClass(phase),
      )}
    >
      <Checkbox
        id={`task-${task.id}`}
        checked={isCompleted}
        onCheckedChange={() => void handleToggle()}
        className="mt-0.5"
        aria-label={isCompleted ? `Mark "${task.title}" as not done` : `Complete "${task.title}"`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 self-start rounded-full",
                  PRIORITY_DOT[task.priority],
                  isCompleted && "opacity-40",
                )}
              />
            </TooltipTrigger>
            <TooltipContent side="left">
              {TASK_PRIORITY_LABELS[task.priority]} priority
            </TooltipContent>
          </Tooltip>

          <button
            type="button"
            onClick={() => openTaskEditor(task.id)}
            className={cn(
              "min-w-0 flex-1 cursor-pointer text-left text-sm leading-6 hover:underline",
              isCompleted && "text-muted-foreground line-through decoration-muted-foreground/50",
            )}
          >
            {task.title}
          </button>
        </div>

        <div className="ml-3.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {isCompleted ? (
            <>
              {completedAt && <span>Completed at {completedAt}</span>}
              {focusTime && <FocusTime label={`Focus ${focusTime}`} />}
            </>
          ) : (
            <>
              {overdue && <span className="text-priority-urgent">{overdue}</span>}
              {showDate && task.due_date && !overdue && (
                <span>{formatRelativeDate(task.due_date)}</span>
              )}
              {dueTime && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" />
                  Due {dueTime}
                </span>
              )}
              {duration && <span>{duration}</span>}
              {/* An unfinished task that has already been worked on: the
                  estimate says how long it should take, this says how much of
                  that has happened. */}
              {focusTime && <FocusTime label={`Focused ${focusTime}`} />}
            </>
          )}
          {routine && (
            <span className="inline-flex items-center gap-1">
              {/* The routine's own emoji if it has one, at the size of the
                  other meta glyphs — a tile like the routine card's would be
                  taller than the line it sits on. */}
              {routine.icon ? (
                <span aria-hidden className="text-[0.8rem] leading-none">
                  {routine.icon}
                </span>
              ) : (
                <RoutineGlyph className="size-3" />
              )}
              {routine.name}
            </span>
          )}
          {repeat && (
            <span className="inline-flex items-center gap-1">
              <Repeat className="size-3" />
              {repeat}
            </span>
          )}
        </div>
      </div>

      {/* Starting a task you have already finished is not a thing sections 18
          and 19 ask for, and re-opening the workspace — or putting a finished
          task back on the clock — would be an odd way to say "done", so both
          controls go with the completion. */}
      {!isCompleted && (
        <div className="mt-0.5 flex shrink-0 items-center gap-1">
          {isBeingFocused ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" asChild>
                  <Link to={FOCUS_TIMER_PATH}>
                    <Timer className="size-3" />
                    Focusing
                  </Link>
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="left">This task is on the clock — open the timer</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  // One clock at a time: while another session runs there is
                  // nothing this button could do but refuse.
                  disabled={isFocusing || isStarting}
                  onClick={() => void startFocus(task)}
                  aria-label={`Start a focus session for "${task.title}"`}
                >
                  <Timer className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                {isFocusing
                  ? "Another focus session is already running"
                  : task.estimated_minutes === null
                    ? "Start focus"
                    : `Start focus — ${task.estimated_minutes} minutes`}
              </TooltipContent>
            </Tooltip>
          )}

          {routine && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isLaunching}
                  onClick={() => startTask(task)}
                >
                  <Play className="size-4" />
                  START TASK
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                Launch {routine.name}
                {focusMinutes === null ? "" : ` and focus for ${focusMinutes} minutes`}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Measured focus time in the meta row (sections 17 and 19).
 *
 * The tooltip is what separates it from the estimate sitting next to it: one
 * is what the task was guessed to take, this is what it took.
 */
function FocusTime({ label }: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 border-b border-dashed border-muted-foreground/30">
          <Timer className="size-3" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>Actual focus time recorded against this task</TooltipContent>
    </Tooltip>
  );
}

export default TaskRow;
