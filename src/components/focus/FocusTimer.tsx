import { Pause, Play, Square } from "lucide-react";

import InlineError from "@/components/common/states/InlineError";
import { Button } from "@/components/ui/button";
import {
  displaySeconds,
  formatClock,
  formatTargetLength,
  hasReachedTarget,
  progressPercent,
} from "@/lib/focus-utils";
import { useFocusStore } from "@/stores/focusStore";
import { focusPreset, type FocusPreset } from "@/types/focus";
import type { ActiveFocusSession } from "@/types/focus-ui";

import FocusAttachment from "./FocusAttachment";
import FocusClock from "./FocusClock";
import FocusCompletion from "./FocusCompletion";
import FocusPresetPicker from "./FocusPresetPicker";

/**
 * Focus > Timer (development-plan.md sections 34 and 76).
 *
 * Three states, one after the other: a preset waiting to be started, a clock
 * running against it, and what the session ended as. Only one is on screen at
 * a time, because they are the same question at different points — how long,
 * how long left, how long it was.
 *
 * Nothing here owns the timer. Every number comes off `focusStore`, which is
 * what lets the user leave for Tasks mid-session and come back to a clock
 * that never stopped: this component is rebuilt from the session, and the
 * session was never anywhere near it.
 *
 * Nor does it own the record. The store writes a `focus_sessions` row on
 * Start and ends it on Finish; all this view does with that is wait for the
 * row before offering the clock, and say so when one could not be written.
 */
function FocusTimer() {
  const session = useFocusStore((state) => state.session);
  const isStarting = useFocusStore((state) => state.isStarting);
  const result = useFocusStore((state) => state.result);
  const sessionError = useFocusStore((state) => state.sessionError);
  const presetId = useFocusStore((state) => state.presetId);
  const customMinutes = useFocusStore((state) => state.customMinutes);

  const startSession = useFocusStore((state) => state.startSession);
  const pauseSession = useFocusStore((state) => state.pauseSession);
  const resumeSession = useFocusStore((state) => state.resumeSession);
  const finishSession = useFocusStore((state) => state.finishSession);
  const dismissResult = useFocusStore((state) => state.dismissResult);

  const preset = focusPreset(presetId);

  return (
    <div className="flex flex-col gap-6 py-2">
      <header className="flex flex-col gap-0.5 px-2">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">TIMER</p>
        <p className="text-lg font-medium">
          {session
            ? session.status === "paused"
              ? "Paused"
              : "Focusing"
            : result
              ? "Session ended"
              : "Ready when you are"}
        </p>
      </header>

      {sessionError && <SessionError message={sessionError} />}

      {/* The picker is only drawn when the choice is live: mid-session it
          would offer to change the length the clock is already counting
          against, and over the completion card it would rewrite the preset
          that card is describing. */}
      {!session && !result && <FocusPresetPicker />}

      {session ? (
        <RunningClock
          session={session}
          onPause={pauseSession}
          onResume={resumeSession}
          onFinish={finishSession}
        />
      ) : result ? (
        <FocusCompletion
          session={result}
          breakMinutes={preset.breakMinutes}
          onStartAnother={() => void startSession()}
          onDismiss={dismissResult}
        />
      ) : (
        <IdleClock
          preset={preset}
          customMinutes={customMinutes}
          isStarting={isStarting}
          onStart={() => void startSession()}
        />
      )}
    </div>
  );
}

/**
 * The clock before it is running: the length the picked preset will run for,
 * dimmed, and the one button that matters.
 *
 * A stopwatch shows `0:00` rather than a blank face — it is what the clock
 * will read a moment after Start, which is a truer preview than nothing.
 *
 * Start is disabled while the row is being written. That gap is a local
 * SQLite insert wide, so it is almost never seen — but it is exactly the gap
 * in which a second click would start a second session, and the button says
 * what it is doing rather than going quiet.
 */
function IdleClock({
  preset,
  customMinutes,
  isStarting,
  onStart,
}: {
  preset: FocusPreset;
  customMinutes: number;
  isStarting: boolean;
  onStart: () => void;
}) {
  const minutes = preset.mode === "stopwatch" ? null : (preset.focusMinutes ?? customMinutes);

  return (
    <FocusClock
      idle
      clock={formatClock(minutes === null ? 0 : minutes * 60)}
      caption={minutes === null ? "Counts up until you finish" : lengthCaption(minutes, preset.breakMinutes)}
      percent={null}
      controls={
        <Button onClick={onStart} disabled={isStarting}>
          <Play />
          {isStarting ? "Starting…" : "Start"}
        </Button>
      }
    />
  );
}

/**
 * The clock while a session is on: counting down to the preset's length, or
 * up from zero for a stopwatch.
 *
 * Finish is offered in both states rather than only while running, because a
 * paused session that is never going to be resumed should be recordable
 * without resuming it first. What it will be recorded *as* is said out loud
 * when the answer is "interrupted" — the number this session earns is the
 * point of the whole page, and finding out afterwards that stopping cost the
 * session its completion would be a bad way to learn it.
 */
function RunningClock({
  session,
  onPause,
  onResume,
  onFinish,
}: {
  session: ActiveFocusSession;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
}) {
  const isPaused = session.status === "paused";
  const isCountdown = session.targetSeconds !== null;
  const willBeInterrupted = isCountdown && !hasReachedTarget(session);

  return (
    <div className="flex flex-col gap-2">
      <FocusClock
        clock={formatClock(displaySeconds(session))}
        caption={
          isPaused
            ? "Paused — the clock is not counting"
            : session.targetSeconds === null
              ? "Counting up until you finish"
              : lengthCaption(session.targetSeconds / 60, session.breakMinutes)
        }
        percent={isCountdown ? progressPercent(session) : null}
        attachment={
          <FocusAttachment
            taskTitle={session.taskTitle}
            routineName={session.routineName}
            className="flex flex-col items-center gap-1"
          />
        }
        controls={
          <>
            {isPaused ? (
              <Button onClick={onResume}>
                <Play />
                Resume
              </Button>
            ) : (
              <Button variant="outline" onClick={onPause}>
                <Pause />
                Pause
              </Button>
            )}
            <Button variant={isPaused ? "outline" : "default"} onClick={onFinish}>
              <Square />
              Finish
            </Button>
          </>
        }
      />

      {isPaused && willBeInterrupted && (
        <p className="text-center text-xs text-muted-foreground">
          Finishing now records this session as interrupted.
        </p>
      )}
    </div>
  );
}

/**
 * A session that could not be started, or could not be recorded.
 *
 * Stated above whatever state the timer is in rather than replacing it: a
 * failed Finish still has a completion card underneath it with the minutes
 * the session earned, and losing sight of those to show the error would be
 * the wrong half to keep.
 */
function SessionError({ message }: { message: string }) {
  return <InlineError message={`This session could not be saved. ${message}`} />;
}

/** `"25 minute focus · 5 minute break"`, or just the focus half. */
function lengthCaption(minutes: number, breakMinutes: number | null): string {
  const focus = `${formatTargetLength(Math.round(minutes))} focus`;
  return breakMinutes === null ? focus : `${focus} · ${formatTargetLength(breakMinutes)} break`;
}

export default FocusTimer;
