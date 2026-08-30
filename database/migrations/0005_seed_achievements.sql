-- Seeds the six achievements of development-plan.md section 47, and adds the
-- indexes the progression queries in src-tauri/src/services/xp.rs lean on.
--
-- The rows are seeded rather than hard-coded in Rust because `achievements`
-- is a real table with `user_achievements` pointing at it by id: an unlock is
-- a foreign key, so the achievement has to exist as a row before it can be
-- earned. `key` is the stable identifier the code matches on (`INSERT OR
-- IGNORE` on it makes re-running harmless); `name`, `description` and `icon`
-- are presentation and are safe to change in a later migration without
-- invalidating anyone's unlocks.
--
-- Icons are lucide-react names, matching the convention 0002 set for
-- task categories, so the achievements grid renders a row without a lookup
-- table.
--
-- The thresholds live in Rust (`xp::achievements`), not here, because they
-- are conditions to evaluate rather than data to store — see that module for
-- what each one actually counts, in particular Organized, whose "cleanup
-- tasks" are section 43's maintenance quests.

INSERT OR IGNORE INTO achievements (key, name, description, icon) VALUES
    ('first_task',    'First Task',    'Complete your first task.',        'check-circle-2'),
    ('first_routine', 'First Routine', 'Launch your first routine.',       'rocket'),
    ('focused',       'Focused',       'Complete 10 focus sessions.',      'timer'),
    ('consistent',    'Consistent',    'Maintain a 7-day streak.',         'flame'),
    ('organized',     'Organized',     'Complete 10 cleanup tasks.',       'sparkles'),
    ('deep_work',     'Deep Work',     'Reach 10 hours of focus time.',    'brain');

-- The `streaks` table (section 46) is a single-row tracker, and every read
-- and write in `xp::streaks` addresses that row by a fixed id rather than
-- hunting for "the" row. Seeding it here means the recompute is always an
-- UPDATE of a row that exists, so a fresh install and a long-running one take
-- exactly the same code path.
INSERT OR IGNORE INTO streaks (id, current_streak, longest_streak, last_active_date)
VALUES (1, 0, 0, NULL);

-- The three sources a productive day can come from (section 46). Each of
-- these is scanned by date, oldest to newest, every time the streak is
-- recomputed.
CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at);
CREATE INDEX IF NOT EXISTS idx_focus_sessions_ended_at ON focus_sessions(ended_at, completed);
CREATE INDEX IF NOT EXISTS idx_xp_transactions_created_at ON xp_transactions(created_at);

-- "Has today already granted a routine-launch XP?" (section 88) filters by
-- source and orders by date; the existing idx_xp_transactions_source covers
-- the first half and this covers the pair.
CREATE INDEX IF NOT EXISTS idx_xp_transactions_source_created_at
    ON xp_transactions(source, created_at);

-- Quests are looked up by the day they are active for (section 62).
CREATE INDEX IF NOT EXISTS idx_quests_active_date ON quests(active_date, type);
