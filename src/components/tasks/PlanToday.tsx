import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowUp, ChevronRight, Star, Sun, X } from "lucide-react";

import InlineError from "@/components/common/states/InlineError";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { DailyPlanState } from "@/hooks/useDailyPlan";
import { useNow } from "@/hooks/useNow";
import { formatWorkMinutes } from "@/lib/analytics-utils";
import {
  isOpenTask,
  overrunMinutes,
  splitPlan,
  timeLeftToday,
  workload,
  type TimeLeft,
  type Workload,
} from "@/lib/daily-plan";
import { reducedMotion } from "@/lib/motion";
import {
  formatDayHeading,
  formatDueTime,
  formatDuration,
  formatOverdue,
  PRIORITY_DOT,
} from "@/lib/task-utils";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { MAX_TOP_PRIORITIES } from "@/types/daily-plan";
import type { Task } from "@/types/task";

/** `?plan=open` on Tasks > Today opens the panel and scrolls to it. */
const PLAN_PARAM = "plan";

/** Where the dashboard's "Plan today" link goes. */
export const PLAN_TODAY_PATH = `/tasks/today?${PLAN_PARAM}=open`;

/** Whether the panel was last left open or closed, for this viewer only. */
const STORAGE_KEY = "routine-launcher.plan-today";

const DASHBOARD_PATH = "/";

/**
 * How many other tasks are listed before the rest wait behind "Show all".
 * The full list is directly under the panel, so this only needs enough to
 * pick from without pushing that list off the screen.
 */
const OTHERS_SHOWN = 6;

/** How many unestimated tasks are named before "and N more". */
const UNESTIMATED_NAMED = 3;

interface PlanTodayProps {
  /** Today's view, as the list under the panel has it. */
  tasks: Task[];
  tasksLoading: boolean;
  tasksError: string | null;
  plan: DailyPlanState;
}

/**
 * PLAN TODAY (development-plan.md sections 20 and 51), collapsible, at the
 * top of Tasks > Today.
 *
 * ```text
 * PLAN TODAY
 *
 * Saturday, August 15
 *
 * Top priorities:                 Other tasks:
 * 1. Finish project report        ☆ Reply to emails
 * 2. Complete database            ☆ Organize Downloads
 * 3. Study JavaScript             ☆ Review notes
 *
 * Estimated workload   Available focus time
 * 4h 10m               4h 45m · until 6:00 PM
 *
 * About 1h 20m more than the time left today.
 *
 *                                 [ Start My Day ]
 * ```
 *
 * A panel on the Today page rather than a page of its own, because section
 * 54 does not want a project-management tool and a plan is only ever about
 * the list under it. It reads that same list, so the two cannot disagree
 * about what today holds.
 *
 * Section 20 asks for "a quick overview of whether their planned workload is
 * realistic", so the workload and the time left are compared and an
 * overfull day gets one quiet sentence. Nothing is blocked, moved or
 * rescheduled.
 *
 * Start My Day hands over to A4's dialog, which the dashboard mounts, the
 * same way the tray menu and the quick launcher open it.
 */
