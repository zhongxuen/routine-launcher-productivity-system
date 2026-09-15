import { Check, CircleCheck, CirclePause, Coffee } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FOCUS_OUTCOME_LABELS, formatFocusLength, sessionOutcome } from "@/lib/focus-utils";
import { formatTimestampTime } from "@/lib/task-utils";
import { cn } from "@/lib/utils";
import { useTaskStore } from "@/stores/taskStore";
import type { FocusSession } from "@/types/focus";

import FocusAttachment from "./FocusAttachment";

interface FocusCompletionProps {
  session: FocusSession;
  /**
   * The break this session has earned, or null — it did not complete, or its
   * preset names none. See `breakOffer` in `focusStore`.
   */
  breakMinutes: number | null;
  onStartBreak: () => void;
  onStartAnother: () => void;
  onDismiss: () => void;
}

/**
 * What a session ended as (Prompt 4.2, item 2).
 *
 * The measured time is the headline, and the outcome is stated next to it
 * rather than implied: a session stopped early is *interrupted*, section 76's
 * abandoned session, and it is still shown with the minutes it did earn.
 * Section 88 is the reason both halves are here — hiding a short session would
 * lose real focus time, and calling it complete would inflate it.
 *
 * The clock is gone by this point. This card is what the user is looking at
 * instead, so it also carries the way out: another session, or done.
 *
 * When the session was against a task it carries one more — the last step of
 * section 19's Task -> Focus Session -> Completion, and of the day section 89
 * describes, where the timer finishing is followed by the task being ticked
 * off. Offering it here means the user does not have to go and find the row
 * they have just spent 43 minutes on.
 *
 * And a completed session whose preset names a break offers that break first
 * (section 34's 5 of 25/5). First because it is the preset's own next step,
 * not because it is required — "Start another session" beside it is how the
 * break is skipped.
 */
function FocusCompletion({
  session,
  breakMinutes,
  onStartBreak,
  onStartAnother,
  onDismiss,
}: FocusCompletionProps) {
  const outcome = sessionOutcome(session);
  const completed = outcome === "completed";
  const Icon = completed ? CircleCheck : CirclePause;

  const started = formatTimestampTime(session.started_at);
  const ended = formatTimestampTime(session.ended_at);

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
        <Icon
          className={cn("size-8", completed ? "text-status-completed" : "text-muted-foreground")}
        />

        <div className="flex flex-col items-center gap-1">
          <p className="text-4xl font-semibold tabular-nums tracking-tight">
            {formatFocusLength(session.duration_seconds)}
          </p>
          <p className={cn("text-sm", completed ? "text-status-completed" : "text-muted-foreground")}>
            {FOCUS_OUTCOME_LABELS[outcome]}
            {!completed && " — stopped early"}
          </p>
        </div>

        <FocusAttachment
          taskTitle={session.task_title}
          routineName={session.routine_name}
          className="flex flex-col items-center gap-1"
        />

        {started && ended && (
          <p className="text-xs text-muted-foreground">
            {started} – {ended}
          </p>
        )}

        {session.task_id !== null && (
          <CompleteTask taskId={session.task_id} />
        )}

        <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
          {breakMinutes !== null && (
            <Button onClick={onStartBreak}>
              <Coffee />
              Start {breakMinutes}-minute break
            </Button>
          )}
          <Button variant={breakMinutes !== null ? "outline" : "default"} onClick={onStartAnother}>
            Start another session
          </Button>
          <Button variant="outline" onClick={onDismiss}>
            Done
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Ticking off the task the session was against (sections 19 and 89).
 *
 * Deliberately an offer rather than something the session does by itself: a
 * finished 50 minutes is not the same claim as a finished task, and section 88
 * would rather the user say which one this was. Nothing is implied about the
 * session either way — the focus time is already recorded, so a task left open
 * still keeps the minutes.
 *
 * The task is looked up in whichever view the task store last read, purely so
 * a task that is *already* complete is reported rather than offered again.
 * Not finding it means "not in the current view", not "not there", so the
 * offer stands in that case.
 */
function CompleteTask({ taskId }: { taskId: number }) {
  const storedStatus = useTaskStore(
    (state) => state.tasks.find((task) => task.id === taskId)?.status ?? null,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [justCompleted, setJustCompleted] = useState(false);

  if (justCompleted || storedStatus === "completed") {
    return (
      <p className="flex items-center gap-2 text-sm text-status-completed">
        <Check className="size-4" />
        Task completed
      </p>
    );
  }

  async function handleComplete() {
    setIsSaving(true);
    try {
      await useTaskStore.getState().setTaskStatus(taskId, "completed");
      setJustCompleted(true);
    } catch (cause) {
      toast.error("Could not complete task", { description: String(cause) });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Button variant="outline" size="sm" disabled={isSaving} onClick={() => void handleComplete()}>
      <Check className="size-4" />
      {isSaving ? "Completing…" : "Mark task complete"}
    </Button>
  );
}

export default FocusCompletion;
