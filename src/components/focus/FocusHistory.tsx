import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Timer } from "lucide-react";

import AsyncBody from "@/components/common/states/AsyncBody";
import { Button } from "@/components/ui/button";
import { FOCUS_TIMER_PATH } from "@/hooks/useStartFocus";
import { formatFocusLength, sortSessionsByRecency } from "@/lib/focus-utils";
import { useFocusStore } from "@/stores/focusStore";

import FocusSessionRow from "./FocusSessionRow";

/**
 * Focus > History (development-plan.md section 64) — every session that has
 * ended, newest first, with its length, what it was attached to and whether
 * it finished.
 *
 * Deliberately a list and not a report: section 36's statistics are Phase 11's
 * job, and the only number this view adds up is the one it can see. The
 * running session is not in here — it has not ended, so it has no length to
 * state, and the Timer view is where it lives. `only_ended` is what leaves it
 * out, so that is a rule the query keeps rather than one this view remembers.
 *
 * Read fresh from `focus_sessions` on every mount rather than trusted from
 * the store: sessions are also ended by things this page never saw — a window
 * closing on one, a launch closing the one before it — and coming back to
 * History is exactly when the user is asking what is actually on record.
 */
function FocusHistory() {
  const history = useFocusStore((state) => state.history);
  const isLoading = useFocusStore((state) => state.isHistoryLoading);
  const error = useFocusStore((state) => state.historyError);
  const loadHistory = useFocusStore((state) => state.loadHistory);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const sessions = sortSessionsByRecency(history);
  const focused = sessions.reduce((total, session) => total + (session.duration_seconds ?? 0), 0);

  return (
    <div className="flex flex-col gap-6 py-2">
      <header className="flex flex-col gap-0.5 px-2">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">HISTORY</p>
        <p className="text-sm text-muted-foreground">
          {sessions.length === 0
            ? "No sessions yet"
            : `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"} · ${formatFocusLength(focused)} focused`}
        </p>
      </header>

      <AsyncBody
        isLoading={isLoading}
        error={error}
        onRetry={() => void loadHistory()}
        isEmpty={sessions.length === 0}
        loadingLabel="Loading your focus history"
        skeletonRows={3}
        skeletonRowClassName="h-10 w-full"
        skeletonClassName="flex flex-col gap-3 px-2"
        errorTitle="Could not load your focus history."
        emptyIcon={Timer}
        emptyTitle="No focus sessions yet."
        emptyHint="Sessions appear here as soon as you finish one."
        emptyAction={
          <Button size="sm" variant="outline" asChild>
            <Link to={FOCUS_TIMER_PATH}>Start a session</Link>
          </Button>
        }
      >
        <ul className="flex flex-col">
          {sessions.map((session) => (
            <FocusSessionRow key={session.id} session={session} />
          ))}
        </ul>
      </AsyncBody>
    </div>
  );
}

export default FocusHistory;
