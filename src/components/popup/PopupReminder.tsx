import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Clock, Loader2, Play } from "lucide-react";

import InlineError from "@/components/common/states/InlineError";
import { Button } from "@/components/ui/button";
import { useReminderActions } from "@/hooks/useReminderActions";
import { handOffReminderToApp, onReminderHandled } from "@/lib/reminder-events";
import { dismissPopupWindow } from "@/services/popupService";
import { onReminderFired } from "@/services/notificationService";
import {
  REMINDER_ACTION_LABELS,
  type ReminderAction,
  type ReminderNotification,
} from "@/types/notification";

const ACTION_ICONS: Record<ReminderAction, typeof Play> = {
  start_task: Play,
  snooze: Clock,
  dismiss: BellOff,
};

/**
 * Section 24's reminder, in section 25's window.
 *
 * The popup listens for reminders as well as the main window, and the reason
 * is the one that makes the popup worth having at all: it is always-on-top
 * and out of the taskbar, so when a reminder lands while the app is buried
 * behind three other programs, this is the surface the user can actually see.
 * A prompt only the main window drew would be a prompt nobody was looking at.
 *
 * It is a banner rather than a toast because there is no `Toaster` in this
 * window — over a 340px list a toast would cover the list — and it takes the
 * top of the window rather than floating, so the reminder pushes the day down
 * instead of hiding part of it.
 *
 * **Start Task hands over.** Starting a task means launching a routine and
 * putting a session on the clock (section 18), and neither exists here:
 * section 32's checklist and `useFocusLifecycle` belong to the app shell.
 * `PopupRoutineLaunch` already draws that line for a routine that half
 * failed — "a routine that half failed is not a glance any more" — and this
 * is the same line. So the app is asked to do it and the popup puts itself
 * away, because a window that stays on top of the workspace it just summoned
 * is the one thing in the way.
 *
 * **Snooze and Dismiss stay.** Both are one write and no window, which is
 * exactly what section 25 means by not requiring the full application.
 *
 * One reminder at a time, oldest first: two reminders in a 340px window is a
 * stack of buttons where the task list should be, so the rest wait their turn
 * behind a count.
 */
function PopupReminder() {
  const [pending, setPending] = useState<ReminderNotification[]>([]);
  const [inFlight, setInFlight] = useState<ReminderAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const drop = useCallback((taskId: number) => {
    setPending((queue) => queue.filter((reminder) => reminder.task_id !== taskId));
  }, []);

  const { runAction } = useReminderActions({
    onStartTask: async (reminder) => {
      handOffReminderToApp(reminder.task_id);
      // The hand-off is a broadcast, not a call: the app reports whatever
      // happens next, and this window is on its way out either way.
      await dismissPopupWindow().catch((cause) => {
        console.error("Could not put the popup away:", cause);
      });
    },
  });

  // A reminder arriving. Replacing by task id rather than appending keeps a
  // snooze coming back from queueing behind itself.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void onReminderFired((reminder) => {
      setPending((queue) => [
        ...queue.filter((queued) => queued.task_id !== reminder.task_id),
        reminder,
      ]);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((cause) => console.error("Could not subscribe to reminders:", cause));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Dealt with in the main window, so there is nothing left to offer here.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void onReminderHandled((taskId) => drop(taskId))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((cause) =>
        console.error("Could not listen for reminders handled elsewhere:", cause),
      );

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [drop]);

  const [reminder] = pending;
  if (!reminder) return null;

  async function handle(action: ReminderAction) {
    if (!reminder) return;

    setInFlight(action);
    setError(null);
    try {
      await runAction(reminder, action);
      drop(reminder.task_id);
    } catch (cause) {
      // The reminder is still owed, so the buttons stay and the reason goes
      // under them.
      setError(String(cause));
    } finally {
      setInFlight(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b bg-accent/40 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <Bell className="mt-0.5 size-3.5 shrink-0 text-priority-urgent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-5" title={reminder.task_title}>
            {reminder.task_title}
          </p>
          {/* `due_phrase`, not `body`: the body ends by telling the user to
              open the app, which is not advice worth giving in a window that
              has the buttons. */}
          <p className="text-[11px] leading-tight text-muted-foreground">
            {reminder.snoozed && "Snoozed — "}
            {reminder.due_phrase}
          </p>
        </div>
        {pending.length > 1 && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            +{pending.length - 1}
          </span>
        )}
      </div>

      {error && <InlineError className="px-2 py-1 text-[11px] leading-tight" message={error} />}

      <div className="flex items-center gap-1">
        {reminder.actions.map((action, index) => {
          const Icon = ACTION_ICONS[action];

          return (
            <Button
              key={action}
              variant={index === 0 ? "default" : "ghost"}
              size="xs"
              disabled={inFlight !== null}
              onClick={() => void handle(action)}
              className={index > 0 ? "text-muted-foreground" : undefined}
            >
              {inFlight === action ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Icon className="size-3" />
              )}
              {action === "snooze"
                ? `${reminder.snooze_minutes}m`
                : REMINDER_ACTION_LABELS[action]}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export default PopupReminder;
