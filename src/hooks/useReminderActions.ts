/**
 * What section 24's three buttons actually do, wherever they are drawn.
 *
 * The main window draws them in a toast and the popup draws them in a banner,
 * and neither should be the place that decides what Snooze means. Two of the
 * three are the same everywhere:
 *
 * * **Snooze** puts the reminder back for the length the reminder itself
 *   asked for (`snooze_minutes`, the backend's ten unless it says otherwise).
 *   The task is untouched, and so is the reminder's configuration.
 * * **Dismiss** silences this one delivery. The reminder stays configured and
 *   the task is not completed, cancelled or deleted — see
 *   `src-tauri/src/services/reminders.rs`. Re-date the task and it will
 *   remind again.
 *
 * **Start Task** is the one that differs, so it is the caller's: in the app
 * shell it launches the routine and puts the window on the task, and in the
 * popup it hands the whole thing to the app shell. See
 * `src/lib/reminder-events.ts`.
 *
 * All three end the same way — the other window is told the reminder is dealt
 * with, and both windows re-read their task list, because a snooze and a
 * dismissal both change what a task row has to say about its reminder.
 */

import { useCallback } from "react";

import { announceReminderHandled } from "@/lib/reminder-events";
import { announceDataChanged } from "@/lib/window-sync";
import {
  dismissTaskReminder,
  snoozeTaskReminder,
} from "@/services/notificationService";
import { useTaskStore } from "@/stores/taskStore";
import type {
  ReminderAction,
  ReminderNotification,
} from "@/types/notification";

export interface ReminderActionsOptions {
  /**
   * Start Task. Rejecting is how it reports failure — the caller's own error
   * surface is used, since a 340px popup and a full window do not report the
   * same way.
   */
  onStartTask: (reminder: ReminderNotification) => void | Promise<void>;
}

export interface ReminderActionsState {
  /**
   * Runs one of section 24's buttons. Rejects with a user-presentable string
   * so the prompt that raised it can say so and stay open; resolves when the
   * reminder is dealt with and the prompt should go.
   */
  runAction: (
    reminder: ReminderNotification,
    action: ReminderAction,
  ) => Promise<void>;
}

export function useReminderActions({
  onStartTask,
}: ReminderActionsOptions): ReminderActionsState {
  const runAction = useCallback(
    async (reminder: ReminderNotification, action: ReminderAction) => {
      switch (action) {
        case "start_task":
          await onStartTask(reminder);
          break;
        case "snooze":
          await snoozeTaskReminder(reminder.task_id, reminder.snooze_minutes);
          break;
        case "dismiss":
          await dismissTaskReminder(reminder.task_id);
          break;
      }

      // Only once the action has landed. Announcing a snooze that failed
      // would close the other window's prompt on a reminder still owed.
      announceReminderHandled(reminder.task_id, action);

      // Snooze and Dismiss both write `reminder_snoozed_until` /
      // `reminder_fired_at` on the task, so every list showing it is now a
      // read behind. Fire-and-forget: the write is already recorded, and a
      // stale row is not a reason to report the button as having failed.
      void useTaskStore.getState().refresh();
      announceDataChanged("tasks");
    },
    [onStartTask],
  );

  return { runAction };
}

