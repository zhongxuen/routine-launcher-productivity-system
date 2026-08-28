-- Initial schema for the Routine Launcher + Productivity Hub.
-- Tables and field lists follow development-plan.md sections 57-63.
-- app_usage and file_scan_history are intentionally deferred to the phases
-- that need them (see section 57).

PRAGMA foreign_keys = ON;

-- Key/value application settings (daily start time, default focus length,
-- start-of-day routine, etc. — see section 52).
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    icon TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Recurrence rules referenced by tasks.recurrence_id (section 23).
CREATE TABLE IF NOT EXISTS task_recurrence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekdays', 'weekly', 'monthly', 'custom')),
    interval INTEGER NOT NULL DEFAULT 1,
    days_of_week TEXT, -- e.g. "MON,WED,FRI" for weekly/custom frequencies
    day_of_month INTEGER,
    start_date TEXT NOT NULL,
    end_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Section 59.
CREATE TABLE IF NOT EXISTS routines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_launched_at TEXT,
    launch_count INTEGER NOT NULL DEFAULT 0
);

-- Section 60.
CREATE TABLE IF NOT EXISTS routine_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('application', 'url', 'folder', 'file', 'timer', 'command')),
    target TEXT NOT NULL,
    arguments TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1
);

-- Section 58.
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'completed', 'cancelled')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    category_id INTEGER REFERENCES task_categories(id) ON DELETE SET NULL,
    due_date TEXT,
    due_time TEXT,
    estimated_minutes INTEGER,
    routine_id INTEGER REFERENCES routines(id) ON DELETE SET NULL,
    recurrence_id INTEGER REFERENCES task_recurrence(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

-- Section 61 (plus `interrupted`, called for by section 35's focus session data).
CREATE TABLE IF NOT EXISTS focus_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    routine_id INTEGER REFERENCES routines(id) ON DELETE SET NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_seconds INTEGER,
    completed INTEGER NOT NULL DEFAULT 0,
    interrupted INTEGER NOT NULL DEFAULT 0
);

-- Section 62.
CREATE TABLE IF NOT EXISTS quests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    difficulty TEXT,
    requirement TEXT,
    xp_reward INTEGER NOT NULL DEFAULT 0,
    active_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Records each time a quest is completed (a quest can recur on future active_dates).
CREATE TABLE IF NOT EXISTS quest_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id INTEGER NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
    completed_at TEXT NOT NULL DEFAULT (datetime('now')),
    xp_awarded INTEGER NOT NULL DEFAULT 0
);

-- Section 63.
CREATE TABLE IF NOT EXISTS xp_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_id INTEGER,
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Section 47.
CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which achievements the user has unlocked, and when.
CREATE TABLE IF NOT EXISTS user_achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    achievement_id INTEGER NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (achievement_id)
);

-- Section 46. Single-row-per-user streak tracker.
CREATE TABLE IF NOT EXISTS streaks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    current_streak INTEGER NOT NULL DEFAULT 0,
    longest_streak INTEGER NOT NULL DEFAULT 0,
    last_active_date TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_routine_id ON tasks(routine_id);
CREATE INDEX IF NOT EXISTS idx_routine_actions_routine_id ON routine_actions(routine_id);
CREATE INDEX IF NOT EXISTS idx_focus_sessions_task_id ON focus_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_focus_sessions_routine_id ON focus_sessions(routine_id);
CREATE INDEX IF NOT EXISTS idx_quest_completions_quest_id ON quest_completions(quest_id);
CREATE INDEX IF NOT EXISTS idx_xp_transactions_source ON xp_transactions(source, source_id);
