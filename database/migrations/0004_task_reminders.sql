-- Per-task reminders (development-plan.md section 24: "10 minutes before" or
-- "At 5:00 PM", delivered as a native desktop notification).
--
-- The reminder lives on the task rather than in a table of its own because a
-- task has at most one, and because every question the scheduler asks — is it
-- still open, when is it due, has this one been sent — is then a single row
-- read with no join. A `reminders` table would buy the ability to set several
-- per task, which section 24 does not ask for, at the cost of a second place
-- a task's schedule could be out of step with itself.
--
-- Two of the columns are configuration and three are delivery state:
--
--   reminder_kind            which of section 24's two forms this is
--   reminder_minutes_before  "N minutes before due" (minutes_before only)
--   reminder_time            local HH:MM on the due date (at_time only)
--
--   reminder_snoozed_until   UTC moment a snoozed reminder comes back
--   reminder_fired_at        UTC moment the notification was last delivered
--
-- Splitting them that way is what makes Snooze and Dismiss non-destructive
-- (section 24's buttons): both write only delivery state, so the reminder the
-- user configured is still there afterwards and the task is untouched. The
-- scheduler decides whether to fire by comparing `reminder_fired_at` against
-- the moment the reminder is *currently* for — see `services/reminders.rs` —
-- so re-dating a task, or re-configuring its reminder, arms it again on its
-- own without anything having to reach in and reset these.
--
-- Both configuration columns are nullable and NULL `reminder_kind` means "no
-- reminder", which is what every task created before this migration gets.

ALTER TABLE tasks ADD COLUMN reminder_kind TEXT
    CHECK (reminder_kind IS NULL OR reminder_kind IN ('minutes_before', 'at_time'));
ALTER TABLE tasks ADD COLUMN reminder_minutes_before INTEGER;
ALTER TABLE tasks ADD COLUMN reminder_time TEXT;
ALTER TABLE tasks ADD COLUMN reminder_snoozed_until TEXT;
ALTER TABLE tasks ADD COLUMN reminder_fired_at TEXT;

-- The scheduler wakes up every half minute and asks the same question every
-- time: which tasks have a reminder at all? On a task list of any size that
-- is almost always a very short answer, so the partial index keeps the poll
-- off the full table.
CREATE INDEX IF NOT EXISTS idx_tasks_reminder_kind
    ON tasks(reminder_kind) WHERE reminder_kind IS NOT NULL;
