import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRoutineStore } from "@/stores/routineStore";

import RoutineBuilder from "./RoutineBuilder";

/**
 * The Create Routine view (development-plan.md section 31), which doubles as
 * the edit view: `/routines/create?routine=3` loads that routine into the
 * same builder. One form for both, because "edit" and "create" differ only in
 * what the fields start out holding.
 */
function CreateRoutine() {
  const [searchParams] = useSearchParams();
  const routines = useRoutineStore((state) => state.routines);
  const isLoading = useRoutineStore((state) => state.isLoading);
  const loadRoutines = useRoutineStore((state) => state.loadRoutines);

  // Deep-linking straight to the edit form has to work, so the list is read
  // here too rather than assumed to have been loaded by My Routines.
  useEffect(() => {
    void loadRoutines();
  }, [loadRoutines]);

  const requestedId = Number(searchParams.get("routine"));
  const editingId = Number.isInteger(requestedId) && requestedId > 0 ? requestedId : null;
  const routine = editingId === null
    ? null
    : (routines.find((candidate) => candidate.id === editingId) ?? null);

  if (editingId !== null && isLoading) {
    return <Skeleton className="h-96 max-w-3xl rounded-xl" />;
  }

  if (editingId !== null && !routine) {
    return (
      <div className="flex flex-col items-center gap-3 py-14 text-center">
        <p className="text-sm text-muted-foreground">That routine no longer exists.</p>
        <Button size="sm" variant="outline" asChild>
          <Link to="/routines/my-routines">Back to My Routines</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-0.5">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">
          {routine ? "EDIT ROUTINE" : "CREATE ROUTINE"}
        </p>
        <p className="text-sm text-muted-foreground">
          A routine opens a whole workspace at once. Add the apps, folders, links and timer it
          should start, in the order you want them.
        </p>
      </header>

      {/* Keyed so switching between create and edit starts a fresh form. */}
      <RoutineBuilder key={routine?.id ?? "new"} routine={routine} />
    </div>
  );
}

export default CreateRoutine;
