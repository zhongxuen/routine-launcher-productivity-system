-- Records which preset a focus session was run with, and how long it was
-- meant to last (development-plan.md section 34: 25/5, 50/10, 90/15, Custom,
-- Stopwatch).
--
-- Section 61's schema stores what a session *did* — started_at, ended_at,
-- duration_seconds, completed. These two columns store what it was *for*,
-- which the stored fields cannot reconstruct: a 25-minute row that stopped at
-- 24:58 could equally be a finished Custom timer or an abandoned 25/5, and a
-- Stopwatch has no target at all. Keeping the target on the row is also what
-- lets a reloaded UI rebuild the countdown from `started_at` rather than
-- asking the user which preset they had picked.
--
-- `preset` uses the same wire strings as `FocusPreset` in
-- `src-tauri/src/services/focus.rs`. `planned_seconds` is NULL for a
-- stopwatch, which is exactly "no fixed end".

ALTER TABLE focus_sessions ADD COLUMN preset TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE focus_sessions ADD COLUMN planned_seconds INTEGER;

-- History (section 64) reads newest-first, and the dashboard's "current
-- focus" looks for the one row that has not ended yet.
CREATE INDEX IF NOT EXISTS idx_focus_sessions_started_at ON focus_sessions(started_at DESC);
