import { useEffect, useMemo } from "react";
import { ChevronDown, Loader2, Rocket, X } from "lucide-react";

import { quickStartRoutines } from "@/components/dashboard/QuickStart";
import ErrorState from "@/components/common/states/ErrorState";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { runCounts } from "@/lib/routine-utils";
import { cn } from "@/lib/utils";
import { useRoutineStore } from "@/stores/routineStore";
import type { RoutineWithActions } from "@/types/routine";
import type { RoutineRun } from "@/types/routine-ui";

/**
 * How long a clean launch's result stays on screen before the popup returns
 * to rest. A partial one is never cleared on a timer — see {@link RunLine}.
 */
const SUCCESS_LINGER_MS = 4_000;

/**
 * Section 25's `🚀 Start Coding` — the popup's one-click routine launch.
 *
 * The mockup draws a single button, and that is what the common case gets:
 * the routine you launch most, ranked by the same `quickStartRoutines` the
 * dashboard's QUICK START row uses, so the workspace the popup offers is the
 * one the dashboard would have put first. Reusing that function rather than
 * re-deriving "most used" is the point — two places disagreeing about which
 * routine is the obvious one would be worse than either answer.
 *
 * Everything else the user owns is behind the chevron. A dropdown costs one
 * extra click for the routines that are not the usual one and keeps the
 * resting window at the mockup's single line, which is the trade a window
 * this size wants.
 *
 * **What it does not do is mount the section 32 launch panel.** That panel is
 * a full checklist with Retry and Continue, and it is the right thing on a
 * 1200px dashboard; dropped into 340px it would bury the list it sits under.
 * So the launch is started through the same `routineStore.launchRoutine` —
 * same command, same recorded launch, same `launch_count` — and reported as
 * one line. When a run needs the panel's decisions, the line says so and
 * hands the user to the app, which is the one moment section 25's "should not
 * require opening the full application" stops applying: a routine that half
 * failed is not a glance any more.
 */
function PopupRoutineLaunch() {
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
  // action is disabled reports success having opened nothing, which is the
  // same rule the routine card and the dashboard tile apply.
  const launchable = useMemo(
    () => quickStartRoutines(routines.filter(hasEnabledActions), routines.length),
    [routines],
  );

  const [featured, ...rest] = launchable;
  // The name of the routine currently opening, or null when none is. Doubles
  // as the "a launch is in flight" flag, so the button's label and its
  // disabled state can never disagree.
  const runningName = run?.status === "running" ? run.routineName : null;
  const isRunning = runningName !== null;

  if (isLoading && routines.length === 0) {
    return (
      <div role="status" aria-busy>
        <span className="sr-only">Loading your routines</span>
        <Skeleton className="h-8 w-full rounded-md" aria-hidden />
      </div>
    );
  }

  if (error) {
    // The retry belongs here rather than in the app: this window is summoned
    // by a tray click and dismissed by a keystroke, so "go and reopen the
    // main window" is a long way round for a read that will probably work on
    // the second press.
    return (
      <ErrorState
        size="compact"
        className="px-0"
        title="Could not read your routines."
        onRetry={() => void loadRoutines()}
        retryLabel="Retry"
      />
    );
  }

  // Nothing to launch — either no routines at all, or none with an enabled
  // action. Both are the same fact from here and neither is fixable in a
  // window this size, so the popup says so in one line rather than growing an
  // empty state with a call to action it cannot fulfil.
  if (!featured) {
    return (
      <p className="text-[11px] leading-tight text-muted-foreground">
        No routine to launch yet — build one in the app.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-stretch gap-1.5">
        <Button
          size="sm"
          className="min-w-0 flex-1 justify-start"
          disabled={isRunning}
          onClick={() => void launchRoutine(featured.id)}
          title={`Start ${featured.name}`}
          aria-label={`Start ${featured.name}`}
        >
          {isRunning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RoutineGlyph icon={featured.icon} />
          )}
          {/* The routine's own name, not "Start <name>" — section 25's button
              is `🚀 Start Coding`, and a routine called "Start Coding" would
              otherwise read "Start Start Coding". A filled primary button
              under a rocket does not need a verb to be understood as one; the
              accessible name below still spells the action out. */}
          <span className="truncate">
            {runningName ? `Starting ${runningName}…` : featured.name}
          </span>
        </Button>

        {rest.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="px-2"
                disabled={isRunning}
                aria-label="Start a different routine"
              >
                <ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            {/* Anchored to the end and opening upwards: the button sits at the
                bottom of the window, so a downward menu would have nowhere to
                go. */}
            <DropdownMenuContent align="end" side="top" className="max-w-[16rem]">
              {rest.map((routine) => (
                <DropdownMenuItem
                  key={routine.id}
                  onSelect={() => void launchRoutine(routine.id)}
                >
                  <RoutineGlyph icon={routine.icon} />
                  <span className="truncate">{routine.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
 * A routine's emoji, or the rocket the mockup draws. Smaller and barer than
 * `RoutineIcon`, which is a tile: inside a button the glyph is the icon.
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
 * outlives the thing it is about is clutter. A partial one stays until it is
 * dismissed, because it is the only mention the failure will get — the popup
 * has no Retry, so the line's job is to be visible long enough to send the
 * user to the app where Retry lives.
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
    <div className="flex items-center gap-1.5">
      <p
        className={cn(
          "min-w-0 flex-1 truncate text-[11px] leading-tight",
          isPartial ? "text-priority-urgent" : "text-muted-foreground",
        )}
      >
        {isPartial
          ? `${completed} / ${attempted} started · ${failed} failed — retry in the app`
          : `${run.routineName} is open · ${completed} / ${attempted} actions`}
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

export default PopupRoutineLaunch;
