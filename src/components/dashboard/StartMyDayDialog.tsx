import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  LayoutDashboard,
  Minus,
  Plus,
  Settings2,
  Sun,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import InlineError from "@/components/common/states/InlineError";
import RoutineIcon from "@/components/routines/RoutineIcon";
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
import { formatWorkMinutes } from "@/lib/analytics-utils";
import { actionLabel } from "@/lib/routine-utils";
import { START_MY_DAY_TEMPLATE } from "@/lib/routine-templates";
import {
  PLANNING_SESSION,
  daySummary,
  launchedToday,
  startOfDayRoutine,
  type DaySummary,
} from "@/lib/start-my-day";
import { formatDayHeading, formatTimestampTime } from "@/lib/task-utils";
import { cn } from "@/lib/utils";
import { listTodayTasks } from "@/services/taskService";
import { useAppStore } from "@/stores/appStore";
import { useFocusStore } from "@/stores/focusStore";
import { useRoutineStore } from "@/stores/routineStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { RoutineWithActions } from "@/types/routine";

const SETTINGS_PATH = "/settings";

/**
 * Start My Day (development-plan.md sections 21 and 89): the morning's
 * summary, and one button that opens the start-of-day routine and then ten
 * minutes to plan.
 *
 * ```text
 * ☀️ START MY DAY
 *
 * Tasks today: 7    High priority: 2    Estimated work: 4h 10m
 *
 * Actions:
 * ✓ Open calendar
 * ✓ Open email
 * ✓ Open task dashboard
 * ✓ Start 10-minute planning session
 *
 * [ START MY DAY ]
 * ```
 *
 * **It launches nothing of its own.** START MY DAY closes this dialog and
 * hands the routine to `routineStore.launchRoutine`, so the panel that comes
 * up is section 32's `RoutineLaunchDialog` — the one every launch uses, with
 * section 87's per-action results, Retry and Continue — and the planning
 * session is asked for through `requestFocus` once the actions are done, the
 * way START TASK asks for a task's. The only XP is the launch's own
 * once-a-day reward (section 88), plus whatever a completed focus session
 * earns anywhere.
 *
 * **Mounted by the dashboard**, because the launch panel is too. The button
 * on the dashboard, the tray menu and the quick launcher all open it by
 * asking `appStore` for it, the latter two after navigating here.
 *
 * With no start-of-day routine set, the summary is still worth showing: the
 * launch is replaced by the two ways of getting a routine — choosing one in
 * Settings > Daily, or creating one from the Start My Day template.
 */
function StartMyDayDialog() {
  const requested = useAppStore((state) => state.startMyDayRequested);
  const [open, setOpen] = useState(false);

  // Taken rather than read, so the request is answered once: a dialog the
  // user closed, or was navigated away from, does not come back on its own.
  useEffect(() => {
    if (requested && useAppStore.getState().takeStartMyDayRequest()) setOpen(true);
  }, [requested]);

  const close = useCallback(() => setOpen(false), []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        {/* Only mounted while open, so today's tasks are read fresh each time
            the dialog is — the morning it is opened on, not the one the
            dashboard was loaded on. */}
        <StartMyDayBody onClose={close} />
      </DialogContent>
    </Dialog>
  );
}

function StartMyDayBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();

  const routineId = useSettingsStore((state) => state.daily.startOfDayRoutineId);
  const settingsLoaded = useSettingsStore((state) => state.hasLoaded);
  const settingsError = useSettingsStore((state) => state.loadError);
  const loadDaily = useSettingsStore((state) => state.loadDaily);

  const routines = useRoutineStore((state) => state.routines);
  const routinesLoading = useRoutineStore((state) => state.isLoading);
  const launchRoutine = useRoutineStore((state) => state.launchRoutine);
  const isLaunching = useRoutineStore((state) => state.run?.status === "running");

  const isFocusing = useFocusStore((state) => state.session !== null);

  const today = useTodaySummary();

  useEffect(() => {
    // Fresh, like the Daily card's own read: the routine may have been chosen
    // in another window since this one last looked.
    void loadDaily();
    const routineState = useRoutineStore.getState();
    if (routineState.routines.length === 0) void routineState.loadRoutines();
  }, [loadDaily]);

  const isDeciding =
    (!settingsLoaded && settingsError === null) || (routineId !== null && routinesLoading);
  const routine = startOfDayRoutine(routineId, routines);

  function handleStart() {
    if (!routine) return;
    // Out of the way first: the launch panel is what the user should be
    // looking at while the workspace opens.
    onClose();
    void launchRoutine(routine.id, { planning: PLANNING_SESSION });
  }

  function handleChoose() {
    onClose();
    // Daily is the first card on the Settings page.
    navigate(SETTINGS_PATH);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-base">
          <Sun className="size-5 text-muted-foreground" aria-hidden />
          Start My Day
        </DialogTitle>
        <DialogDescription>{formatDayHeading(new Date())}</DialogDescription>
      </DialogHeader>

      <SummaryFigures {...today} />

      <section aria-labelledby="start-my-day-actions" className="flex flex-col gap-2">
        <h3
          id="start-my-day-actions"
          className="text-xs font-medium tracking-widest text-muted-foreground"
        >
          ACTIONS
        </h3>

        {isDeciding ? (
          <div role="status" aria-busy className="flex flex-col gap-2">
            <span className="sr-only">Loading your start-of-day routine</span>
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-4 w-48" aria-hidden />
            ))}
          </div>
        ) : routine ? (
          <RoutineChecklist routine={routine} />
        ) : (
          <NoRoutine
            settingsError={settingsLoaded ? null : settingsError}
            onRetry={() => void loadDaily()}
          />
        )}
      </section>

      {routine && !isDeciding && (
        <StartNotes routine={routine} isFocusing={isFocusing} />
      )}

      <DialogFooter>
        {isDeciding ? null : routine ? (
          <StartButton routine={routine} isLaunching={isLaunching} onStart={handleStart} />
        ) : (
          <>
            <Button variant="outline" onClick={handleChoose}>
              <Settings2 />
              Choose a routine
            </Button>
            <CreateFromTemplateButton onClose={onClose} />
          </>
        )}
      </DialogFooter>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Today's figures                                                            */