function PlanToday({ tasks, tasksLoading, tasksError, plan }: PlanTodayProps) {
  const now = useNow();
  const daily = useSettingsStore((state) => state.daily);
  const navigate = useNavigate();
  const [open, setOpen, panel] = usePanelOpen();

  const { priorities, others } = splitPlan(tasks, plan.taskIds);
  const work = workload(tasks);
  const left = timeLeftToday(daily, now);
  const ready = !tasksLoading && tasksError === null && plan.hasLoaded;

  // Saved from what is on screen, so a pick that has left today's list
  // (moved to another day) drops out on the next change.
  const ids = priorities.map((task) => task.id);
  const isFull = ids.length >= MAX_TOP_PRIORITIES;

  const add = (task: Task) => {
    if (!isFull) void plan.save([...ids, task.id]);
  };
  const remove = (task: Task) => void plan.save(ids.filter((id) => id !== task.id));
  const move = (index: number, by: -1 | 1) => {
    const next = [...ids];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    void plan.save(next);
  };

  function startMyDay() {
    navigate(DASHBOARD_PATH);
    useAppStore.getState().requestStartMyDay();
  }

  return (
    <section
      ref={panel}
      aria-labelledby="plan-today-heading"
      className="flex scroll-mt-4 flex-col rounded-lg border px-3 py-2"
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="plan-today-body"
        className="flex w-full items-center gap-2 rounded-md py-1 text-left"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
          aria-hidden
        />
        <span
          id="plan-today-heading"
          className="text-xs font-medium tracking-widest text-muted-foreground"
        >
          PLAN TODAY
        </span>
        {!open && ready && (
          <span className="ml-auto truncate text-xs text-muted-foreground">
            {collapsedSummary(priorities.length, work, left)}
          </span>
        )}
      </button>

      {open && (
        <div id="plan-today-body" className="flex flex-col gap-4 px-1 pt-2 pb-2">
          <p className="text-sm font-medium">{formatDayHeading(now)}</p>

          {tasksError !== null ? (
            <p className="text-sm text-muted-foreground">
              Today&apos;s tasks could not be read, so there is nothing to plan yet.
            </p>
          ) : plan.error !== null && !plan.hasLoaded ? (
            <InlineError
              message={`Today's priorities could not be read. ${plan.error}`}
              onRetry={plan.reload}
            />
          ) : !ready ? (
            <PlanSkeleton />
          ) : priorities.length === 0 && others.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing on today&apos;s list yet. Add a task and it can be planned here.
            </p>
          ) : (
            <>
              <div className="grid gap-5 md:grid-cols-2">
                <Priorities priorities={priorities} onMove={move} onRemove={remove} />
                <Others others={others} isFull={isFull} onAdd={add} />
              </div>
              <Figures work={work} left={left} />
            </>
          )}

          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={startMyDay}>
              <Sun />
              Start My Day
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Whether the panel is open, remembered per viewer, and opened by
 * {@link PLAN_TODAY_PATH}. Open until the user closes it: a first visit
 * should show what the panel is for.
 *
 * The param is taken rather than kept, so closing the panel and reloading
 * does not open it again, and Back does not land on a second copy of the
 * address.
 */
function usePanelOpen(): [boolean, (open: boolean) => void, React.RefObject<HTMLElement | null>] {
  const [params, setParams] = useSearchParams();
  const requested = params.get(PLAN_PARAM) !== null;
  const [open, setOpenState] = useState(() => requested || readStoredOpen());
  const panel = useRef<HTMLElement>(null);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    storeOpen(next);
  }, []);

  useEffect(() => {
    if (!requested) return;
    setOpen(true);
    panel.current?.scrollIntoView({
      block: "start",
      behavior: reducedMotion() ? "auto" : "smooth",
    });
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(PLAN_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [requested, setOpen, setParams]);

  return [open, setOpen, panel];
}

function readStoredOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "closed";
  } catch {
    return true;
  }
}

function storeOpen(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // Only the next visit's starting state is lost.
  }
}

/** The closed panel's one line, e.g. `2 priorities · 3h 20m of work · 4h 45m left`. */
function collapsedSummary(picked: number, work: Workload, left: TimeLeft): string {
  const parts = [
    picked === 0 ? "No priorities picked" : `${picked} ${picked === 1 ? "priority" : "priorities"}`,
  ];
  if (work.minutes > 0) parts.push(`${formatWorkMinutes(work.minutes)} of work`);
  parts.push(left.phase === "after" ? "day over" : `${formatWorkMinutes(left.minutes)} left`);
  return parts.join(" · ");
}

/* -------------------------------------------------------------------------- */
/* The two lists                                                              */
/* -------------------------------------------------------------------------- */

function ListHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="px-1 text-xs font-medium text-muted-foreground">{children}</h3>;
}

