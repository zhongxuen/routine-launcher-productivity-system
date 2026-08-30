import { useEffect, useMemo } from "react";
import { Loader2, Rocket, X } from "lucide-react";

import { quickStartRoutines } from "@/components/dashboard/QuickStart";
import EmptyState from "@/components/common/states/EmptyState";
import ErrorState from "@/components/common/states/ErrorState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { runCounts } from "@/lib/routine-utils";
import { cn } from "@/lib/utils";
import { useRoutineStore } from "@/stores/routineStore";
import type { RoutineWithActions } from "@/types/routine";
import type { RoutineRun } from "@/types/routine-ui";

import WidgetHeading from "./WidgetHeading";
import { useFittedRows } from "./useFittedRows";

/** The height of one launch button plus the gap under it — `h-8` and `gap-1`. */
const LAUNCH_ROW_HEIGHT = 36;

/**
 * How long a clean launch's result stays on screen before the widget goes
 * back to being a list of buttons. A partial one is never cleared on a timer
 * — see {@link RunLine}.
 */
const SUCCESS_LINGER_MS = 4_000;

/**
 * Section 83's Routine Widget: the user's routines as one-click launches.
 *
 * ```text
 * ┌─────────────────────────┐
 * │ ROUTINES                │
 * │ 🚀 Start Coding         │
 * │ 💪 Morning Routine      │
 * │ 🎮 Gaming               │
 * └─────────────────────────┘
 * ```
 *
 * The only mode section 26 does not draw a mockup for, because it is the one
 * that needs no explaining: a row of buttons that open workspaces. It is also
 * the mode that most justifies the widget existing — a routine is something
 * you launch *before* you start working, which is exactly when the app is not
 * open.
 *
 * **Same launch path as the Stage 2 cards.** `routineStore.launchRoutine` is
 * the same command, the same recorded launch and the same `launch_count`, so
 * a routine started here is indistinguishable afterwards from one started
 * from the Routines page — and the store announces it, so the card's "Last
 * used" is right in the main window before the user looks back at it.
 *
 * **What it does not do is mount the section 32 launch panel.** That panel is
 * a full checklist with Retry and Continue, and it is right on a 1200px
 * dashboard; dropped into 300px it would bury the buttons it sits under. So
 * the result is one line, and when a run needs the panel's decisions the line
 * says so and sends the user to the app. This is the same call `PopupRoutineLaunch`
 * makes for the same reason.
 *
 * The order is the dashboard's QUICK START order — `quickStartRoutines`,
 * most-used first — because the widget shows as many as fit and the ones it
 * cuts should be the ones the user reaches for least. Two places disagreeing
 * about which routine is the obvious one would be worse than either answer.
 */
