import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarArrowUp, CalendarDays, Flame, Moon, Settings2 } from "lucide-react";
import { toast } from "sonner";

import InlineError from "@/components/common/states/InlineError";
import CreateDailyRoutineButton from "@/components/dashboard/CreateDailyRoutineButton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { incompleteTasks, streakKeptToday, tasksPlanned, tomorrowKey } from "@/lib/end-of-day";
import { emitProgressChanged } from "@/lib/progress-events";
import { END_MY_DAY_TEMPLATE } from "@/lib/routine-templates";
import { formatFocusTime } from "@/lib/routine-utils";
import { formatDayHeading, formatOverdue, todayKey } from "@/lib/task-utils";
import { announceDataChanged } from "@/lib/window-sync";
import {
  listRepeatsForDate,
  listTasksForDate,
  listTodayTasks,
  updateTask,
} from "@/services/taskService";
import { useAnalyticsStore } from "@/stores/analyticsStore";
import { useAppStore } from "@/stores/appStore";
import { useProgressStore } from "@/stores/progressStore";
import { useRoutineStore } from "@/stores/routineStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTaskStore } from "@/stores/taskStore";
import type { Task } from "@/types/task";

const TASKS_UPCOMING_PATH = "/tasks/upcoming";
const SETTINGS_PATH = "/settings";

/**
 * The end-of-day review (development-plan.md sections 22, 52 and 92's "End
 * My Day"): how the day went, what is still open, and one button that opens
 * the end-of-day routine.
 *
 * ```text
 * 🌙 DAY COMPLETE
 *
 * Tasks 6 / 8    Focus 3h 12m    Routines 4
 * Incomplete 2   Tomorrow 5
 *
 * 🔥 Streak maintained
 *
 * Still open                      [ Move all to tomorrow ]
 * □ Reply to emails               [ Move to tomorrow ]
 *
 * [ Review tomorrow ]  [ End my day ]
 * ```
 *
 * **Optional, so it never opens itself.** It is opened by asking `appStore`
 * for it — from the dashboard's Review My Day button (shown from the day's
 * end), the tray menu or the quick launcher — and taken once, the way Start
 * My Day's request is. The most the app does on its own is one notification
 * at the day's end, when switched on in Settings > Daily (`end_of_day.rs`).
 *
 * **Counts nothing of its own.** Tasks, focus and routines are section 36's
 * TODAY panel from `getProductivityStats`, through the same analytics store
 * the dashboard's statistics read; the streak is the progress store's; the
 * open tasks are the backend's `today` view.
 *
 * **Moves nothing of its own.** Open tasks are listed, and each move to
 * tomorrow is a button the user presses and one ordinary `updateTask`.
 *
 * **Launches nothing of its own.** End my day closes this dialog and hands
 * the end-of-day routine to `routineStore.launchRoutine`, so the panel that
 * comes up is section 32's launch panel, mounted beside this on the
 * dashboard.
 */
function EndOfDayDialog() {
  const requested = useAppStore((state) => state.reviewMyDayRequested);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (requested && useAppStore.getState().takeReviewMyDayRequest()) setOpen(true);
  }, [requested]);

  const close = useCallback(() => setOpen(false), []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        {/* Only mounted while open, so the day is read when it is reviewed. */}
        <EndOfDayBody onClose={close} />
      </DialogContent>
    </Dialog>
  );
}

function EndOfDayBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();

  const stats = useAnalyticsStore((state) => state.stats);
  const statsError = useAnalyticsStore((state) => state.error);
  const loadStats = useAnalyticsStore((state) => state.loadStats);

  const loadProgress = useProgressStore((state) => state.loadProgress);

  const tasks = useDayTasks();

  useEffect(() => {
    void loadStats();
    void loadProgress();
    void useSettingsStore.getState().loadDaily();
    const routineState = useRoutineStore.getState();
    if (routineState.routines.length === 0) void routineState.loadRoutines();
  }, [loadStats, loadProgress]);

  /** After a move: the lists here, the dashboard's list, and the figures. */
  const reloadTasks = tasks.reload;
  const afterMove = useCallback(() => {
    reloadTasks();
    void useTaskStore.getState().refresh();
    announceDataChanged("tasks");
    emitProgressChanged();
    void loadStats();
  }, [reloadTasks, loadStats]);

  function handleReviewTomorrow() {
    onClose();
    navigate(TASKS_UPCOMING_PATH);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-base">
          <Moon className="size-5 text-muted-foreground" aria-hidden />
          Day complete
        </DialogTitle>
        <DialogDescription>{formatDayHeading(new Date())}</DialogDescription>
      </DialogHeader>

      {statsError && !stats ? (
        <InlineError
          message={`Today's figures could not be read. ${statsError}`}
          onRetry={() => void loadStats()}
        />
      ) : null}

      <dl className="grid grid-cols-3 gap-3">
        <Figure
          label="Tasks"
          value={stats && `${stats.today.tasksCompleted} / ${stats.today.tasksTotal}`}
          note="completed"
          failed={statsError !== null && !stats}
        />
        <Figure
          label="Focus"
          value={stats && formatFocusTime(stats.today.focusSeconds)}
          failed={statsError !== null && !stats}
        />
        <Figure
          label="Routines"
          value={stats && String(stats.today.routineLaunches)}
          failed={statsError !== null && !stats}
        />
        <Figure
          label="Incomplete"
          value={tasks.open && String(tasks.open.length)}
          note={tasks.open && (tasks.open.length === 1 ? "task" : "tasks")}
          failed={tasks.error !== null && !tasks.open}
        />
        <Figure
          label="Tomorrow"
          value={tasks.tomorrow && String(tasks.tomorrow.planned)}
          note={
            tasks.tomorrow && tasks.tomorrow.repeats > 0
              ? `+ ${tasks.tomorrow.repeats} repeating`
              : "planned"
          }
          failed={tasks.error !== null && !tasks.tomorrow}
        />
      </dl>

      <StreakLine />

      {tasks.error && !tasks.open ? (
        <InlineError
          message={`Your tasks could not be read. ${tasks.error}`}
          onRetry={tasks.reload}
        />
      ) : tasks.open && tasks.open.length > 0 ? (
        <IncompleteTasks tasks={tasks.open} onMoved={afterMove} />
      ) : null}

      <DialogFooter className="flex-wrap gap-2">
        <Button variant="outline" onClick={handleReviewTomorrow}>
          <CalendarDays />
          Review tomorrow
        </Button>
        <EndMyDay onClose={onClose} />
      </DialogFooter>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Today's and tomorrow's tasks                                               */
/* -------------------------------------------------------------------------- */

interface DayTasksState {
  /** Today's tasks still open, or null until read. */
  open: Task[] | null;
  /** Tomorrow's tasks and the repeats it will get, or null until read. */
  tomorrow: { planned: number; repeats: number } | null;
  error: string | null;
  reload: () => void;
}

/**
 * Today's open tasks and tomorrow's count, read into this dialog's own state.
 *
 * Not `useTaskView`, for the reason `StartMyDayDialog` gives: the task store
 * holds one view at a time, and the dashboard's `TodaysTasks` owns it.
 */
function useDayTasks(): DayTasksState {
  const [open, setOpen] = useState<Task[] | null>(null);
  const [tomorrow, setTomorrow] = useState<DayTasksState["tomorrow"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const tomorrowDate = tomorrowKey();

    Promise.all([
      listTodayTasks(),
      listTasksForDate(tomorrowDate),
      listRepeatsForDate(tomorrowDate),
    ])
      .then(([today, due, repeats]) => {
        if (cancelled) return;
        setOpen(incompleteTasks(today));
        setTomorrow({ planned: tasksPlanned(due), repeats: repeats.length });
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((count) => count + 1), []);
  return { open, tomorrow, error, reload };
}

/**
 * The open tasks, each with its own Move to tomorrow, and one button for all
 * of them. Nothing here happens unless pressed: section 22 lists what is
 * unfinished, and deciding what becomes of it is the user's.
 *
 * A task keeps its time of day when it moves; only the date changes.
 */
function IncompleteTasks({ tasks, onMoved }: { tasks: Task[]; onMoved: () => void }) {
  /** The ids being moved right now — one task, or all of them. */
  const [moving, setMoving] = useState<Set<number>>(new Set());
  const isBusy = moving.size > 0;

  async function move(targets: Task[]) {
    setMoving(new Set(targets.map((task) => task.id)));
    const date = tomorrowKey();
    const failures: string[] = [];

    // One at a time, each an ordinary update: a task that cannot be moved
    // says so without stopping the rest.
    for (const task of targets) {
      try {
        await updateTask(task.id, { due_date: date });
      } catch (cause) {
        failures.push(`${task.title}: ${String(cause)}`);
      }
    }

    setMoving(new Set());
    onMoved();

    const moved = targets.length - failures.length;
    if (failures.length > 0) {
      toast.error(
        failures.length === 1
          ? "One task could not be moved"
          : `${failures.length} tasks could not be moved`,
        { description: failures.join("\n") },
      );
    }
    if (moved > 0) {
      toast.success(
        targets.length === 1 ? `Moved to tomorrow` : `${plural(moved, "task")} moved to tomorrow`,
        targets.length === 1 ? { description: targets[0]?.title } : undefined,
      );
    }
  }

  return (
    <section aria-labelledby="end-of-day-open" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3
          id="end-of-day-open"
          className="text-xs font-medium tracking-widest text-muted-foreground"
        >
          STILL OPEN
        </h3>
        {tasks.length > 1 && (
          <Button
            variant="ghost"
            size="xs"
            disabled={isBusy}
            onClick={() => void move(tasks)}
          >
            <CalendarArrowUp />
            Move all to tomorrow
          </Button>
        )}
      </div>

      <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
        {tasks.map((task) => {
          const overdue = formatOverdue(task);
          return (
            <li
              key={task.id}
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{task.title}</span>
                {overdue && <span className="text-xs text-muted-foreground">{overdue}</span>}
              </span>
              <Button
                variant="outline"
                size="xs"
                className="shrink-0"
                disabled={isBusy}
                onClick={() => void move([task])}
              >
                {moving.has(task.id) ? "Moving…" : "Move to tomorrow"}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Figures and the streak                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One figure. A read that failed is a dash rather than a zero: "0 tasks" over
 * a failed query would be a claim about the day nobody can stand behind.
 */
function Figure({
  label,
  value,
  note = null,
  failed,
}: {
  label: string;
  value: string | null;
  note?: string | null;
  failed: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-muted/50 px-3 py-2">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">
        {value ?? (failed ? "—" : <Skeleton className="my-1 h-5 w-10" />)}
      </dd>
      {note && value !== null && (
        <dd className="truncate text-xs text-muted-foreground">{note}</dd>
      )}
    </div>
  );
}

/** Section 22's "🔥 Streak maintained", or that today has not counted yet. */
function StreakLine() {
  const progress = useProgressStore((state) => state.progress);
  const isLoading = useProgressStore((state) => state.isLoading);

  if (!progress) {
    return isLoading ? <Skeleton className="h-4 w-40" /> : null;
  }

  const { currentStreak } = progress.streak;

  if (streakKeptToday(progress.streak, todayKey())) {
    return (
      <p className="flex items-center gap-2 text-sm">
        <Flame className="size-4 text-amber-500" aria-hidden />
        <span className="font-medium">Streak maintained</span>
        <span className="text-muted-foreground">· {plural(currentStreak, "day")}</span>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Flame className="size-4" aria-hidden />
        Streak not yet kept today
      </p>
      <p className="pl-6 text-xs text-muted-foreground">
        Completing a task or a focus session, or launching a routine, keeps it.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* End my day                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Section 92's End My Day: the end-of-day routine from Settings > Daily,
 * launched through the one launch path. With none set, the two ways of
 * getting one — Settings, or the End My Day template.
 */
function EndMyDay({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();

  const routineId = useSettingsStore((state) => state.daily.endOfDayRoutineId);
  const settingsKnown = useSettingsStore((state) => state.hasLoaded || state.loadError !== null);
  const routines = useRoutineStore((state) => state.routines);
  const routinesLoading = useRoutineStore((state) => state.isLoading);
  const launchRoutine = useRoutineStore((state) => state.launchRoutine);
  const isLaunching = useRoutineStore((state) => state.run?.status === "running");

  if (!settingsKnown || (routineId !== null && routinesLoading)) {
    return <Skeleton className="h-9 w-32" />;
  }

  const routine =
    routineId === null ? null : (routines.find((candidate) => candidate.id === routineId) ?? null);

  if (!routine) {
    return (
      <>
        <Button
          variant="ghost"
          title="No end-of-day routine is set"
          onClick={() => {
            onClose();
            navigate(SETTINGS_PATH);
          }}
        >
          <Settings2 />
          Choose a routine
        </Button>
        <CreateDailyRoutineButton
          template={END_MY_DAY_TEMPLATE}
          field="endOfDayRoutineId"
          onClose={onClose}
        />
      </>
    );
  }

  // The same rule as every other launch button: a routine whose every action
  // is off would report success having opened nothing.
  const hasActions = routine.actions.some((action) => action.enabled);

  return (
    <Button
      disabled={isLaunching || !hasActions}
      title={
        !hasActions
          ? `Turn on an action in ${routine.name} first`
          : isLaunching
            ? "Another routine is still starting"
            : `Opens ${routine.name}`
      }
      onClick={() => {
        // Out of the way first: the launch panel is what to look at now.
        onClose();
        void launchRoutine(routine.id);
      }}
    >
      <Moon />
      End my day
    </Button>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export default EndOfDayDialog;
