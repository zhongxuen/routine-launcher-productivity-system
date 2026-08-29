import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
  const loadRoutines = useRoutineStore((state) => state.loadRoutines);

  useEffect(() => {
    void loadRoutines();
  }, [loadRoutines]);

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((key) => (
          <Skeleton key={key} className="h-64 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-14 text-center">
        <p className="text-sm text-muted-foreground">Could not load your routines.</p>
        <p className="text-xs text-muted-foreground/70">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void loadRoutines()}>
          Try again
        </Button>
      </div>
    );
  }

  if (routines.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-14 text-center">
        <p className="text-sm text-muted-foreground">No routines yet.</p>
        <p className="text-xs text-muted-foreground/70">
          A routine opens a whole workspace at once — apps, folders, links and a focus timer.
        </p>
        <Button size="sm" variant="outline" asChild>
          <Link to="/routines/create">
            <Plus className="size-4" />
            Create your first routine
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {routines.map((routine) => (
        <RoutineCard key={routine.id} routine={routine} />
      ))}
    </div>
  );
}

export default MyRoutines;
