import { useEffect } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { Plus } from "lucide-react";

import SubNav from "../components/common/SubNav";
import RoutineLaunchDialog from "../components/routines/RoutineLaunchDialog";
import RoutineStatisticsDialog from "../components/routines/RoutineStatisticsDialog";
import { Button } from "@/components/ui/button";
import { useRoutineStore } from "@/stores/routineStore";

const SUB_NAV_ITEMS = [
  { to: "/routines/my-routines", label: "My Routines" },
  { to: "/routines/create", label: "Create Routine" },
  { to: "/routines/templates", label: "Templates" },
];

/**
 * Routines section layout: the tabs, the active view via <Outlet />, and the
 * two panels that any of them can raise.
 *
 * The launch panel (section 32) and the statistics panel (section 33) live
 * here rather than inside the card that opens them, because both are driven
 * by the store — a routine started from the dashboard or the tray later on
 * should surface in the same panel, not a second copy of it.
 */
function Routines() {
  const { pathname } = useLocation();
  const closeStatistics = useRoutineStore((state) => state.closeStatistics);

  // Statistics belong to the card that opened them. Switching tabs leaves that
  // card behind, so the panel goes with it — a launch, by contrast, keeps its
  // panel, because the routine really is still starting.
  useEffect(() => closeStatistics(), [pathname, closeStatistics]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Routines</h1>
        <Button size="sm" variant="outline" asChild>
          <Link to="/routines/create">
            <Plus className="size-4" />
            New Routine
          </Link>
        </Button>
      </div>

      <SubNav items={SUB_NAV_ITEMS} />
      <Outlet />

      <RoutineLaunchDialog />
      <RoutineStatisticsDialog />
    </div>
  );
}

export default Routines;
