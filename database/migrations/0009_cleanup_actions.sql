-- A dated record of what the user did with the cleanup utilities, so the
-- quest system can see cleanup (development-plan.md sections 43, 44, 47).
--
-- Section 44's own example quest is "Organize Downloads", and section 47's
-- Organized asks for "10 cleanup tasks". Neither could be measured: the six
-- utilities under Cleanup store nothing (each scan reads the disk fresh), so
-- until now the app could not say whether the user had cleaned anything up
-- today, or ever. This table is that record, and nothing more.
--
-- One row per confirmed action: a move, delete, archive or organize that the
-- user ran from a review flow. `services/cleanup_actions.rs` writes it inside
-- the Rust command that did the work, after the files have been handled, and
-- only when at least one of them succeeded. A cancelled dialog, a scan, an
-- open or a reveal writes nothing, and an action where every file failed
-- writes nothing either — section 88, XP and achievements follow what really
-- happened.
--
-- It holds no paths and no file names. Which files were moved is the user's
-- business, not the progress system's, and a table that never has them can
-- never leak them into a backup or a log. `item_count` is as specific as it
-- gets.
--
-- Section 67 is kept by the direction of the arrow: an action writes a row,
-- and a row is read by the quest and the achievement. Nothing reads this
-- table to decide what to do to a file, so no quest can ever cause one.
--
-- `utility` and `action` are not CHECK-constrained. The Rust enums are the
-- vocabulary, and a constraint here would turn a seventh utility into a
-- table rebuild rather than a new enum variant.

CREATE TABLE IF NOT EXISTS cleanup_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    utility TEXT NOT NULL,
    action TEXT NOT NULL,
    item_count INTEGER NOT NULL CHECK (item_count >= 1),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- No index. Both reads group by the *local* date, `DATE(created_at,
-- 'localtime')`, which an index on `created_at` cannot serve, and the table
-- grows by a handful of rows on the days it grows at all.

-- Organized now counts days with a cleanup action rather than completed
-- maintenance quests, so its line says so. 0005 notes that the text is
-- presentation and safe to change here without touching anyone's unlock.
UPDATE achievements
   SET description = 'Clean up files on 10 different days.'
 WHERE key = 'organized';
