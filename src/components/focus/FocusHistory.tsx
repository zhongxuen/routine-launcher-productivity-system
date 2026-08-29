import { useEffect } from "react";
import { AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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

      <HistoryBody isLoading={isLoading} error={error} onRetry={() => void loadHistory()} isEmpty={sessions.length === 0}>
        <ul className="flex flex-col">
          {sessions.map((session) => (
            <FocusSessionRow key={session.id} session={session} />
          ))}
        </ul>
      </HistoryBody>
    </div>
  );
}

/**
 * The three things that can be under the heading instead of the list, in the
 * same shape `TaskViewBody` gives the task views.
 */
function HistoryBody({
  isLoading,
  error,
  onRetry,
  isEmpty,
  children,
}: {
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  isEmpty: boolean;
  children: React.ReactNode;
}) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 px-2">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-14 text-center">
        <AlertCircle className="size-5 text-priority-urgent" />
        <div className="flex flex-col gap-1">
          <p className="text-sm">Could not load your focus history.</p>
          <p className="max-w-md text-xs text-muted-foreground">{error}</p>
        </div>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center gap-1 py-14 text-center">
        <p className="text-sm text-muted-foreground">No focus sessions yet.</p>
        <p className="text-xs text-muted-foreground/70">
          Sessions appear here as soon as you finish one.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

export default FocusHistory;
