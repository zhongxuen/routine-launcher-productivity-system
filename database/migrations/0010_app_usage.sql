-- Application usage (development-plan.md sections 37, 57, 92 Tier 5).
--
-- Section 37: "Track how long applications are open", and in the same
-- breath, "Do not call this productivity time". So this table is kept apart
-- from everything that feeds XP, quests, streaks and the productivity
-- statistics, and nothing in those reads it. It answers "which programs were
-- in front of me, and for how long", and section 55's third rule ("you often
-- open these together") reads it for the same answer.
--
-- Off until the user switches it on (`usage.tracking_enabled`), and local
-- like the rest of the database. One row per local date, local hour and
-- program: the time that program's window was in the foreground while the
-- user was not idle. No window titles, no documents, no URLs — only which
-- executable it was, which is all the usage list and the routine suggestion
-- need. `exe_path` is kept so a suggested routine can launch the same
-- program; it is the last path seen for that name in that hour.
--
-- Hours rather than sessions: "used together" means "in the same hour", and
-- a per-hour total is a bounded number of rows (at most 24 per program per
-- day) no matter how often the user alt-tabs.

CREATE TABLE IF NOT EXISTS app_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
    app_name TEXT NOT NULL,
    exe_path TEXT,
    seconds INTEGER NOT NULL DEFAULT 0 CHECK (seconds >= 0),
    UNIQUE (date, hour, app_name)
);

CREATE INDEX IF NOT EXISTS idx_app_usage_date ON app_usage (date);
