/**
 * START FOCUS (development-plan.md section 19).
 *
 * ```text
 * □ Study JavaScript
 *
 * Estimated:
 * 45 minutes
 *
 * [ Start Focus ]
 * ```
 *
 * One click turns a task into a running clock, sized by the task's own
 * estimate and attached to it, so the minutes it takes are recorded against
 * the thing they were spent on.
 *
 * The sibling of `useStartTask`, and split from it for the reason section 18
 * and section 19 are two sections: starting a *task* opens the workspace it
 * is done in and then focuses; starting a *focus session* just focuses. Every
 * task can do the second; only a task with a routine can do the first.
 *
 * Both paths end in the same place — {@link startFocusFor} — which is also
 * what the routine launch calls when its intent arrives (`useFocusLifecycle`),
 * so a session started from a row, from START TASK, or from the Focus page
 * itself is one kind of thing with one set of rules.
 */

import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import { formatTargetLength } from "@/lib/focus-utils";
import { useFocusStore } from "@/stores/focusStore";
import type { ActiveFocusSession, StartFocusOptions } from "@/types/focus-ui";
import type { Task } from "@/types/task";

/** Where the running clock lives, for the "Open timer" way out of a toast. */
export const FOCUS_TIMER_PATH = "/focus/timer";

export interface StartFocusState {
  /** Starts a focus session for this task, and says what happened. */
  startFocus: (task: Task) => Promise<void>;
  /** True between pressing Start and the session's row coming back. */
  isStarting: boolean;
  /**
   * The task the running session is attached to, or null when nothing is
   * running or the session stands alone.
   *
   * A row reads this to show that *it* is the one being focused on. It is a
   * plain id rather than the session on purpose: subscribing to the session
   * would re-render every task row once a second for a clock none of them
   * draw.
   */
  focusedTaskId: number | null;
  /** True while any session is on the clock — there is only ever one. */
  isFocusing: boolean;
}

/**
 * Starts a session against a task and reports a refusal, returning the
 * session that is now running or `null` if none is.
 *
 * Not a hook, so the routine-launch intent can call it from a subscription
 * (see `useFocusLifecycle`) without a component in the way. It owns the two
 * ways starting can fail, both of which are worth saying out loud:
 *
 * - **Something is already running.** One clock at a time is the store's rule
 *   — a second session would double-count the same minutes — but a silent
 *   refusal would leave the user waiting for a timer that is never coming.
 * - **The row could not be written.** The task was deleted a moment ago, say.
 *   The store keeps the reason in `sessionError`; this passes it on.
 */
export async function startFocusFor(
  options: StartFocusOptions,
): Promise<ActiveFocusSession | null> {
  const running = useFocusStore.getState().session;
  if (running) {
    toast.error(
      running.taskId === options.taskId && options.taskId != null
        ? "Already focusing on this task"
        : "A focus session is already running",
      { description: "Finish it before starting another one." },
    );
    return null;
  }

  await useFocusStore.getState().startSession(options);

  const { session, sessionError } = useFocusStore.getState();
  if (!session) {
    toast.error("Could not start focus session", {
      description: sessionError ?? "The session could not be recorded.",
    });
    return null;
  }

  return session;
}

/** How long a session that has just started will run for, in words. */
export function focusLengthCaption(session: ActiveFocusSession): string {
  return session.targetSeconds === null
    ? "Counting up until you finish."
    : `${formatTargetLength(Math.round(session.targetSeconds / 60))} on the clock.`;
}

export function useStartFocus(): StartFocusState {
  const navigate = useNavigate();

  const isStarting = useFocusStore((state) => state.isStarting);
  const isFocusing = useFocusStore((state) => state.session !== null);
  const focusedTaskId = useFocusStore((state) => state.session?.taskId ?? null);

  const startFocus = useCallback(
    async (task: Task) => {
      const session = await startFocusFor({
        // Section 19 sizes the session from the estimate. A task without one
        // falls through to whichever preset the Focus page is set to rather
        // than inventing a length — see `startingMinutes` in `focusStore`.
        minutes: task.estimated_minutes,
        taskId: task.id,
        taskTitle: task.title,
      });
      if (!session) return;

      // The clock is on the Focus page and the user is not, so the toast is
      // both the confirmation and the way there.
      toast.success(`Focusing on ${task.title}`, {
        description: focusLengthCaption(session),
        action: { label: "Open timer", onClick: () => navigate(FOCUS_TIMER_PATH) },
      });
    },
    [navigate],
  );

  return { startFocus, isStarting, focusedTaskId, isFocusing };
}
