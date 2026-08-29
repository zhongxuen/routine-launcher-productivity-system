/**
 * The dashboard's QUICK START row (development-plan.md section 7).
 *
 * Section 7 ranks "quick routine launching" second only to today's tasks, and
 * draws it as a row of small tiles — icon, name, START — rather than the full
 * checklist cards of section 29. The difference is the point: My Routines is
 * where a routine is read and edited, the dashboard is where it is *started*,
 * so a tile here carries only what is needed to recognise the workspace and
 * one button that opens it.
 *
 * Which routines appear is the widget's own policy — see `quickStartRoutines`
 * below. There is no pinning in the schema (section 59 stores name,
 * description, icon, the timestamps and `launch_count`), so "most-used" is
 * what the data can actually answer, and the ranking degrades sensibly for a
 * user who has not launched anything yet.
 *
 * Self-contained, per Prompt 6.2: it loads its own data, owns its heading, and
 * mounts the launch panel it needs. `Dashboard.tsx` composes it in Prompt 6.5
 * with no props.
 */

import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { Loader2, Play, Plus } from "lucide-react";

import RoutineIcon from "@/components/routines/RoutineIcon";
import RoutineLaunchDialog from "@/components/routines/RoutineLaunchDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { actionSummary } from "@/lib/routine-utils";
import { parseTimestamp } from "@/lib/task-utils";
import { useRoutineStore } from "@/stores/routineStore";
import type { RoutineWithActions } from "@/types/routine";

/**
 * How many tiles the row holds.
 *
 * Section 7's mockup draws three; four fits the same row at desktop width and
 * costs nothing at narrower ones, where the grid falls to two columns. Past
 * that the row stops being a shortcut and starts being the routine list,
 * which is what "See all" is for.
 */
const MAX_QUICK_START = 4;

/**
 * The routines the dashboard offers, most-used first.
 *
 * Launch count is the ranking, because it is the only signal the schema
 * records about preference and it is exactly the one section 6.2 asks for.
 * Ties break on the most recently launched, then on name, so the row is
 * stable between renders and never reshuffles under a click.
 *
 * A user with no launches yet still gets tiles — every count is zero, so the
 * order falls through to name. That is deliberate: an empty QUICK START on an
 * account that *has* routines would be the widget refusing to do its one job
 * until the user had already done it elsewhere.
 *
 * Exported for the composing page and for anything that later wants the same
 * ranking (the tray's shortcut list in Stage 8 is the obvious candidate).
 */
export function quickStartRoutines(
  routines: RoutineWithActions[],
  limit: number = MAX_QUICK_START,
): RoutineWithActions[] {
  return [...routines].sort(compareByUse).slice(0, limit);
}

function compareByUse(a: RoutineWithActions, b: RoutineWithActions): number {
  if (a.launch_count !== b.launch_count) return b.launch_count - a.launch_count;

  const lastUsed = (routine: RoutineWithActions) =>
    parseTimestamp(routine.last_launched_at)?.getTime() ?? 0;
  const recency = lastUsed(b) - lastUsed(a);
  if (recency !== 0) return recency;

  return a.name.localeCompare(b.name);
}

/**
 * Section 7's QUICK START row.
 *
 * The tiles are driven by the same store as My Routines, so a routine renamed
 * or deleted on the Routines page is renamed or gone here on the next read,
 * and a launch started from either place lands in the same panel.
 */
function QuickStart() {
  const routines = useRoutineStore((state) => state.routines);
  const isLoading = useRoutineStore((state) => state.isLoading);
  const error = useRoutineStore((state) => state.error);
  const loadRoutines = useRoutineStore((state) => state.loadRoutines);

  // The store is shared, so this is a no-op refresh when the user arrived
  // from the Routines page and the only read that happens when they did not.
  useEffect(() => {
    void loadRoutines();
  }, [loadRoutines]);

  const featured = useMemo(() => quickStartRoutines(routines), [routines]);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="quick-start-heading">
      <div className="flex items-baseline justify-between gap-4">
        <h2
          id="quick-start-heading"
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Quick Start
        </h2>

        {routines.length > featured.length && (
          <Button variant="link" size="xs" className="px-0 text-muted-foreground" asChild>
            <Link to="/routines/my-routines">See all {routines.length}</Link>
          </Button>
        )}
      </div>

      <QuickStartBody isLoading={isLoading} error={error} routines={featured} />

      {/*
        The launch panel (section 32) is store-driven and rendered by whichever
        page can start a routine — the Routines layout mounts its own. Mounting
        it here is what makes a dashboard START show its checklist instead of
        opening apps silently, and the two never coexist because they are on
        different routes.
      */}
      <RoutineLaunchDialog />
    </section>
  );
}

interface QuickStartBodyProps {
  isLoading: boolean;
  error: string | null;
  routines: RoutineWithActions[];
}

/** The row itself, or whatever stands in for it. */
function QuickStartBody({ isLoading, error, routines }: QuickStartBodyProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: MAX_QUICK_START }, (_, index) => (
          <Skeleton key={index} className="h-32 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card className="items-center gap-2 py-6 text-center">
        <p className="px-6 text-sm text-muted-foreground">Could not load your routines.</p>
        <Button variant="outline" size="sm" asChild>
          <Link to="/routines/my-routines">Open Routines</Link>
        </Button>
      </Card>
    );
  }

  if (routines.length === 0) {
    return (
      <Card className="items-center gap-2 py-6 text-center">
        <p className="px-6 text-sm text-muted-foreground">
          No routines yet — a routine opens your whole workspace at once.
        </p>
        <Button variant="outline" size="sm" asChild>
          <Link to="/routines/create">
            <Plus className="size-4" />
            Create your first routine
          </Link>
        </Button>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {routines.map((routine) => (
        <QuickStartTile key={routine.id} routine={routine} />
      ))}
    </div>
  );
}

interface QuickStartTileProps {
  routine: RoutineWithActions;
}

/** One tile: what the workspace is, and the button that opens it. */
function QuickStartTile({ routine }: QuickStartTileProps) {
  const launchRoutine = useRoutineStore((state) => state.launchRoutine);
  const runningRoutineId = useRoutineStore((state) =>
    state.run?.status === "running" ? state.run.routineId : null,
  );

  // A routine whose every action is disabled would report success having done
  // nothing, so it is not offered — the same rule the section 29 card uses.
  const hasActions = routine.actions.some((action) => action.enabled);
  const isRunning = runningRoutineId !== null;
  const isThisRunning = runningRoutineId === routine.id;

  return (
    <Card className="h-full gap-3 px-4 py-4">
      <div className="flex flex-col gap-2">
        <RoutineIcon icon={routine.icon} className="size-9 text-lg" />
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium" title={routine.name}>
            {routine.name}
          </h3>
          <p className="truncate text-xs text-muted-foreground">
            {actionSummary(routine.actions)}
          </p>
        </div>
      </div>

      <Button
        size="sm"
        className="mt-auto w-full"
        onClick={() => void launchRoutine(routine.id)}
        disabled={isRunning || !hasActions}
        aria-label={`Start ${routine.name}`}
        title={hasActions ? undefined : "Add an action before launching this routine"}
      >
        {isThisRunning ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Starting…
          </>
        ) : (
          <>
            <Play className="size-4" />
            START
          </>
        )}
      </Button>
    </Card>
  );
}

export default QuickStart;
