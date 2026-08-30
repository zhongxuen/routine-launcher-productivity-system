-- A dated log of routine launches, so section 36's "Routines: 4" can be
-- counted for a *day* and section 82's "Most used routine" for a *week*.
--
-- Section 33's statistics needed neither: "Launches: 42" and "Last used:
-- Today" are a running total and a single timestamp, which is exactly what
-- `routines.launch_count` and `routines.last_launched_at` are, and two
-- columns beat a table for two figures. Section 36 changes the question from
-- "how many, ever" to "how many, today" — and a counter cannot be asked that.
-- Nothing already stored can answer it either: `last_launched_at` remembers
-- one launch per routine no matter how many there were, and the
-- `routine_launch` rows in `xp_transactions` are capped at one a day on
-- purpose (section 88), so counting either would count wrong.
--
-- So the launch becomes a row. `launch_count` stays where it is rather than
-- being derived from `COUNT(*)` here, because it is a lifetime total that
-- predates this table and would otherwise reset for every existing user.
-- `services/routines.rs::prepare_launch` writes both in the same transaction,
-- which is what keeps them from drifting apart from this point on.
--
-- ON DELETE CASCADE, unlike `focus_sessions.routine_id`'s SET NULL: focused
-- minutes are the user's own work and survive the routine they happened
-- under, but "this routine was launched" is a fact *about* the routine and
-- means nothing once it is gone — an orphan row would only make the week's
-- total disagree with the routines the week's panel can name.

CREATE TABLE IF NOT EXISTS routine_launches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    launched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every analytics read filters by date first ("this week"), then groups by
-- routine ("most used"), so the window is the leading column.
CREATE INDEX IF NOT EXISTS idx_routine_launches_launched_at
    ON routine_launches(launched_at);
CREATE INDEX IF NOT EXISTS idx_routine_launches_routine_id
    ON routine_launches(routine_id);

-- One row per routine that has ever been launched, dated to the one launch
-- whose moment is on record.
--
-- This is a seed, not a back-fill: a routine with `launch_count = 42` gets a
-- single row, because forty-one of those launches have no date and inventing
-- forty-one would be inventing history (section 88). What it does buy is that
-- upgrading mid-morning does not report "Routines: 0" for a day the user has
-- already used one — the launch that set `last_launched_at` is real, and it
-- is dated.
INSERT INTO routine_launches (routine_id, launched_at)
SELECT id, last_launched_at
  FROM routines
 WHERE last_launched_at IS NOT NULL;
