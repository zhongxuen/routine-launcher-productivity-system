import { format } from "date-fns";
import { CircleCheck, CirclePause } from "lucide-react";

import {
  FOCUS_OUTCOME_COLOR,
  FOCUS_OUTCOME_LABELS,
  formatFocusLength,
  sessionOutcome,
} from "@/lib/focus-utils";
import { formatRelativeDate, formatTimestampTime, parseTimestamp } from "@/lib/task-utils";
import { cn } from "@/lib/utils";
import type { FocusSession } from "@/types/focus";

/**
 * One line of Focus > History: what the session was for, when it ran, how
 * long it lasted, and whether it finished.
 *
 * A session that was attached to nothing is still a session, so it is titled
 * "Focus session" rather than left blank — the length is the point of the
 * row, and it is real either way.
 */
function FocusSessionRow({ session }: { session: FocusSession }) {
  const outcome = sessionOutcome(session);
  const Icon = outcome === "completed" ? CircleCheck : CirclePause;

  const started = parseTimestamp(session.started_at);
  const dayKey = started ? format(started, "yyyy-MM-dd") : null;
  const when = [dayKey ? formatRelativeDate(dayKey) : null, formatTimestampTime(session.started_at)]
    .filter(Boolean)
    .join(", ");

  return (
    <li className="flex items-center gap-3 border-b px-2 py-3 last:border-b-0">
      <Icon className={cn("size-4 shrink-0", FOCUS_OUTCOME_COLOR[outcome])} />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-sm">{title(session)}</p>
        <p className="truncate text-xs text-muted-foreground">
          {[when, FOCUS_OUTCOME_LABELS[outcome], subtitle(session)].filter(Boolean).join(" · ")}
        </p>
      </div>

      <span className="shrink-0 text-sm tabular-nums">
        {formatFocusLength(session.duration_seconds)}
      </span>
    </li>
  );
}

/** The task it was for, else the routine it ran under, else the session itself. */
function title(session: FocusSession): string {
  return session.task_title ?? session.routine_name ?? "Focus session";
}

/** The routine, when it is not already the title. */
function subtitle(session: FocusSession): string | null {
  return session.task_title && session.routine_name ? session.routine_name : null;
}

export default FocusSessionRow;
