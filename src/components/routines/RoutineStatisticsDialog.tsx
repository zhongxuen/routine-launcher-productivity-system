import ErrorState from "@/components/common/states/ErrorState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatFocusTime, formatLastUsed, formatSessionLength } from "@/lib/routine-utils";
import { useRoutineStore } from "@/stores/routineStore";
import type { RoutineStatistics } from "@/types/analytics";

import RoutineIcon from "./RoutineIcon";

/** What a figure with nothing behind it yet renders as. */
const NOT_TRACKED = "—";

/**
 * A routine's statistics (development-plan.md section 33): the five figures
 * that turn a launcher into long-term feedback.
 *
 * ```text
 * Coding Mode
 *
 * Launches:        42
 * Focus time:      36h 20m
 * Average session: 51m
 * Tasks completed: 37
 * Last used:       Today
 * ```
 *
 * All five are measured now. Three of them used to be a dash and a footnote,
 * because through Stages 2 to 10 nothing wrote `focus_sessions` and nothing
 * set `tasks.routine_id`; Stage 4's focus timer and Stage 3's task/routine
 * link closed both, and Stage 11 reads across them
 * (`services/analytics.rs`). So a zero here now means zero — the panel no
 * longer has to distinguish "none" from "not counted".
 *
 * The one exception is the average, which stays a dash when there are no
 * sessions: no sessions is not a session of no length, and "0m" would read as
 * a measurement.
 *
 * `launches` is the lifetime count on the routine row rather than a count of
 * the dated launch log — the row predates the log (migration 0007) and so
 * remembers launches the log never saw.
 */
function RoutineStatisticsDialog() {
  const routine = useRoutineStore((state) =>
    state.routines.find((candidate) => candidate.id === state.statisticsRoutineId),
  );
  const statistics = useRoutineStore((state) =>
    state.statisticsRoutineId === null ? undefined : state.statistics[state.statisticsRoutineId],
  );
  const error = useRoutineStore((state) => state.statisticsError);
  const loadStatistics = useRoutineStore((state) => state.loadStatistics);
  const closeStatistics = useRoutineStore((state) => state.closeStatistics);

  if (!routine) return null;

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

        {/* Three answers: the figures if we have them, the failure if the
            read reported one, and the skeleton otherwise. The error is
            checked before the wait rather than after it — a statistics read
            that failed used to leave the skeleton up permanently, which is
            the one thing a loading state must never turn into. */}
        {statistics ? (
          <Figures statistics={statistics} />
        ) : error ? (
          <ErrorState
            title="Could not load these figures."
            message={error}
            onRetry={() => void loadStatistics()}
            className="py-6"
          />
        ) : (
          <Loading />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Section 33's five, in its order. */
function Figures({ statistics }: { statistics: RoutineStatistics }) {
  return (
    <dl className="grid grid-cols-2 gap-4">
      <Stat label="Launches" value={String(statistics.launches)} />
      <Stat label="Focus time" value={formatFocusTime(statistics.focusSeconds)} />
      <Stat
        label="Average session"
        value={
          statistics.averageSessionSeconds === null
            ? null
            : formatSessionLength(statistics.averageSessionSeconds)
        }
      />
      <Stat label="Tasks completed" value={String(statistics.tasksCompleted)} />
      <Stat label="Last used" value={formatLastUsed(statistics.lastUsed)} />
    </dl>
  );
}

/**
 * The panel while the figures are still on their way.
 *
 * Five bars in the grid the numbers land in, rather than an empty box or a
 * spinner, so opening the panel does not change size a moment later.
 */
function Loading() {
  return (
    <div role="status" aria-busy className="grid grid-cols-2 gap-4">
      <span className="sr-only">Loading this routine&apos;s figures</span>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5" aria-hidden>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  );
}

/**
 * One figure from section 33: the label above, the number below.
 *
 * A null value is a figure with nothing to average, drawn as a dash in the
 * muted colour so it reads as absent rather than as zero.
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
