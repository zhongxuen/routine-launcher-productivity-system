import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Plus, Rocket } from "lucide-react";

import AsyncBody from "@/components/common/states/AsyncBody";
import StaleNotice from "@/components/common/states/StaleNotice";
import { Button } from "@/components/ui/button";
import { cardPhaseClass, useAnimatedList } from "@/hooks/useAnimatedList";
import { useRoutineStore } from "@/stores/routineStore";

import RoutineCard from "./RoutineCard";

/**
 * The routine list (development-plan.md section 29): one card per reusable
 * workspace, each showing what it opens and a button that opens it.
 *
 * Two columns from `md` up. A routine card is a checklist, so it stays
 * narrow — a full-width card would put six words on a very long line.
 */
function MyRoutines() {
  const routines = useRoutineStore((state) => state.routines);
  const isLoading = useRoutineStore((state) => state.isLoading);
  const error = useRoutineStore((state) => state.error);
  const statisticsError = useRoutineStore((state) => state.statisticsError);
  const loadRoutines = useRoutineStore((state) => state.loadRoutines);
  const loadStatistics = useRoutineStore((state) => state.loadStatistics);

  const cards = useAnimatedList(routines, (routine) => routine.id);

  useEffect(() => {
    void loadRoutines();
  }, [loadRoutines]);

  return (
    <div className="flex flex-col gap-4">
      <AsyncBody
        isLoading={isLoading}
        error={error}
        onRetry={() => void loadRoutines()}
        // `cards`, not `routines`: deleting the last routine would otherwise
        // swap straight to the empty state and cut the card's fade off at the
        // first frame.
        isEmpty={cards.length === 0}
        loadingLabel="Loading your routines"
        skeletonRows={2}
        skeletonRowClassName="h-64 rounded-xl"
        skeletonClassName="grid gap-4 md:grid-cols-2"
        errorTitle="Could not load your routines."
        emptyIcon={Rocket}
        emptyTitle="No routines yet."
        emptyHint="A routine opens a whole workspace at once — apps, folders, links and a focus timer."
        emptyAction={
          <Button size="sm" variant="outline" asChild>
            <Link to="/routines/create">
              <Plus className="size-4" />
              Create your first routine
            </Link>
          </Button>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          {/* Deleting a routine is the case this is for: the card is a
              confirmed, deliberate removal, and having it fade out is what
              tells the user the confirmation took. The wrapper carries the
              animation rather than the card so `RoutineCard` stays a card and
              knows nothing about the list it is in. */}
          {cards.map(({ key, item, phase }) => (
            <div key={key} className={cardPhaseClass(phase)}>
              <RoutineCard routine={item} />
            </div>
          ))}
        </div>
      </AsyncBody>

      {/* Section 33's figures are a second query behind the list. When only
          that one fails the cards are still right — they just fall back to
          the launch count — so the list stays and this line says why the
          focus time on it is missing. */}
      {statisticsError && routines.length > 0 && (
        <StaleNotice
          message="Focus time and task counts could not be read."
          onRetry={() => void loadStatistics()}
        />
      )}
    </div>
  );
}

export default MyRoutines;
