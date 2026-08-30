-- Gives a quest a stable identity that is not its row id.
--
-- Section 62's `quests` table assumes a quest is authored and then stored.
-- The daily quests of section 44 are not: `src/lib/quests.ts` derives the
-- day's two or three from the calendar date, deterministically, so every
-- window on every machine offers the same list for the same day without a
-- table having to agree first. Storing three rows a day forever to describe a
-- pure function of the date would be storing a derivation.
--
-- What is still worth storing is the half that actually happened — the
-- completion, and the XP granted for it (`quest_completions`, and the ledger
-- of section 63). Those point at a quest by row id, so a quest the user
-- finished does need a row. It is created the moment it is completed rather
-- than the moment it is offered.
--
-- `key` is what makes that work: it holds the generator's own id for the
-- quest ("tasks-3", "focus-session"), which is stable across days, so
-- `(key, active_date)` identifies "Monday's copy of Complete 3 tasks" and is
-- what the once-per-quest-per-day rule keys off. Nullable, because a quest
-- authored rather than generated has no generator id and section 62 does not
-- require one.

ALTER TABLE quests ADD COLUMN key TEXT;

-- One row per generated quest per day. Partial, so the authored quests
-- section 62 still allows — the ones with no `key` — are not forced to be
-- unique against each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_quests_key_active_date
    ON quests(key, active_date)
 WHERE key IS NOT NULL;

-- `list_quest_completions` reads a day's completions by joining back to the
-- quest that was completed.
CREATE INDEX IF NOT EXISTS idx_quest_completions_completed_at
    ON quest_completions(completed_at);
