import { useCallback, useEffect, useState } from "react";
import { PanelsTopLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useWindowSync } from "@/hooks/useWindowSync";
import { completionCounts, sortTasks } from "@/lib/task-utils";
import { focusMainWindow, onPopupShown } from "@/services/popupService";
import { useRoutineStore } from "@/stores/routineStore";
import { useTaskStore } from "@/stores/taskStore";
import { refreshTheme } from "@/stores/themeStore";
import type { Task } from "@/types/task";

import PopupQuickAdd from "./PopupQuickAdd";
import PopupReminder from "./PopupReminder";
import PopupRoutineLaunch from "./PopupRoutineLaunch";
import PopupTaskRow from "./PopupTaskRow";

/**
 * The compact popup window (development-plan.md section 25):
 *
 * ```text
 * ┌──────────────────────────────┐
 * │ TODAY                        │
 * │                              │
 * │ 3 / 7 completed              │
 * │                              │
 * │ □ Finish report              │
 * │ □ Study JavaScript           │
 * │ ✓ Check emails               │
 * │                              │
 * │ [ + Add Task ]               │
 * │                              │
 * │ 🚀 Start Coding              │
 * └──────────────────────────────┘
 * ```
 *
 * Everything in it is the real thing. The list is the backend's `today` view
 * — the same query the dashboard and `/tasks/today` run, so the three can
 * never disagree and section 14's carry-forward of unfinished work comes
 * along; the checkbox is `taskStore.toggleTaskCompletion`, the same write the
 * Tasks page makes; the launch button is `routineStore.launchRoutine`, the
 * same command, recorded the same way. There is no popup-shaped copy of any
 * of it.
 *
 * **The rule the whole file is built around** is section 25's last line: it
 * must not require opening the full application. So the four things the
 * mockup shows are four things you can finish here — see the day's score,
 * tick a task off, add one, open a workspace — and none of them is a link to
 * somewhere else. The one exception is deliberate and lives in the header:
 * a button to the full app, for when the user wants the rest rather than
 * because the popup ran out.
 *
 * **Ticked tasks stay.** They sink below the open ones, struck through, the
 * way the mockup's `✓ Check emails` sits under two unticked boxes. In a list
 * this short a task vanishing when you tick it reads as a mistake, and the
 * completed half of the day is what makes the count above it mean anything.
 *
 * Three things keep it honest without a refresh button, because a hidden
 * window's webview is never torn down and this one can sit behind everything
 * for days:
 *
 * 1. `popup://shown` — Rust tells it when a hidden window is shown again.
 * 2. `useWindowSync` — the main window announces its own writes.
 * 3. The DOM `focus` event — the cheapest catch-all, for anything the first
 *    two miss.
 *
 * The one thing here that is not about today's list is `PopupReminder`.
 * Section 24's reminders are broadcast to every window, and this is the
 * always-on-top one — when a reminder lands while the app is buried, this is
 * the surface the user can see. See that file for why its Start Task hands
 * over to the app while Snooze and Dismiss stay here.
 */
