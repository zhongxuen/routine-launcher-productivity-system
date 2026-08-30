import { Timer } from "lucide-react";
import { Link, Outlet } from "react-router-dom";

import SubNav from "../components/common/SubNav";
import { displaySeconds, formatClock } from "@/lib/focus-utils";
import { useFocusStore } from "@/stores/focusStore";
import type { ActiveFocusSession } from "@/types/focus-ui";

const SUB_NAV_ITEMS = [
  { to: "/focus/timer", label: "Timer" },
  { to: "/focus/history", label: "History" },
];

function Focus() {
  const session = useFocusStore((state) => state.session);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Focus</h1>
        {session && <RunningSessionPill session={session} />}
      </div>
      <SubNav items={SUB_NAV_ITEMS} label="Focus views" />
      <Outlet />
    </div>
  );
}

/**
 * The running clock, kept in view while the user is reading History.
 *
 * It is also the cheapest proof that the timer is not the Timer view's: the
 * two are looking at the same session in `focusStore` from different routes,
 * and this one keeps counting on a page that has never rendered a clock.
 */
function RunningSessionPill({ session }: { session: ActiveFocusSession }) {
  return (
    <Link
      to="/focus/timer"
      className="flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors hover:bg-accent"
    >
      <Timer className="size-3.5 text-muted-foreground" />
      <span className="tabular-nums">{formatClock(displaySeconds(session))}</span>
      <span className="text-muted-foreground">
        {session.status === "paused" ? "paused" : "focusing"}
      </span>
    </Link>
  );
}

export default Focus;