/* -------------------------------------------------------------------------- */

interface TodaySummaryState {
  summary: DaySummary | null;
  error: string | null;
  reload: () => void;
}

/**
 * Today's tasks, read into this dialog's own state.
 *
 * Not `useTaskView`: the task store holds one view at a time and the
 * dashboard's `TodaysTasks` already owns it as `today`, so a second one would
 * have the two overwriting each other — the trap `UpcomingTasks` describes.
 * The query is the same `today` view, so the figures agree with that list,
 * carried-over tasks included.
 */
function useTodaySummary(): TodaySummaryState {
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    listTodayTasks()
      .then((tasks) => {
        if (cancelled) return;
        setSummary(daySummary(tasks));
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return { summary, error, reload: () => setAttempt((count) => count + 1) };
}

/**
 * Section 21's three figures. A read that failed says so rather than showing
 * zeroes — "0 tasks today" over a failed query would be a claim about the day
 * nobody can stand behind (section 88).
 */
function SummaryFigures({ summary, error, reload }: TodaySummaryState) {
  if (error && !summary) {
    return (
      <InlineError message={`Today's tasks could not be read. ${error}`} onRetry={reload} />
    );
  }

  const estimate = summary ? estimateFigure(summary) : null;

  return (
    <dl className="grid grid-cols-3 gap-3">
      <Figure
        label="Tasks today"
        value={summary && String(summary.tasksToday)}
        note={summary && summary.completed > 0 ? `${summary.completed} done` : null}
      />
      <Figure label="High priority" value={summary && String(summary.highPriority)} />
      <Figure label="Estimated work" value={estimate?.value ?? null} note={estimate?.note} />
    </dl>
  );
}

/**
 * What "Estimated work" says: the total over the open tasks, and how many of
 * them it leaves out for having no estimate. A day with open tasks and not
 * one estimate is a dash, not "0m" — nothing was estimated, which is not the
 * same as nothing to do.
 */
function estimateFigure({
  tasksToday,
  completed,
  estimatedMinutes,
  unestimated,
}: DaySummary): { value: string; note: string | null } {
  const open = tasksToday - completed;
  if (open === 0) return { value: "0m", note: null };
  if (estimatedMinutes === 0) return { value: "—", note: "No estimates yet" };

  return {
    value: formatWorkMinutes(estimatedMinutes),
    note: unestimated > 0 ? `+ ${unestimated} unestimated` : null,
  };
}

/** One figure: its label, its value (a skeleton until there is one) and a quiet note. */
function Figure({
  label,
  value,
  note = null,
}: {
  label: string;
  value: string | null;
  note?: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-muted/50 px-3 py-2">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">
        {value ?? <Skeleton className="my-1 h-5 w-10" />}
      </dd>
      {note && <dd className="truncate text-xs text-muted-foreground">{note}</dd>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The routine                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What START MY DAY will do, in section 21's order: the routine's actions,
 * the dashboard (already open — it is where this was pressed from), and the
 * planning session.
 *
 * A disabled action is listed struck through, because the launch will report
 * it as skipped and the checklist should not promise what the panel then
 * takes back.
 */
function RoutineChecklist({ routine }: { routine: RoutineWithActions }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-2 text-sm">
        <RoutineIcon icon={routine.icon} className="size-6 rounded-md text-sm" />
        <span className="truncate font-medium">{routine.name}</span>
      </p>

      <ul className="flex flex-col gap-1.5">
        {routine.actions.map((action) => (
          <ChecklistLine key={action.id} muted={!action.enabled} struck={!action.enabled}>
            {actionLabel(action)}
          </ChecklistLine>
        ))}
        <ChecklistLine icon={LayoutDashboard} muted>
          Task dashboard <span className="text-xs">· already open</span>
        </ChecklistLine>
        <ChecklistLine icon={Timer}>
          Start {PLANNING_SESSION.minutes}-minute planning session
        </ChecklistLine>
      </ul>
    </div>
  );
}

function ChecklistLine({
  children,
  icon: Icon = Check,
  muted = false,
  struck = false,
}: {
  children: React.ReactNode;
  icon?: LucideIcon;
  muted?: boolean;
  struck?: boolean;
}) {
  const Glyph = struck ? Minus : Icon;

  return (
    <li className="flex items-center gap-2 text-sm">
      <Glyph
        className={cn(
          "size-4 shrink-0",
          muted ? "text-muted-foreground/60" : "text-status-completed",
        )}
        aria-hidden
      />
      <span
        className={cn(
          "truncate",
          muted && "text-muted-foreground",
          struck && "text-muted-foreground/60 line-through",
        )}
      >
        {children}
      </span>
      {struck && <span className="ml-auto text-xs text-muted-foreground/60">off</span>}
    </li>
  );
}

/**
 * Two things worth knowing before pressing: that the day has already been
 * started (the button still works — opening the workspace twice is normal),
 * and that a running focus session means no planning session will start,
 * since there is only ever one clock.
 */
function StartNotes({
  routine,
  isFocusing,
}: {
  routine: RoutineWithActions;
  isFocusing: boolean;
}) {
  const startedAt = launchedToday(routine) ? formatTimestampTime(routine.last_launched_at) : null;
  if (!startedAt && !isFocusing) return null;

  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      {startedAt && <p>You started {routine.name} today at {startedAt}.</p>}
      {isFocusing && (
        <p>A focus session is already running, so the planning session will not start.</p>
      )}
    </div>
  );
}

function StartButton({
  routine,
  isLaunching,
  onStart,
}: {
  routine: RoutineWithActions;
  isLaunching: boolean;
  onStart: () => void;
}) {
  // The same rule as every other launch button: a routine whose every action
  // is off would report success having opened nothing.
  const hasActions = routine.actions.some((action) => action.enabled);

  return (
    <Button
      className="w-full sm:w-auto"
      onClick={onStart}
      disabled={isLaunching || !hasActions}
      title={
        !hasActions
          ? `Turn on an action in ${routine.name} first`
          : isLaunching
            ? "Another routine is still starting"
            : undefined
      }
    >
      <Sun />
      START MY DAY
    </Button>
  );
}

/* -------------------------------------------------------------------------- */
/* No routine yet                                                             */
/* -------------------------------------------------------------------------- */

function NoRoutine({
  settingsError,
  onRetry,
}: {
  settingsError: string | null;
  onRetry: () => void;
}) {
  if (settingsError) {
    return (
      <InlineError
        message={`Your daily settings could not be read, so the start-of-day routine is unknown. ${settingsError}`}
        onRetry={onRetry}
      />
    );
  }

  return (
    <p className="text-sm text-muted-foreground">
      No start-of-day routine is set. Choose one of yours in Settings, or create one from the
      Start My Day template — calendar, email and a {PLANNING_SESSION.minutes}-minute planning
      timer.
    </p>
  );
}

/**
 * Creates the Start My Day routine, makes it the start-of-day routine, and
 * opens it in the builder — the same hand-off the Templates tab makes, for the
 * same reason: its targets are guesses, and the moment to check them is
 * before the first launch.
 *
 * Setting it as the start-of-day routine is the point of pressing this here
 * rather than on the Templates tab. It is only done when the stored settings
 * were actually read, since saving writes all nine and a failed read would
 * otherwise overwrite them with defaults.
 */
function CreateFromTemplateButton({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const createRoutine = useRoutineStore((state) => state.createRoutine);
  const [isCreating, setIsCreating] = useState(false);

  async function handleCreate() {
    setIsCreating(true);

    let created: RoutineWithActions;
    try {
      created = await createRoutine(START_MY_DAY_TEMPLATE.routine);
    } catch (cause) {
      setIsCreating(false);
      toast.error("Could not add the Start My Day routine", { description: String(cause) });
      return;
    }

    const linked = await makeStartOfDayRoutine(created.id);

    toast.success(`${created.name} added`, {
      description: linked
        ? "It is your start-of-day routine now. Check the targets match your setup, then save."
        : "Check the targets match your setup, then choose it in Settings > Daily.",
    });
    onClose();
    navigate(`/routines/create?routine=${created.id}`);
  }

  return (
    <Button disabled={isCreating} onClick={() => void handleCreate()}>
      <Plus />
      {isCreating ? "Adding…" : "Create from template"}
    </Button>
  );
}

/** Saves `routineId` as the start-of-day routine, answering whether it was. */
async function makeStartOfDayRoutine(routineId: number): Promise<boolean> {
  const settings = useSettingsStore.getState();
  const daily = await settings.ensureDaily();
  if (!useSettingsStore.getState().hasLoaded) return false;

  try {
    await settings.saveDaily({ ...daily, startOfDayRoutineId: routineId });
    return true;
  } catch (cause) {
    console.error("Could not set the start-of-day routine:", cause);
    return false;
  }
}

export default StartMyDayDialog;
