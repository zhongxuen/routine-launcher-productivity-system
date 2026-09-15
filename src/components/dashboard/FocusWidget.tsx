import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { isToday } from "date-fns";
import { Play, Timer } from "lucide-react";

import StaleNotice from "@/components/common/states/StaleNotice";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FOCUS_TIMER_PATH, startFocusFor } from "@/hooks/useStartFocus";
import { displaySeconds, formatClock, formatFocusLength } from "@/lib/focus-utils";
import { parseTimestamp } from "@/lib/task-utils";
import { cn } from "@/lib/utils";
import { useFocusStore } from "@/stores/focusStore";
import type { FocusSession } from "@/types/focus";
import type { ActiveFocusSession } from "@/types/focus-ui";

/**
 * The dashboard's FOCUS block (development-plan.md section 7):
 *
 * ```text
 * FOCUS
 *
 * Today: 1h 35m
 *
 * [ Start Focus ]
 * ```
 *
 * Two things, and the second is the point: how much has been focused today,
 * and one press to add to it. Third on the dashboard's stated priority list,
 * so it stays a line and a button rather than a second timer — the clock
 * itself lives on Focus > Timer, and this widget never tries to be it.
 *
 * What it does show, when there is one, is the session already running.
 * Starting a second is refused by `focusStore` (two clocks would double-count
 * the same minutes), so offering Start against a running session would be
 * offering something that cannot happen. The button becomes the way back to
 * the clock instead.
 *
 * Every number comes from `focusStore`, including today's total, which is
 * summed here from the same history the Focus > History list reads rather
 * than from a query of its own — the store already re-reads on mount and
 * already gains a row the moment a session ends, so the total is right after
 * a session finishes anywhere in the app without this widget subscribing to
 * anything else. Section 36's real statistics are Phase 11's job; this is one
 * addition over sessions that are already in hand.
 */
function FocusWidget({ className }: { className?: string }) {
  const navigate = useNavigate();

  const session = useFocusStore((state) => state.session);
  const isStarting = useFocusStore((state) => state.isStarting);
  const history = useFocusStore((state) => state.history);
  const isLoading = useFocusStore((state) => state.isHistoryLoading);
  const error = useFocusStore((state) => state.historyError);
  const loadHistory = useFocusStore((state) => state.loadHistory);

  // Read fresh on mount for the same reason History does: sessions end in
  // ways this widget never saw — a window closed on one, a launch closing the
  // one before it — and arriving at the dashboard is exactly when the user is
  // asking what today actually came to.
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const finished = todaysSessions(history);
  const seconds = todayFocusSeconds(finished, session);

  async function handleStart() {
    // `startFocusFor` owns the two ways starting can fail and says so; an
    // empty options object means "whatever the picker is set to", which is
    // the 25/5 preset until the user changes it on the Focus page.
    const started = await startFocusFor({});
    if (!started) return;

    // The clock is on the Focus page and the user is not. Going there is both
    // the confirmation that the session started and the only place it can be
    // paused or finished from.
    navigate(FOCUS_TIMER_PATH);
  }

  return (
    <Card className={cn("gap-4 py-5", className)}>
      <header className="flex items-baseline justify-between gap-3 px-5">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">FOCUS</p>
        {finished.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {finished.length} {finished.length === 1 ? "session" : "sessions"}
          </p>
        )}
      </header>

      <div className="flex flex-wrap items-center justify-between gap-4 px-5">
        <TodayTotal seconds={seconds} isLoading={isLoading} isRunning={session !== null} />

        {session ? (
          <Button variant="outline" onClick={() => navigate(FOCUS_TIMER_PATH)}>
            <Timer />
            Open timer
          </Button>
        ) : (
          <Button onClick={() => void handleStart()} disabled={isStarting}>
            <Play />
            {isStarting ? "Starting…" : "Start Focus"}
          </Button>
        )}
      </div>

      {session && <RunningSession session={session} />}

      {/* The total can be short without the widget being broken — the button
          is what the block is for, so a failed read is stated quietly under
          it rather than replacing everything above. */}
      {error && (
        <StaleNotice
          className="px-5"
          message="Today's total may be incomplete."
          onRetry={() => void loadHistory()}
        />
      )}
    </Card>
  );
}