function PopupWindow() {
  const tasks = useTaskStore((state) => state.tasks);
  const view = useTaskStore((state) => state.view);
  const isLoading = useTaskStore((state) => state.isLoading);
  const readError = useTaskStore((state) => state.error);
  const loadView = useTaskStore((state) => state.loadView);
  const toggleTaskCompletion = useTaskStore((state) => state.toggleTaskCompletion);

  /** The task whose checkbox is mid-write, so its row can stop taking clicks. */
  const [busyTaskId, setBusyTaskId] = useState<number | null>(null);
  /** A failed *write*. Reads report themselves through the store. */
  const [writeError, setWriteError] = useState<string | null>(null);

  useWindowSync();

  const reload = useCallback(() => {
    void loadView("today");
    void useRoutineStore.getState().loadRoutines();
  }, [loadView]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Shown again after being hidden. The theme comes with it: this window
  // survives a change made in Settings without ever re-running `initTheme`.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void onPopupShown(() => {
      refreshTheme();
      reload();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((cause) => console.error("Could not listen for the popup opening:", cause));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reload]);

  // The catch-all. Clicking back into a window that has been sitting there
  // since yesterday is the moment its list is most likely to be wrong, and
  // this costs one local query.
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  async function handleToggle(task: Task) {
    setBusyTaskId(task.id);
    setWriteError(null);
    try {
      await toggleTaskCompletion(task.id);
    } catch (cause) {
      // The checkbox reflects the stored status, so it snaps back by itself
      // when the write fails; this line is what explains the snap-back. There
      // is no Toaster in this window — a toast over a 340px list would cover
      // the list.
      setWriteError(String(cause));
    } finally {
      setBusyTaskId(null);
    }
  }

  // Between mount and the effect running the store may still hold another
  // window's view; showing it under TODAY would be a different day's list.
  const isCurrent = view === "today";
  const ordered = isCurrent ? orderForPopup(tasks) : [];
  const { completed, total } = completionCounts(ordered);
  const isReading = isLoading || !isCurrent;

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex items-start justify-between gap-2 px-3 pt-3 pb-2">
        <div className="min-w-0">
          <h1 className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            Today
          </h1>
          {/* A count is a claim about the day, and there is nothing to claim
              until the read lands — "0 / 0 completed" over a skeleton would be
              a wrong one, and over a failed read it would be a false one. The
              line keeps its height either way so the list below does not jump
              when the number arrives. */}
          <p className="h-5 text-sm">
            {isReading ? (
              <span className="sr-only">Loading today&apos;s tasks</span>
            ) : readError ? null : (
              <>
                <span className="font-medium">{completed}</span>
                <span className="text-muted-foreground"> / {total} completed</span>
              </>
            )}
          </p>
        </div>

        <Button
          size="icon-sm"
          variant="ghost"
          className="-mr-1 shrink-0 text-muted-foreground"
          onClick={() => void focusMainWindow()}
          title="Open the full app"
          aria-label="Open the full app"
        >
          <PanelsTopLeft />
        </Button>
      </header>

      {/* Above the list, not over it: a reminder is worth pushing the day
          down for, and there is no room in this window to cover it. */}
      <PopupReminder />

      <ScrollArea className="min-h-0 flex-1 border-y">
        <div className="px-2 py-2">
          <PopupBody
            isLoading={isReading}
            error={isCurrent ? readError : null}
            onRetry={reload}
            tasks={ordered}
            busyTaskId={busyTaskId}
            onToggle={handleToggle}
          />
        </div>
      </ScrollArea>

      <footer className="flex flex-col gap-2 px-3 py-3">
        {writeError && (
          <p className="text-[11px] leading-tight text-priority-urgent">{writeError}</p>
        )}

        <PopupQuickAdd onAdded={() => setWriteError(null)} />
        <PopupRoutineLaunch />
      </footer>
    </div>
  );
}

/**
 * Open tasks first, in the order the rest of the app sorts them, then the
 * ones already ticked off.
 *
 * `sortTasks` is applied within each half rather than across the whole list,
 * because its first rule is overdue-first and a *completed* overdue task is
 * not something to put at the top of the day.
 */
function orderForPopup(tasks: Task[]): Task[] {
  const relevant = tasks.filter((task) => task.status !== "cancelled");
  const done = (task: Task) => task.status === "completed";

  return [
    ...sortTasks(relevant.filter((task) => !done(task))),
    ...sortTasks(relevant.filter(done)),
  ];
}

interface PopupBodyProps {
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  tasks: Task[];
  busyTaskId: number | null;
  onToggle: (task: Task) => void;
}

/** The list, or whatever stands in for it. */
function PopupBody({ isLoading, error, onRetry, tasks, busyTaskId, onToggle }: PopupBodyProps) {
  if (isLoading) {
    return (
      <ul className="flex flex-col gap-1 px-2">
        {Array.from({ length: 4 }, (_, index) => (
          <li key={index} className="flex items-center gap-2.5 py-1.5">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-3 flex-1" />
          </li>
        ))}
      </ul>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-start gap-2 px-2 py-3">
        <p className="text-xs text-muted-foreground">Could not read today's tasks.</p>
        <Button size="xs" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <p className="px-2 py-6 text-center text-xs text-muted-foreground">
        Nothing scheduled for today.
      </p>
    );
  }

  return (
    <ul className="flex flex-col">
      {tasks.map((task) => (
        <PopupTaskRow
          key={task.id}
          task={task}
          isBusy={busyTaskId === task.id}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}

export default PopupWindow;
