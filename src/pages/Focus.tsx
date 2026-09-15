import { Coffee, Timer } from "lucide-react";
import { Link, Outlet } from "react-router-dom";

import SubNav from "../components/common/SubNav";
import { displaySeconds, formatClock } from "@/lib/focus-utils";
import { useFocusStore } from "@/stores/focusStore";
import type { ActiveFocusSession, FocusBreak } from "@/types/focus-ui";

const SUB_NAV_ITEMS = [
  { to: "/focus/timer", label: "Timer" },
  { to: "/focus/history", label: "History" },
];

function Focus() {
  const session = useFocusStore((state) => state.session);
  const focusBreak = useFocusStore((state) => state.focusBreak);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Focus</h1>
        {session ? (
          <RunningSessionPill session={session} />
        ) : (
          focusBreak?.status === "running" && <BreakPill focusBreak={focusBreak} />
        )}
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

/**
 * The same, for a break: `Break · 4:12`, in the break's colour so it is not
 * read as a session from across the page. Only while it runs — a break that
 * is over is waiting on the Timer view, and a pill saying so would be a
 * notification about a notification.
 */
function BreakPill({ focusBreak }: { focusBreak: FocusBreak }) {
  return (
    <Link
      to="/focus/timer"
      className="flex items-center gap-2 rounded-full border px-3 py-1 text-sm text-focus-break transition-colors hover:bg-accent"
    >
      <Coffee className="size-3.5" />
      <span>
        Break · <span className="tabular-nums">{formatClock(focusBreak.remainingSeconds)}</span>
      </span>
    </Link>
  );
}

export default Focus;