function WidgetRoutineMode() {
  const routines = useRoutineStore((state) => state.routines);
  const isLoading = useRoutineStore((state) => state.isLoading);
  const error = useRoutineStore((state) => state.error);
  const loadRoutines = useRoutineStore((state) => state.loadRoutines);
  const launchRoutine = useRoutineStore((state) => state.launchRoutine);
  const run = useRoutineStore((state) => state.run);

  useEffect(() => {
    void loadRoutines();
  }, [loadRoutines]);

  // Only routines that would actually do something. A routine whose every
  // action is disabled reports success having opened nothing — the same rule
  // the routine card, the dashboard tile and the popup apply.
  const launchable = useMemo(
    () => quickStartRoutines(routines.filter(hasEnabledActions), routines.length),
    [routines],
  );

  const { ref, visible, hidden } = useFittedRows<HTMLDivElement>(
    launchable.length,
    LAUNCH_ROW_HEIGHT,
  );

  // The name of the routine currently opening, or null when none is. Doubles
  // as the "a launch is in flight" flag, so no button's label and disabled
  // state can disagree.
  const runningId = run?.status === "running" ? run.routineId : null;
  const isRunning = runningId !== null;

  return (
    <div className="flex h-full flex-col gap-1">
      <WidgetHeading label="Routines" topmost />

      {/* The "+N more" line is inside the measured box on purpose — see
          `WidgetTaskList` for the feedback loop that keeping it outside
          would set up. */}
      <div ref={ref} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {isLoading && routines.length === 0 ? (
          <div role="status" aria-busy className="flex flex-col gap-1">
            <span className="sr-only">Loading your routines</span>
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-8 w-full rounded-md" aria-hidden />
            ))}
          </div>
        ) : error ? (
          // A read the user can ask for again. There is nowhere else in this
          // window to go and no toaster to catch it, so the retry lives on
          // the failure itself.
          <ErrorState
            size="compact"
            title="Could not read your routines."
            onRetry={() => void loadRoutines()}
            retryLabel="Retry"
          />
        ) : launchable.length === 0 ? (
          // No routines at all, or none with an enabled action. Both are the
          // same fact from here and neither is fixable in a window this size,
          // so the widget says so in one line rather than growing an empty
          // state with a call to action it cannot fulfil.
          <EmptyState size="compact" title="No routine to launch yet — build one in the app." />
        ) : (
          <div className="flex flex-col gap-1">
            {launchable.slice(0, visible).map((routine) => (
              <Button
                key={routine.id}
                size="sm"
                variant="secondary"
                className="h-8 w-full justify-start px-2"
                disabled={isRunning}
                onClick={() => void launchRoutine(routine.id)}
                title={`Start ${routine.name}`}
                aria-label={`Start ${routine.name}`}
              >
                {runningId === routine.id ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RoutineGlyph icon={routine.icon} />
                )}
                {/* The routine's own name, not "Start <name>" — a routine
                    called "Start Coding" would otherwise read "Start Start
                    Coding". The accessible name above still spells it out. */}
                <span className="truncate text-[0.8rem]">{routine.name}</span>
              </Button>
            ))}
          </div>
        )}

        {hidden > 0 && !isLoading && !error && (
          <p className="shrink-0 px-1 pt-1 text-[0.65rem] leading-none text-muted-subtle">
            +{hidden} more in the app
          </p>
        )}
      </div>

      {run && run.status !== "running" && <RunLine run={run} />}
    </div>
  );
}

/** True when the routine has at least one action that would actually run. */
const hasEnabledActions = (routine: RoutineWithActions): boolean =>
  routine.actions.some((action) => action.enabled);

/**
 * A routine's emoji, or a rocket. Smaller and barer than `RoutineIcon`, which
 * is a tile: inside a button the glyph is the icon.
 */
function RoutineGlyph({ icon }: { icon: string | null }) {
  return icon ? (
    <span aria-hidden className="text-sm leading-none">
      {icon}
    </span>
  ) : (
    <Rocket className="size-4" aria-hidden />
  );
}

/**
 * What happened, in one line.
 *
 * A clean run says so and clears itself: the workspace is open, the user is
 * looking at their apps rather than at this window, and a success notice that
 * outlives the thing it is about is clutter on a surface that is always
 * visible. A partial one stays until it is dismissed, because it is the only
 * mention the failure will get — the widget has no Retry, so the line's job
 * is to last long enough to send the user to the app where Retry lives.
 */
function RunLine({ run }: { run: RoutineRun }) {
  const closeRun = useRoutineStore((state) => state.closeRun);
  const { completed, attempted, failed } = runCounts(run.actions);
  const isPartial = run.status === "partial";

  useEffect(() => {
    if (isPartial) return;
    const id = window.setTimeout(() => closeRun(), SUCCESS_LINGER_MS);
    return () => window.clearTimeout(id);
  }, [isPartial, closeRun, run.routineId]);

  return (
    <div className="flex shrink-0 items-center gap-1">
      <p
        className={cn(
          "min-w-0 flex-1 truncate text-[0.65rem] leading-none",
          isPartial ? "text-priority-urgent" : "text-muted-foreground",
        )}
      >
        {isPartial
          ? `${completed}/${attempted} started · ${failed} failed — retry in the app`
          : `${run.routineName} is open · ${completed}/${attempted} actions`}
      </p>

      <Button
        size="icon-xs"
        variant="ghost"
        onClick={closeRun}
        aria-label="Dismiss launch result"
      >
        <X />
      </Button>
    </div>
  );
}

export default WidgetRoutineMode;
