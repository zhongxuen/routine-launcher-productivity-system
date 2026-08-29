import { Check, ListChecks, Loader2, Minus, Timer, X, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatFocusClock } from "@/lib/focus-intent";
import { displaySeconds, formatClock } from "@/lib/focus-utils";
import { actionLabel, hasStartedTimer, runCounts } from "@/lib/routine-utils";
import { cn } from "@/lib/utils";
import { useFocusStore } from "@/stores/focusStore";
import { useRoutineStore } from "@/stores/routineStore";
import type { ActionRunStatus, RoutineRun, RoutineRunAction } from "@/types/routine-ui";

import RoutineIcon from "./RoutineIcon";

/** The glyph each action state shows, matching section 32's ✓ / ✗ list. */
const STATUS_ICON: Record<ActionRunStatus, LucideIcon> = {
  pending: Minus,
  running: Loader2,
  success: Check,
  failure: X,
  skipped: Minus,
};

const STATUS_COLOR: Record<ActionRunStatus, string> = {
  pending: "text-muted-foreground/40",
  running: "text-muted-foreground",
  success: "text-status-completed",
  failure: "text-priority-urgent",
  skipped: "text-muted-foreground/40",
};

/**
 * The launch panel from development-plan.md section 32 — and, when the launch
 * came from a task, section 18's combined START TASK feedback.
 *
 * Every action is listed from the first frame and resolves in place, so the
 * panel reads as a checklist filling in rather than a log scrolling past.
 * When something fails the panel does not stop — section 87 requires the rest
 * of the routine to run anyway — it waits until the end and then offers
 * Retry, which re-runs only what failed, or Continue, which accepts it.
 *
 * A task-started launch is the same panel with two more lines: the task it is
 * for, and the focus session it leads to. One panel rather than two, because
 * section 18's example *is* the routine checklist with the task above it —
 * "Launching Coding Mode... ✓ VS Code ... Task: Finish React project".
 */
function RoutineLaunchDialog() {
  const run = useRoutineStore((state) => state.run);
  const retryFailedActions = useRoutineStore((state) => state.retryFailedActions);
  const continueRun = useRoutineStore((state) => state.continueRun);
  const closeRun = useRoutineStore((state) => state.closeRun);

  if (!run) return null;

  const isRunning = run.status === "running";
  const counts = runCounts(run.actions);
  const timerStarted = hasStartedTimer(run.actions);
  const failures = run.actions.filter((entry) => entry.status === "failure");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeRun();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={!isRunning}
        // Closing mid-launch would leave actions opening behind a panel that
        // is no longer there to report them.
        onEscapeKeyDown={(event) => isRunning && event.preventDefault()}
        onInteractOutside={(event) => isRunning && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <RoutineIcon icon={run.routineIcon} className="size-7 text-base" />
            {isRunning ? `Starting ${run.routineName}` : run.routineName}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {run.task ? `Starting ${run.task.title}. ` : ""}
            {counts.completed} of {counts.attempted} actions completed.
          </DialogDescription>
        </DialogHeader>

        {run.task && (
          <p className="flex items-start gap-2 text-sm">
            <ListChecks className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="text-muted-foreground">Task: </span>
              {run.task.title}
            </span>
          </p>
        )}

        <ul className="flex flex-col gap-1.5">
          {run.actions.map((entry) => (
            <ActionLine key={entry.action.id} entry={entry} />
          ))}
        </ul>

        {/* A task launch reports its focus session in `FocusLine` instead —
            two timer lines saying different things about the same timer is
            worse than either of them alone. */}
        {timerStarted && !run.task && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Timer className="size-4" />
            Focus timer started
          </p>
        )}

        <FocusLine run={run} />

        {!isRunning && (
          <div className="flex flex-col gap-1">
            <p className="text-sm">
              <span className="font-medium">
                {counts.completed} / {counts.attempted}
              </span>{" "}
              actions completed
            </p>
            {run.status === "complete" ? (
              <p className="text-sm text-muted-foreground">Ready.</p>
            ) : (
              failures.map((entry) => (
                <p key={entry.action.id} className="text-sm text-priority-urgent">
                  {entry.message ?? `${actionLabel(entry.action)} could not be opened.`}
                </p>
              ))
            )}
          </div>
        )}

        {!isRunning && (
          <DialogFooter>
            {run.status === "partial" ? (
              // Retry first, then Continue, in section 32's order.
              <>
                <Button onClick={() => void retryFailedActions()}>
                  {failures.length === 1 ? "Retry" : `Retry ${failures.length} actions`}
                </Button>
                <Button variant="outline" onClick={continueRun}>
                  Continue
                </Button>
              </>
            ) : (
              <Button onClick={closeRun}>Done</Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Section 18's `Focus timer: 50:00` — and, once the workspace is open, the
 * clock itself.
 *
 * The launch emits a focus intent when its actions have finished
 * (`routineStore`), which `useFocusLifecycle` turns into a running session
 * attached to this task and this routine. So the line has two lives: before
 * that it shows the length the session *will* run for, and after it shows the
 * length it has left, counting. The switch is not a guess — it draws the live
 * clock only while the running session is against this launch's task, which
 * is also what makes this panel the cheapest end-to-end proof that section
 * 18's chain is joined up.
 *
 * Nothing is drawn when the launch was not started from a task, or when
 * neither the task nor the routine named a length — in which case no session
 * is started either (see `useFocusLifecycle`), so the panel and the timer
 * agree about there not being one.
 */
function FocusLine({ run }: { run: RoutineRun }) {
  const session = useFocusStore((state) => state.session);
  const sessionError = useFocusStore((state) => state.sessionError);

  const minutes = run.task?.focusMinutes ?? null;
  if (minutes === null) return null;

  const live =
    session && run.task && session.taskId === run.task.taskId ? session : null;
  const isLaunching = run.status === "running";

  return (
    <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2">
      <Timer className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-col gap-0.5">
        <p className="text-sm">
          <span className="text-muted-foreground">Focus timer: </span>
          <span className="font-medium tabular-nums">
            {live ? formatClock(displaySeconds(live)) : formatFocusClock(minutes)}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          {live
            ? "Counting now — it keeps running while you work."
            : isLaunching
              ? "Starts as soon as the workspace is open."
              : session
                ? "Another focus session is already running."
                : (sessionError ?? "No focus session was started.")}
        </p>
      </div>
    </div>
  );
}

/** One line of the checklist: state glyph, name, and why it failed. */
function ActionLine({ entry }: { entry: RoutineRunAction }) {
  const Icon = STATUS_ICON[entry.status];

  return (
    <li className="flex items-center gap-2 text-sm">
      <Icon
        className={cn(
          "size-4 shrink-0",
          STATUS_COLOR[entry.status],
          entry.status === "running" && "animate-spin",
        )}
      />
      <span
        className={cn(
          "truncate",
          entry.status === "pending" && "text-muted-foreground",
          entry.status === "skipped" && "text-muted-foreground/60 line-through",
        )}
      >
        {actionLabel(entry.action)}
      </span>
      {entry.status === "skipped" && (
        <span className="ml-auto text-xs text-muted-foreground/60">skipped</span>
      )}
    </li>
  );
}

export default RoutineLaunchDialog;
