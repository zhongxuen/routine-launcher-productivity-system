import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatFocusTime, formatLastUsed, formatSessionLength } from "@/lib/routine-utils";
import { useRoutineStore } from "@/stores/routineStore";
import type { RoutineWithActions } from "@/types/routine";
import type { RoutineStatistics } from "@/types/routine-ui";

import RoutineIcon from "./RoutineIcon";

/** What a figure with no source yet renders as. */
const NOT_TRACKED = "—";

/**
 * Section 33's figures for one routine.
 *
 * `launches` and `lastUsed` are measured: they are the `launch_count` and
 * `last_launched_at` columns the backend stamps inside `launch_routine`, so
 * pressing START and closing the panel moves them straight away — the store
 * re-reads the list after every launch.
 *
 * TODO (Stage 4 / Stage 1): the other three have no source yet and are
 * therefore null rather than a number.
 *
 * - `focusSeconds` is `SUM(duration_seconds)` over `focus_sessions` where
 *   `routine_id = ?` and `completed = 1`, and `averageSessionSeconds` is the
 *   same rows averaged. Nothing writes `focus_sessions` until Stage 4's focus
 *   timer lands — the `routine://timer-requested` event a routine already
 *   emits is what will start those sessions.
 * - `tasksCompleted` is `COUNT(*)` over `tasks` where `routine_id = ?` and
 *   `completed = 1`. The column exists (migration 0001), but nothing sets it
 *   until Stage 1's task views can assign a task to a routine.
 *
 * Both queries belong in a `routine_stats` service function returning this
 * whole block, so this component keeps reading one shape either way.
 */
function statisticsFor(routine: RoutineWithActions): RoutineStatistics {
  return {
    launches: routine.launch_count,
    lastUsed: routine.last_launched_at,
    focusSeconds: null,
    averageSessionSeconds: null,
    tasksCompleted: null,
  };
}

/**
 * A routine's statistics (development-plan.md section 33): the five figures
 * that turn a launcher into long-term feedback.
 *
 * Two of them are measured and three are not collected yet, which the panel
 * says outright by showing a dash and a footnote rather than a number — an
 * invented figure that reads as a measured one is worse than no figure at
 * all, and section 88 asks the app not to flatter.
 */
function RoutineStatisticsDialog() {
  const routine = useRoutineStore((state) =>
    state.routines.find((candidate) => candidate.id === state.statisticsRoutineId),
  );
  const closeStatistics = useRoutineStore((state) => state.closeStatistics);

  if (!routine) return null;

  const statistics = statisticsFor(routine);

  return (
    <Dialog open onOpenChange={(open) => !open && closeStatistics()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <RoutineIcon icon={routine.icon} className="size-7 text-base" />
            {routine.name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Launches, focus time, average session length, tasks completed and last use.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-2 gap-4">
          <Stat label="Launches" value={String(statistics.launches)} />
          <Stat
            label="Focus time"
            value={statistics.focusSeconds === null ? null : formatFocusTime(statistics.focusSeconds)}
          />
          <Stat
            label="Average session"
            value={
              statistics.averageSessionSeconds === null
                ? null
                : formatSessionLength(statistics.averageSessionSeconds)
            }
          />
          <Stat
            label="Tasks completed"
            value={statistics.tasksCompleted === null ? null : String(statistics.tasksCompleted)}
          />
          <Stat label="Last used" value={formatLastUsed(statistics.lastUsed)} />
        </dl>

        <p className="text-xs text-muted-foreground/70">
          Focus time, average session and tasks completed start filling in once focus sessions are
          recorded and tasks can be linked to a routine.
        </p>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One figure from section 33: the label above, the number below.
 *
 * A null value is a figure nothing measures yet, drawn as a dash in the muted
 * colour so it reads as absent rather than as zero.
 */
function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          value === null
            ? "text-xl font-medium tabular-nums text-muted-foreground/40"
            : "text-xl font-medium tabular-nums"
        }
      >
        {value ?? NOT_TRACKED}
      </dd>
    </div>
  );
}

export default RoutineStatisticsDialog;