/**
 * Section 7's one line: `Today: 1h 35m`.
 *
 * A skeleton stands in only on the very first read, when there is nothing to
 * show yet; a reload with sessions already in the store keeps the number on
 * screen rather than blinking it away for a local query.
 */
function TodayTotal({
  seconds,
  isLoading,
  isRunning,
}: {
  seconds: number;
  isLoading: boolean;
  isRunning: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {/* A div rather than a p: the skeleton that stands in for the number is
          itself a div, and a div inside a p is invalid HTML the browser
          silently un-nests. */}
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-muted-foreground">Today:</span>
        {isLoading && seconds === 0 ? (
          <Skeleton className="h-6 w-20" />
        ) : (
          <span className="text-2xl font-semibold tabular-nums">{formatTodayTotal(seconds)}</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {isRunning
          ? "Counting the session on the clock"
          : seconds === 0
            ? "No focus time recorded yet today"
            : "Focused time recorded today"}
      </p>
    </div>
  );
}

/**
 * The session on the clock, under the total it is adding to.
 *
 * Counts the same number the Focus page does — seconds left for a countdown,
 * seconds done for a stopwatch — because it is reading the same session, one
 * store away, and a dashboard disagreeing with the timer about the time would
 * be worse than not showing it.
 *
 * What the session is attached to (section 34) is named on one line rather
 * than through `FocusAttachment`, which centres its lines under a clock this
 * widget does not draw. A session attached to nothing says nothing.
 */
function RunningSession({ session }: { session: ActiveFocusSession }) {
  const isPaused = session.status === "paused";
  const attachment = session.taskTitle ?? session.label ?? session.routineName;

  return (
    <div className="mx-5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-sm">
      <Timer className={cn("size-4 shrink-0", isPaused ? "text-muted-foreground" : "text-primary")} />
      <span className="tabular-nums">{formatClock(displaySeconds(session))}</span>
      <span className="text-muted-foreground">{isPaused ? "paused" : "focusing"}</span>
      {attachment && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">· {attachment}</span>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Today's total                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The sessions that started today, in the user's timezone.
 *
 * `started_at` is UTC, so the day it belongs to is decided after parsing it
 * back to local time — the same conversion the task views make, and the same
 * one the backend's `since` filter makes, so all three agree on where the day
 * ends. A session is counted on the day it *started*: one that runs past
 * midnight belongs to the evening it was begun in, which is how the user
 * remembers it.
 */
function todaysSessions(history: FocusSession[]): FocusSession[] {
  return history.filter((session) => {
    const startedAt = parseTimestamp(session.started_at);
    return startedAt !== null && isToday(startedAt);
  });
}

/**
 * Today's focused seconds: every session that has ended, plus the one still
 * going.
 *
 * The running session is added live rather than waited for, so pressing Start
 * moves the number immediately instead of leaving the dashboard claiming zero
 * for the next 25 minutes. There is no double counting in it — the store's
 * history holds ended sessions only (`only_ended`), and the row for a session
 * that has just finished arrives in the same update that clears the clock.
 */
function todayFocusSeconds(
  finished: FocusSession[],
  session: ActiveFocusSession | null,
): number {
  const recorded = finished.reduce(
    (total, past) => total + (past.duration_seconds ?? past.elapsed_seconds),
    0,
  );

  const startedAt = session && parseTimestamp(session.startedAt);
  const running = startedAt && isToday(startedAt) ? (session?.elapsedSeconds ?? 0) : 0;

  return recorded + running;
}

/**
 * `"1h 35m"`, and a plain `"0m"` for a day with nothing on it — the shared
 * formatter's `"< 1 min"` is for a session that was short, not for a day that
 * has not started.
 */
function formatTodayTotal(seconds: number): string {
  return seconds === 0 ? "0m" : formatFocusLength(seconds);
}

export default FocusWidget;
