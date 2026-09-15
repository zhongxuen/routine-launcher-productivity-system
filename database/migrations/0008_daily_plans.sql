-- A day's top priorities: development-plan.md sections 20 and 51's PLAN TODAY.
--
-- Up to three of the day's tasks, picked by the user and held in order. The
-- rest of the plan (the estimated workload, the time left in the day) is
-- derived on every read from `tasks` and the Daily Settings, so this is the
-- only part of it that is a choice rather than a sum, and the only part that
-- needs a table.
--
-- Keyed by the local `YYYY-MM-DD` the priorities are for, not by a column on
-- `tasks`: "top priority" is a fact about a day, and a task carried over from
-- Monday can be Tuesday's #1 without having been Monday's. Yesterday's rows are
-- kept rather than cleared at midnight. They cost three rows a day and are the
-- only record of what a day was planned around.
--
-- ON DELETE CASCADE: a deleted task is no longer anybody's priority, and an
-- orphan row would hold a rank that no task on screen could fill.
--
-- The constraints are belt and braces behind `services/daily_plans.rs`, which
-- refuses the same things with a sentence first: a rank outside 1-3, and two
-- tasks sharing one rank on the same day.

CREATE TABLE IF NOT EXISTS daily_plans (
    date TEXT NOT NULL,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
    PRIMARY KEY (date, task_id),
    UNIQUE (date, rank)
);

-- The cascade looks rows up by task when one is deleted. The primary key
-- leads with `date`, so it cannot serve that lookup.
CREATE INDEX IF NOT EXISTS idx_daily_plans_task_id ON daily_plans(task_id);
