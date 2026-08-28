-- Seeds the default task categories from development-plan.md section 13.
--
-- This is a one-time seed, not a fixed list: users can rename, recolour,
-- delete or add categories afterwards (see the task_categories CRUD in
-- src-tauri/src/services/task_categories.rs) and re-running migrations will
-- not resurrect a category the user deleted, because migrations only ever
-- apply once per database.
--
-- Colours are hex values and icons are lucide-react icon names, so the UI
-- can render a category straight from the row without a lookup table.

INSERT OR IGNORE INTO task_categories (name, color, icon) VALUES
    ('Work',     '#3b82f6', 'briefcase'),
    ('Study',    '#8b5cf6', 'book-open'),
    ('Personal', '#ec4899', 'heart'),
    ('Coding',   '#22c55e', 'code'),
    ('Admin',    '#f59e0b', 'clipboard-list'),
    ('Errands',  '#14b8a6', 'shopping-bag'),
    ('Other',    '#94a3b8', 'circle-dashed');

-- Task lists are filtered by category in the Tasks views (section 15).
CREATE INDEX IF NOT EXISTS idx_tasks_category_id ON tasks(category_id);