/** Section 51's "Top priorities": up to three, numbered, in the order picked. */
function Priorities({
  priorities,
  onMove,
  onRemove,
}: {
  priorities: Task[];
  onMove: (index: number, by: -1 | 1) => void;
  onRemove: (task: Task) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <ListHeading>Top priorities</ListHeading>

      {priorities.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">
          Star up to {MAX_TOP_PRIORITIES} of today&apos;s tasks to do first. They are numbered
          here and marked in the list below.
        </p>
      ) : (
        <ol className="flex flex-col">
          {priorities.map((task, index) => {
            const isDone = !isOpenTask(task);
            return (
              <li
                key={task.id}
                className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-accent/50"
              >
                <span className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {index + 1}.
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm",
                    isDone && "text-muted-foreground line-through decoration-muted-foreground/50",
                  )}
                >
                  {task.title}
                </span>
                <div className="flex shrink-0 items-center text-muted-foreground">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    disabled={index === 0}
                    onClick={() => onMove(index, -1)}
                    aria-label={`Move "${task.title}" up`}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    disabled={index === priorities.length - 1}
                    onClick={() => onMove(index, 1)}
                    aria-label={`Move "${task.title}" down`}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => onRemove(task)}
                    aria-label={`Take "${task.title}" out of the top priorities`}
                  >
                    <X />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/**
 * Section 51's "Other tasks": the rest of today still to do, each with a
 * star that makes it a priority. Finished ones are counted rather than
 * listed, since there is nothing left to plan about them.
 */
function Others({
  others,
  isFull,
  onAdd,
}: {
  others: Task[];
  isFull: boolean;
  onAdd: (task: Task) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const open = others.filter(isOpenTask);
  const done = others.length - open.length;
  const shown = showAll ? open : open.slice(0, OTHERS_SHOWN);
  const hidden = open.length - shown.length;

  return (
    <div className="flex flex-col gap-1">
      <ListHeading>Other tasks</ListHeading>

      {open.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">Nothing else left to do today.</p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((task) => {
            const duration = formatDuration(task.estimated_minutes);
            const overdue = formatOverdue(task);
            return (
              <li key={task.id} className="flex items-center gap-2 rounded-md px-1 py-0.5">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  disabled={isFull}
                  onClick={() => onAdd(task)}
                  aria-label={`Make "${task.title}" a top priority`}
                >
                  <Star />
                </Button>
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", PRIORITY_DOT[task.priority])}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
                {overdue && (
                  <span className="shrink-0 text-xs text-priority-urgent">{overdue}</span>
                )}
                {duration && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {duration}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-x-3 px-1 text-xs text-muted-foreground">
        {hidden > 0 && (
          <Button
            variant="link"
            size="xs"
            className="h-auto px-0 text-muted-foreground"
            onClick={() => setShowAll(true)}
          >
            Show all {open.length}
          </Button>
        )}
        {isFull && open.length > 0 && (
          <span>{MAX_TOP_PRIORITIES} picked. Take one out to swap it for another.</span>
        )}
        {done > 0 && <span>{done} already done</span>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Workload against time                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Section 51's "Estimated workload" and section 20's "Available focus time",
 * side by side, with the one sentence section 20 is for when the first is
 * bigger than the second.
 */
function Figures({ work, left }: { work: Workload; left: TimeLeft }) {
  const overrun = work.minutes > 0 ? overrunMinutes(work.minutes, left.minutes) : null;

  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-2 gap-3">
        <Figure label="Estimated workload" value={workloadValue(work)} />
        <Figure
          label="Available focus time"
          value={formatWorkMinutes(left.minutes)}
          note={timeLeftNote(left)}
        />
      </dl>

      {work.unestimated.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Not counted, no estimate: {nameTasks(work.unestimated)}.
        </p>
      )}
      {overrun !== null && (
        <p className="text-xs text-muted-foreground">
          About {formatWorkMinutes(overrun)} more than the time left today.
        </p>
      )}
    </div>
  );
}

/**
 * The workload as a figure. Open tasks with not one estimate among them are
 * a dash rather than "0m", which would say there is nothing to do.
 */
function workloadValue(work: Workload): string {
  if (work.minutes > 0) return formatWorkMinutes(work.minutes);
  return work.unestimated.length > 0 ? "—" : "0m";
}

function timeLeftNote({ phase, from, until }: TimeLeft): string {
  const end = formatClock(until);
  if (phase === "before") return `${formatClock(from)} – ${end}`;
  if (phase === "during") return `Until ${end}`;
  return `Your day ended at ${end}`;
}

/** A `Date` as `6:00 PM`, the way due times are written. */
function formatClock(date: Date): string {
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return formatDueTime(hhmm) ?? hhmm;
}

/** `Reply to emails, Review notes and 2 more`. */
function nameTasks(tasks: Task[]): string {
  const named = tasks.slice(0, UNESTIMATED_NAMED).map((task) => task.title);
  const rest = tasks.length - named.length;
  if (rest > 0) return `${named.join(", ")} and ${rest} more`;
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-muted/50 px-3 py-2">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      {note && <dd className="truncate text-xs text-muted-foreground">{note}</dd>}
    </div>
  );
}

function PlanSkeleton() {
  return (
    <div role="status" aria-busy className="flex flex-col gap-2">
      <span className="sr-only">Loading today&apos;s plan</span>
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-4 w-56" aria-hidden />
      ))}
      <Skeleton className="mt-2 h-16 w-full" aria-hidden />
    </div>
  );
}

export default PlanToday;
