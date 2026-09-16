-- Calendar integration (development-plan.md sections 53, 92 Tier 5).
--
-- Section 53 put a full calendar out of scope and date navigation in; this is
-- the "optional calendar integration" it deferred. It is read-only: events
-- come from an `.ics` file the user picked or an `.ics` feed URL they pasted,
-- and are shown beside that day's tasks. The app never writes to anyone's
-- calendar, and an event is never turned into a task on its own.
--
-- One row per *occurrence*, already in local time. A repeating meeting is
-- expanded when the calendar is read (`services/calendar.rs`) over a window
-- around today, so a day's events are a plain `WHERE date = ?`. Every import
-- replaces the rows of its source, so there is no merge to get wrong: the
-- file or the feed is the truth, and this table is a copy of it.
--
-- `start_time` / `end_time` are `HH:MM`, NULL for an all-day event.

CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('file', 'feed')),
    uid TEXT,
    title TEXT NOT NULL,
    location TEXT,
    date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events (date);
