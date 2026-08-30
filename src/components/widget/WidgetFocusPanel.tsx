import { Pause, Play, Square } from "lucide-react";

import InlineError from "@/components/common/states/InlineError";
import { Button } from "@/components/ui/button";
import { displaySeconds, formatClock } from "@/lib/focus-utils";
import { cn } from "@/lib/utils";
import { useFocusStore } from "@/stores/focusStore";
import { focusPreset, type FocusPresetId } from "@/types/focus";
import type { ActiveFocusSession } from "@/types/focus-ui";

/**
 * What the widget calls the session on the clock — the `CODING` of section
 * 26's mockup.
 *
 * The task it is for, else the routine it came with, else the preset's own
 * name. That order is section 34's: a session is a length of time, and what
 * makes it worth naming is what it was attached to. Shouted, because it is
 * the same kind of line as `TODAY`.
 *
 * Exported so the focus widget can put it where the mockup does — as the
 * widget's own heading — while the combined widget keeps `FOCUS` there and
 * has no room to say more.
 */
export function focusLabel(
  session: ActiveFocusSession | null,
  presetId: FocusPresetId,
): string {
  if (session?.taskTitle) return session.taskTitle;
  if (session?.routineName) return session.routineName;
  return focusPreset(session?.presetId ?? presetId).label;
}

interface WidgetFocusPanelProps {
  /**
   * `large` is the focus widget, where the clock is the whole window.
   * `compact` is the combined widget's FOCUS section, which shares its height
   * with today's tasks.
   */
  variant: "large" | "compact";
}

/**
 * Section 26's focus face and its controls.
 *
 * ```text
 * ┌─────────────────────────┐        ┌─────────────────────────┐
 * │ CODING                  │        │ FOCUS                   │
 * │                         │        │ 42:18                   │
 * │       42:18             │        │                         │
 * │                         │        │ [ Start ]               │
 * │ [ Pause ] [ Finish ]    │        └─────────────────────────┘
 * └─────────────────────────┘
 * ```
 *
 * Both mockups, one component, because they are the same clock at two sizes:
 * the focus widget gives it the window and the combined widget gives it what
 * is left under the task list. What differs is type size and button size, not
 * behaviour — and not, in particular, which session it is showing.
 *
 * **Nothing here runs a timer.** Every number comes off `focusStore`, the
 * same store the Focus page reads, so Pause and Finish are the Stage 4 timer
 * rather than a widget-shaped copy of it. That store is also what keeps the
 * two *windows* agreeing: the widget is a second webview with a second copy
 * of it, so each announces what it did and adopts what the other did — see
 * `src/lib/focus-sync.ts`. Pausing here pauses the clock the main window is
 * showing, and a countdown that runs out anywhere ends everywhere.
 *
 * The mockup only draws a running session, but a widget that is blank
 * whenever nothing is running would be a widget the user turns off. So an
 * idle clock shows the length the picked preset will run for, dimmed, with
 * the one button that matters — the same three-state face as `FocusTimer`,
 * minus the preset picker, which is a row of five options and does not belong
 * in this window.
 */
function WidgetFocusPanel({ variant }: WidgetFocusPanelProps) {
  const session = useFocusStore((state) => state.session);
  const isStarting = useFocusStore((state) => state.isStarting);
  const sessionError = useFocusStore((state) => state.sessionError);
  const presetId = useFocusStore((state) => state.presetId);
  const customMinutes = useFocusStore((state) => state.customMinutes);

  const startSession = useFocusStore((state) => state.startSession);
  const pauseSession = useFocusStore((state) => state.pauseSession);
  const resumeSession = useFocusStore((state) => state.resumeSession);
  const finishSession = useFocusStore((state) => state.finishSession);

  const isLarge = variant === "large";
  const isPaused = session?.status === "paused";

  const clock = session
    ? formatClock(displaySeconds(session))
    : formatClock(idleSeconds(presetId, customMinutes));

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        isLarge ? "flex-1 items-center justify-center gap-3" : "gap-1",
      )}
    >
      <div
        role="timer"
        // Not a live region: a screen reader reading out every second of a
        // fifty-minute session would be unusable. The same call `FocusClock`
        // makes on the Focus page.
        aria-live="off"
        aria-label={`${clock} — ${session ? (isPaused ? "paused" : "focusing") : "ready to start"}`}
        className={cn(
          "font-semibold tabular-nums tracking-tight",
          isLarge ? "text-5xl" : "text-2xl leading-none",
          !session && "text-muted-foreground/40",
          isPaused && "text-muted-foreground",
        )}
      >
        {clock}
      </div>

      <div className={cn("flex shrink-0 items-center gap-1.5", isLarge && "pt-1")}>
        {session ? (
          <>
            <Button
              size="xs"
              variant="secondary"
              onClick={isPaused ? resumeSession : pauseSession}
            >
              {isPaused ? <Play /> : <Pause />}
              {isPaused ? "Resume" : "Pause"}
            </Button>

            <Button size="xs" variant="outline" onClick={() => void finishSession()}>
              <Square />
              Finish
            </Button>
          </>
        ) : (
          <Button size="xs" disabled={isStarting} onClick={() => void startSession()}>
            <Play />
            {isStarting ? "Starting…" : "Start"}
          </Button>
        )}
      </div>

      {sessionError && (
        <InlineError
          className={cn("shrink-0 px-1 py-1 text-[0.65rem] leading-tight", isLarge && "max-w-full")}
          message={sessionError}
        />
      )}
    </div>
  );
}

/**
 * What the face reads before anything is running: the length the next session
 * will be, or `0:00` for a stopwatch.
 *
 * A preview rather than a blank, for the reason `FocusTimer`'s idle clock is
 * one — it is what the clock will say a moment after Start, which is truer
 * than nothing and makes the button's effect obvious without a caption this
 * window has no room for.
 */
function idleSeconds(presetId: FocusPresetId, customMinutes: number): number {
  const preset = focusPreset(presetId);
  if (preset.mode === "stopwatch") return 0;
  return (preset.focusMinutes ?? customMinutes) * 60;
}

export default WidgetFocusPanel;
