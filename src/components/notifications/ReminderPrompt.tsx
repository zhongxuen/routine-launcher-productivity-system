import { useState } from "react";
import { Bell, BellOff, Clock, Loader2, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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

interface ReminderPromptProps {
  reminder: ReminderNotification;
  /**
   * Runs one of the buttons. Rejecting with a user-presentable string keeps
   * the prompt open with the reason under it; resolving closes it.
   */
  onAction: (action: ReminderAction) => Promise<void>;
  /** Take the prompt off screen — called once an action has landed. */
  onClose: () => void;
}

/**
 * Section 24's notification, drawn by the app because the OS will not draw
 * it:
 *
 * ```text
 * 🔔 Reminder
 *
 * Finish project documentation
 * Due in 10 minutes.
 *
 * [ Start Task ] [ Snooze ] [ Dismiss ]
 * ```
 *
 * No desktop platform can put those three buttons on a toast with
 * `tauri-plugin-notification` (the reasons are set out in
 * `src-tauri/src/services/notifications.rs`), so the toast says where they
 * are and this is where they are. It is the same payload the OS was handed —
 * same task, same wording, same three actions — which is what stops the
 * notification and the prompt from describing one reminder two ways.
 *
 * Three things it does deliberately:
 *
 * **The buttons come from the reminder**, not from this file. `actions` is
 * carried per reminder so that a reminder which one day arrives with fewer of
 * them — a task with no routine has nothing to launch — needs no change here.
 *
 * **It does not close itself.** A reminder that timed out while the user was
 * in another application is a reminder that did not happen; the prompt is
 * raised with no duration and only goes when one of its buttons has actually
 * done something. Dismiss is a button, not the absence of one.
 *
 * **A failed action leaves it open.** Snooze on a reminder deleted in another
 * window rejects, and the honest answer is the reason plus the buttons still
 * being there — closing the prompt would look like the snooze worked.
 */
function ReminderPrompt({ reminder, onAction, onClose }: ReminderPromptProps) {
  const [inFlight, setInFlight] = useState<ReminderAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handle(action: ReminderAction) {
    setInFlight(action);
    setError(null);
    try {
      await onAction(action);
      onClose();
    } catch (cause) {
      setError(String(cause));
      setInFlight(null);
    }
  }

  const isBusy = inFlight !== null;

  return (
    <div className="flex w-full items-start gap-3 rounded-[var(--radius)] border bg-popover p-4 text-popover-foreground shadow-lg">
      <Bell className="mt-0.5 size-4 shrink-0 text-priority-urgent" aria-hidden />

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" title={reminder.task_title}>
            {reminder.task_title}
          </p>
          {/* `due_phrase`, not `body`: the body ends by telling the user to
              open the app, which is not useful advice inside it. */}
          <p className="text-xs text-muted-foreground">
            {reminder.snoozed && "Snoozed reminder — "}
            {reminder.due_phrase}
          </p>
        </div>

        {error && <p className="text-xs leading-tight text-priority-urgent">{error}</p>}

        <div className="flex flex-wrap items-center gap-1.5">
          {reminder.actions.map((action, index) => {
            const Icon = ACTION_ICONS[action];
            const isRunning = inFlight === action;

            return (
              <Button
                key={action}
                // Start Task is the one the mockup leads with and the only
                // one that does any work, so it is the only solid button.
                variant={index === 0 ? "default" : "ghost"}
                size="xs"
                disabled={isBusy}
                onClick={() => void handle(action)}
                className={cn(index > 0 && "text-muted-foreground")}
              >
                {isRunning ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Icon className="size-3" />
                )}
                {action === "snooze"
                  ? `Snooze ${reminder.snooze_minutes}m`
                  : REMINDER_ACTION_LABELS[action]}
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default ReminderPrompt;
