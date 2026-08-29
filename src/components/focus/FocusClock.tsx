import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface FocusClockProps {
  /** The face itself, already formatted — `"24:59"`. */
  clock: string;
  /** What the clock is counting, e.g. `"25 minute focus"` or `"Paused"`. */
  caption: string;
  /** How far through a countdown, 0-100, or null for a stopwatch and for an idle clock. */
  percent: number | null;
  /** Dims the face for a clock that is not running yet. */
  idle?: boolean;
  /** Task and routine lines, when the session has any. */
  attachment?: ReactNode;
  /** Start / Pause / Finish. */
  controls: ReactNode;
}

/**
 * The large countdown or count-up face (Prompt 4.2, item 1).
 *
 * One component for all three states — waiting, running, paused — because
 * they are the same clock with a different number on it, and swapping cards
 * between them would make Start feel like a navigation rather than a press.
 *
 * The face is `tabular-nums`, so the digits do not shuffle sideways as they
 * change, and it is announced through `role="timer"` with the caption rather
 * than as a live region: a screen reader reading out every second of a
 * fifty-minute session would be unusable.
 */
function FocusClock({ clock, caption, percent, idle, attachment, controls }: FocusClockProps) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-6 py-10">
        {attachment}

        <div
          role="timer"
          aria-live="off"
          aria-label={`${clock} — ${caption}`}
          className={cn(
            "text-6xl font-semibold tabular-nums tracking-tight sm:text-7xl",
            idle && "text-muted-foreground/50",
          )}
        >
          {clock}
        </div>

        {percent !== null && <Progress value={percent} className="w-full max-w-sm" />}

        <p className="text-sm text-muted-foreground">{caption}</p>

        <div className="flex flex-wrap items-center justify-center gap-2">{controls}</div>
      </CardContent>
    </Card>
  );
}

export default FocusClock;
