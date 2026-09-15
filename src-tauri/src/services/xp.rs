//! Progression: XP, levels, streaks, achievements and quest rewards
//! (development-plan.md sections 43-47, 62-63, 88).
//!
//! # The ledger, not a counter
//!
//! Section 63 is explicit: "Store XP transactions rather than only a total."
//! Every grant this module makes is a row in `xp_transactions` carrying what
//! earned it (`source`), which row earned it (`source_id`) and how much
//! (`amount`). The user's total is `SUM(amount)` over that ledger and is
//! never stored anywhere, so the number on screen can always be explained by
//! pointing at the rows behind it — which is the whole reason section 63 asks
//! for the table.
//!
//! It is also what makes the anti-farming rules of section 88 expressible
//! without extra bookkeeping. "Only the first routine launch of a day earns
//! XP" is not a flag on `routines`; it is a question asked of the ledger
//! ("is there already a `routine_launch` row dated today?"), and the same
//! shape answers "has this task already paid out?" and "has this focus
//! session?". See [`awards`](#awards) below for the rule behind each source.
//!
//! # Where grants come from
//!
//! Nothing in this module is called by the frontend to *earn* XP. The three
//! events that pay out are the real completions built in earlier stages, and
//! each one is hooked at its single write path so XP cannot be minted by
//! calling a command:
//!
//! | Event | Hook site | Rule |
//! |---|---|---|
//! | Task completed | `services::tasks::update` | once per task |
//! | Focus session completed | `services::focus::end` | once per session, and only if it ran |
//! | Routine launched | `services::routines::prepare_launch` | first launch of the day only |
//!
//! Quests are the exception: the frontend asks for a quest to be paid, so
//! [`complete_quest`] is reachable from a command. What it is asked is only
//! *which* quest. Whether that quest is one of today's, and whether its
//! requirement is met, is decided here against the database by
//! `services::quests`, and the payout is ledger-guarded (once per quest per
//! day) and date-guarded (only on the day it is active for).
//!
//! # Failures are not the user's problem
//!
//! Section 50 puts gamification below the productivity UI, and this module
//! takes that literally: a task the user completed is completed whether or
//! not the XP row was written. The hook sites call [`note`] rather than `?`,
//! so a failure here is logged and dropped instead of rolling back the
//! completion that triggered it.
//!
//! # Naming
//!
//! Every payload here is `camelCase` on the wire, unlike the row-mirroring
//! services next door. `src/types/progress.ts` explains why: half of what
//! this module returns (the level curve, the award summary) is *computed*
//! rather than read from a table, so there is no row for it to mirror, and a
//! progression surface that was snake_case in one half and camelCase in the
//! other would be worse than one that picks a side.

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use crate::services::error::{ServiceError, ServiceResult};
use crate::services::quests;
use crate::services::validate::{normalize_text, validate_date};

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/// Section 43's reward table. "The exact rewards can be balanced later" —
/// they live here so that later is one edit.
///
/// The routine launch is the one figure that departs from section 43's table,
/// which offers +5. Section 88 replaces "launch a routine" with "first
/// routine launch of the day" and prices *that* at +10, and since this module
/// implements the section 88 version, it uses the section 88 number.
pub const TASK_COMPLETION_XP: i64 = 10;
/// A focus session that ran to its target (section 43).
pub const FOCUS_SESSION_XP: i64 = 25;
/// The first routine launch of a local day (section 88).
pub const ROUTINE_LAUNCH_XP: i64 = 10;
/// One of the day's objectives from section 44's checklist.
pub const DAILY_OBJECTIVE_XP: i64 = 50;
/// A maintenance/cleanup quest — section 44's "Organize Downloads".
pub const MAINTENANCE_QUEST_XP: i64 = 25;
/// Unlocking one of section 47's achievements. The figure is section 63's own
/// example row for an achievement payout.
pub const ACHIEVEMENT_XP: i64 = 100;

/// The shortest session that earns [`FOCUS_SESSION_XP`], in seconds.
///
/// A stopwatch can be started and stopped in the same second and still be
/// `completed`, which would be exactly the button-clicking section 88 says
/// XP must not reward. Five minutes is short enough that no real session
/// misses out and long enough that farming one costs more than the XP is
/// worth. `services::quests` holds a session to the same floor before it can
/// finish a quest.
pub const MIN_REWARDED_FOCUS_SECONDS: i64 = 5 * 60;

/// XP the *first* level costs. Level `n` costs `LEVEL_XP_STEP * n`, so the
/// levels get steadily longer without ever becoming a grind (section 45:
/// "Do not make users grind XP").
///
/// The step is 200 because it reproduces the section 45 mockup exactly: level
/// 4 costs `200 * 4` = 800 XP, which is the `620 / 800` the plan draws.
const LEVEL_XP_STEP: i64 = 200;

/// Where the curve stops. Reaching it takes 1,010,000 XP — around a hundred
/// thousand completed tasks — so this is a guard against unbounded arithmetic
/// rather than a ceiling anyone will meet.
const MAX_LEVEL: i64 = 100;

/// Section 46's "7 DAY STREAK", which is also the Consistent achievement.
const CONSISTENT_STREAK_DAYS: i64 = 7;
/// Section 47's Focused.
const FOCUSED_SESSIONS: i64 = 10;
/// Section 47's Organized, in days. See [`ProgressFacts::cleanup_days`] for
/// what counts as a cleanup task.
const ORGANIZED_DAYS: i64 = 10;
/// Section 47's Deep Work: ten hours, in seconds.
const DEEP_WORK_SECONDS: i64 = 10 * 60 * 60;

/// The `streaks` row. Section 46 tracks one user, so there is one row, and
/// `0005_seed_achievements.sql` seeds it — every read and write below
/// addresses it by this id rather than hunting for "the" row.
const STREAK_ROW_ID: i64 = 1;

/// How many ledger rows [`list_transactions`] will return at most, however
/// large a limit it is asked for.
const MAX_TRANSACTION_LIMIT: i64 = 500;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/// What earned a grant — the `source` column of section 63's table.
///
/// The variants are the vocabulary of the whole progression system: they name
/// the ledger rows, they are what the anti-farming checks match on, and they
/// are what the frontend renders in a history list. They are stored as the
/// snake_case strings below, which are also what crosses `invoke`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum XpSource {
    /// A task moved into `completed`. `source_id` is the task id.
    TaskCompletion,
    /// A focus session ended having reached its target. `source_id` is the
    /// session id.
    FocusSession,
    /// The day's first routine launch. `source_id` is the routine id that
    /// happened to be first.
    RoutineLaunch,
    /// One of section 44's daily objectives. `source_id` is the quest id.
    DailyObjective,
    /// A maintenance/cleanup quest. `source_id` is the quest id.
    MaintenanceQuest,
    /// One of section 47's achievements was unlocked. `source_id` is the
    /// achievement id.
    Achievement,
}

impl XpSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TaskCompletion => "task_completion",
            Self::FocusSession => "focus_session",
            Self::RoutineLaunch => "routine_launch",
            Self::DailyObjective => "daily_objective",
            Self::MaintenanceQuest => "maintenance_quest",
            Self::Achievement => "achievement",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "task_completion" => Some(Self::TaskCompletion),
            "focus_session" => Some(Self::FocusSession),
            "routine_launch" => Some(Self::RoutineLaunch),
            "daily_objective" => Some(Self::DailyObjective),
            "maintenance_quest" => Some(Self::MaintenanceQuest),
            "achievement" => Some(Self::Achievement),
            _ => None,
        }
    }
}

impl ToSql for XpSource {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.as_str()))
    }
}

impl FromSql for XpSource {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let raw = value.as_str()?;
        Self::parse(raw)
            .ok_or_else(|| FromSqlError::Other(format!("unknown XP source {raw:?}").into()))
    }
}

/// The two kinds of quest section 44 describes, and the `type` column of
/// section 62's table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestType {
    /// "Complete 3 tasks", "Complete a 50-minute focus session" — the day's
    /// full-weight objectives.
    Objective,
    /// The lighter band: one task, one session, one routine launched, and
    /// the cleanup quests ("Organize Downloads"). Section 43 prices these at
    /// 25.
    Maintenance,
}

impl QuestType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Objective => "objective",
            Self::Maintenance => "maintenance",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "objective" => Some(Self::Objective),
            "maintenance" => Some(Self::Maintenance),
            _ => None,
        }
    }

    /// What completing a quest of this kind pays, per section 43.
    ///
    /// The reward is a property of the *kind*, not of the individual quest,
    /// which is what keeps a quest from being worth whatever whoever created
    /// it decided. `quests.xp_reward` still stores it, so the checklist can
    /// render "+25 XP" straight from the row, but the value written there is
    /// always this one.
    pub fn xp_reward(self) -> i64 {
        match self {
            Self::Objective => DAILY_OBJECTIVE_XP,
            Self::Maintenance => MAINTENANCE_QUEST_XP,
        }
    }

    /// The ledger source a completed quest of this kind writes.
    fn xp_source(self) -> XpSource {
        match self {
            Self::Objective => XpSource::DailyObjective,
            Self::Maintenance => XpSource::MaintenanceQuest,
        }
    }
}

impl ToSql for QuestType {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.as_str()))
    }
}

impl FromSql for QuestType {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let raw = value.as_str()?;
        Self::parse(raw)
            .ok_or_else(|| FromSqlError::Other(format!("unknown quest type {raw:?}").into()))
    }
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// One row of section 63's ledger.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XpTransaction {
    pub id: i64,
    pub source: XpSource,
    /// The row that earned it — which table depends on `source`. Null only
    /// for a grant with nothing to point at, which nothing here produces
    /// today but the column allows.
    pub source_id: Option<i64>,
    pub amount: i64,
    pub created_at: String,
}

impl XpTransaction {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            source: row.get("source")?,
            source_id: row.get("source_id")?,
            amount: row.get("amount")?,
            created_at: row.get("created_at")?,
        })
    }
}

/// Where the user is inside their current level (section 45).
///
/// Both figures are measured from the start of the level rather than from
/// zero, so the bar is `xpIntoLevel / xpForNextLevel` and the caller never
/// needs to know the curve. This is the `{level, xpIntoLevel, xpForNextLevel}`
/// the Stage 9 brief specifies, and it matches `LevelProgress` in
/// `src/types/progress.ts` field for field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelProgress {
    pub level: i64,
    /// XP earned since reaching `level`.
    pub xp_into_level: i64,
    /// XP this level costs in total. Zero at [`MAX_LEVEL`], where there is no
    /// next level to fill a bar towards.
    pub xp_for_next_level: i64,
}

/// The `streaks` row (section 46), as the UI reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreakProgress {
    /// Productive days ending today, or ending yesterday while today is still
    /// young — see [`streak`] for why a day in progress does not break one.
    pub current_streak: i64,
    /// The best run on record.
    pub longest_streak: i64,
    /// The most recent day that counted, as `YYYY-MM-DD` local time.
    pub last_active_date: Option<String>,
}

/// Everything the Progress widget (section 7) and the Progress page show.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub level: LevelProgress,
    pub streak: StreakProgress,
    /// Lifetime XP: `SUM(xp_transactions.amount)`.
    pub total_xp: i64,
}

/// One of section 47's achievements, with the user's state on it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Achievement {
    pub id: i64,
    /// The stable identifier the rules in [`evaluate`] match on. Seeded by
    /// `0005_seed_achievements.sql` and never shown to the user.
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    /// A lucide-react icon name, matching the convention task categories use.
    pub icon: Option<String>,
    /// When it was unlocked, or null while it is still locked. This is the
    /// locked/unlocked state the achievements grid renders.
    pub unlocked_at: Option<String>,
    /// How far along the user is, for the achievements that count something.
    ///
    /// Null for the two that do not — "Complete your first task" has nothing
    /// to show a bar for — which is what lets the grid decide whether to draw
    /// one without knowing what any particular achievement means.
    pub progress: Option<AchievementProgress>,
}

/// How far along an achievement is, in whatever unit reads best for it: focus
/// sessions for Focused, days for Consistent and Organized, and whole hours
/// for Deep Work — because "7 / 10" is a sentence and "25200 / 36000" is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementProgress {
    pub current: i64,
    pub target: i64,
}

impl Achievement {
    /// Reads the row. `progress` is filled in afterwards by whoever has the
    /// [`ProgressFacts`] to hand — it is a count across four other tables,
    /// not a column.
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            key: row.get("key")?,
            name: row.get("name")?,
            description: row.get("description")?,
            icon: row.get("icon")?,
            unlocked_at: row.get("unlocked_at")?,
            progress: None,
        })
    }
}

/// What one rewardable event actually did.
///
/// Returned by every `award_*` function so a caller can tell an event that
/// paid out from one the anti-farming rules suppressed — `granted` is 0 for
/// the second routine launch of a day, and the rest of the fields still
/// describe where the user now stands.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XpAward {
    /// XP the event itself earned. Zero when the rule declined it.
    pub granted: i64,
    /// What the grant was recorded as, whether or not it paid out.
    pub source: XpSource,
    pub total_xp: i64,
    pub level: LevelProgress,
    pub streak: StreakProgress,
    /// Achievements this event pushed over their threshold, in the order they
    /// unlocked. Usually empty. Their [`ACHIEVEMENT_XP`] is already included
    /// in `total_xp` but not in `granted`, which is the event's own reward.
    pub unlocked: Vec<Achievement>,
}

/// A finished quest, as `quest_completions` records it (section 62).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestCompletion {
    /// The generator's id, not the row id — the identity the caller knows.
    pub quest_id: String,
    /// The local day it was completed on, `YYYY-MM-DD`.
    pub date_key: String,
    /// What was actually granted, which is not necessarily what today's pool
    /// says the quest is worth: a completion recorded under an older balance
    /// answers with the figure it was paid.
    pub xp_awarded: i64,
}

// ---------------------------------------------------------------------------
// The level curve (section 45)
// ---------------------------------------------------------------------------

/// Turns lifetime XP into a level and a position inside it.
///
/// Pure, and deliberately so — the curve is arithmetic, not a table, so it
/// can be reasoned about (and tested) without a database. Level `n` costs
/// `LEVEL_XP_STEP * n`, which means reaching level `n` has cost
/// `LEVEL_XP_STEP * n * (n - 1) / 2` in total.
///
/// The loop runs at most [`MAX_LEVEL`] times and is used in preference to the
/// closed form because the closed form needs a square root, and a curve you
/// have to solve a quadratic to read is a curve nobody will change later.
pub fn level_for(total_xp: i64) -> LevelProgress {
    let mut remaining = total_xp.max(0);
    let mut level: i64 = 1;

    loop {
        if level >= MAX_LEVEL {
            return LevelProgress {
                level: MAX_LEVEL,
                xp_into_level: remaining,
                xp_for_next_level: 0,
            };
        }

        let cost = LEVEL_XP_STEP * level;
        if remaining < cost {
            return LevelProgress {
                level,
                xp_into_level: remaining,
                xp_for_next_level: cost,
            };
        }

        remaining -= cost;
        level += 1;
    }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// Lifetime XP: the sum of the ledger (section 63).
pub fn total_xp(conn: &Connection) -> ServiceResult<i64> {
    let total = conn.query_row(
        "SELECT COALESCE(SUM(amount), 0) FROM xp_transactions",
        [],
        |row| row.get(0),
    )?;
    Ok(total)
}

/// The `{level, xpIntoLevel, xpForNextLevel}` the Stage 9 brief asks for.
pub fn level_progress(conn: &Connection) -> ServiceResult<LevelProgress> {
    Ok(level_for(total_xp(conn)?))
}

/// Level, streak and lifetime XP in one read — what the dashboard widget
/// needs, without three round trips.
///
/// Recomputes the streak on the way through, so opening the app the morning
/// after a productive day shows the day already counted rather than waiting
/// for the next completion to refresh it.
pub fn progress(conn: &Connection) -> ServiceResult<Progress> {
    let total = total_xp(conn)?;
    Ok(Progress {
        level: level_for(total),
        streak: streak(conn)?,
        total_xp: total,
    })
}

/// The most recent ledger rows, newest first — the audit trail section 63
/// exists for, and what a "+10 XP" toast reads to know what just happened.
pub fn list_transactions(conn: &Connection, limit: Option<i64>) -> ServiceResult<Vec<XpTransaction>> {
    let limit = limit.unwrap_or(MAX_TRANSACTION_LIMIT).clamp(1, MAX_TRANSACTION_LIMIT);

    let mut statement = conn.prepare(
        "SELECT id, source, source_id, amount, created_at
           FROM xp_transactions
          ORDER BY created_at DESC, id DESC
          LIMIT ?1",
    )?;
    let rows = statement.query_map(params![limit], XpTransaction::from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// All six achievements (section 47), locked and unlocked alike, in seed
/// order — the grid shows what is still to earn as well as what is earned.
pub fn list_achievements(conn: &Connection) -> ServiceResult<Vec<Achievement>> {
    let mut statement = conn.prepare(&format!("{ACHIEVEMENT_SELECT} ORDER BY a.id"))?;
    let rows = statement.query_map([], Achievement::from_row)?;
    let mut achievements = rows.collect::<rusqlite::Result<Vec<_>>>()?;

    // Consistent is measured against the *stored* streak, which only the
    // recompute refreshes. Every write path already reaches this through
    // `settle`, which recomputes first; this read path may not have been
    // preceded by one, so it does its own — otherwise the grid could show a
    // streak a day out of date purely because of the order two loads ran in.
    streak(conn)?;

    // One facts read for the whole grid rather than one per tile.
    let facts = facts(conn)?;
    for achievement in &mut achievements {
        achievement.progress = progress_towards(&achievement.key, &facts);
    }

    Ok(achievements)
}

const ACHIEVEMENT_SELECT: &str = "SELECT a.id, a.key, a.name, a.description, a.icon, \
            u.unlocked_at AS unlocked_at \
       FROM achievements AS a \
       LEFT JOIN user_achievements AS u ON u.achievement_id = a.id";

// ---------------------------------------------------------------------------
// Streaks (section 46)
// ---------------------------------------------------------------------------

/// Recomputes the streak from the days that actually counted, stores the
/// result in `streaks`, and returns it.
///
/// # What counts as a day
///
/// Section 46's three, unchanged: the user completed at least one task,
/// completed a focus session, or launched a routine. The first two are read
/// straight from `tasks` and `focus_sessions`. The third is read from the
/// ledger, because `routines` keeps only `last_launched_at` and a running
/// count — it cannot say *which* days had a launch. The `routine_launch`
/// rows can, and exactly: section 88's rule writes one on the first launch of
/// each day and none afterwards, so a launch day is a row and a row is a
/// launch day.
///
/// That does mean launches from before this table existed cannot contribute a
/// day. The alternative — a fourth table recording every launch — would be a
/// second ledger for a question the first one already answers.
///
/// # Why the streak is derived rather than incremented
///
/// Incrementing a counter as days go by needs something to run at midnight,
/// and a desktop app that was closed overnight has nothing that did. Deriving
/// the whole run from the completions themselves is correct whenever it is
/// asked, on a machine that was off for a week as much as on one that was not.
///
/// The `streaks` row is still written, and still matters: `longest_streak`
/// and `last_active_date` are kept at their best-ever values rather than
/// being overwritten downwards, so a record survives the user deleting the
/// old completed tasks that proved it.
///
/// # Today is not a broken streak
///
/// A run that ends *yesterday* is still current: the day is not over, and a
/// counter that reset itself every midnight until the first task of the
/// morning would punish the user for having got up. A run that ends the day
/// before yesterday is over.
pub fn streak(conn: &Connection) -> ServiceResult<StreakProgress> {
    let days = productive_days(conn)?;
    let today: i64 = conn.query_row(
        "SELECT CAST(julianday(date('now', 'localtime')) AS INTEGER)",
        [],
        |row| row.get(0),
    )?;

    let mut current: i64 = 0;
    let mut longest: i64 = 0;
    let mut run: i64 = 0;
    let mut previous: Option<i64> = None;

    // `days` is newest first, so the first run the walk finds is the one
    // ending most recently — the only one that can be the current streak.
    for (index, (_, ordinal)) in days.iter().enumerate() {
        run = match previous {
            Some(earlier) if earlier - ordinal == 1 => run + 1,
            _ => 1,
        };
        longest = longest.max(run);
        previous = Some(*ordinal);

        // Still inside the first run, and that run reaches today or
        // yesterday. Once the walk breaks into a second run this stops
        // updating, because `run` no longer describes days ending now.
        if run == index as i64 + 1 && today - days[0].1 <= 1 {
            current = run;
        }
    }

    let last_active_date = days.first().map(|(day, _)| day.clone());

    conn.execute(
        "UPDATE streaks
            SET current_streak = ?2,
                longest_streak = MAX(longest_streak, ?3),
                last_active_date = COALESCE(?4, last_active_date),
                updated_at = datetime('now')
          WHERE id = ?1",
        params![STREAK_ROW_ID, current, longest, last_active_date],
    )?;

    stored_streak(conn)
}

/// Reads the `streaks` row without recomputing it. Used where the answer has
/// just been written and only needs reading back.
fn stored_streak(conn: &Connection) -> ServiceResult<StreakProgress> {
    let stored = conn
        .query_row(
            "SELECT current_streak, longest_streak, last_active_date
               FROM streaks WHERE id = ?1",
            params![STREAK_ROW_ID],
            |row| {
                Ok(StreakProgress {
                    current_streak: row.get("current_streak")?,
                    longest_streak: row.get("longest_streak")?,
                    last_active_date: row.get("last_active_date")?,
                })
            },
        )
        .map_err(|err| match err {
            // The row is seeded by 0005 and nothing deletes it, so its
            // absence means a database this build does not understand.
            rusqlite::Error::QueryReturnedNoRows => {
                ServiceError::validation("The streak record is missing from this database.")
            }
            other => ServiceError::Db(other),
        })?;
    Ok(stored)
}

/// Every local day that met one of section 46's three conditions, newest
/// first, as `(YYYY-MM-DD, julian day number)`.
///
/// The julian number is what the run-length walk actually uses: consecutive
/// calendar days are consecutive integers, so "is this the day before that
/// one" is a subtraction rather than date arithmetic across month and year
/// boundaries. `CAST(... AS INTEGER)` truncates every date's `.5` the same
/// way, so the differences stay exact.
///
/// Timestamps are stored as UTC (`datetime('now')`), so every one is
/// converted with `'localtime'` first: a task completed at 8pm on a Monday in
/// UTC+9 counted for the Monday the user was living in.
///
/// Routine launches are asked of two tables because they have been recorded
/// two ways. `routine_launches` (migration 0007) is the dated log and is the
/// answer for every launch since Stage 11; before it, the only dated trace of
/// a launch was the `routine_launch` XP row, which is capped at one a day
/// (section 88) but is present on every day one happened — enough to say the
/// day counted, which is all the streak asks. `UNION` de-duplicates, so a day
/// both know about is still one day. `services/analytics.rs` reaches the same
/// verdict from the log alone, and agrees with this for every day the log
/// covers.
fn productive_days(conn: &Connection) -> ServiceResult<Vec<(String, i64)>> {
    let mut statement = conn.prepare(
        "WITH productive(day) AS (
             SELECT DATE(completed_at, 'localtime')
               FROM tasks
              WHERE status = 'completed' AND completed_at IS NOT NULL
             UNION
             SELECT DATE(ended_at, 'localtime')
               FROM focus_sessions
              WHERE completed = 1 AND ended_at IS NOT NULL
             UNION
             SELECT DATE(launched_at, 'localtime')
               FROM routine_launches
             UNION
             SELECT DATE(created_at, 'localtime')
               FROM xp_transactions
              WHERE source = 'routine_launch'
         )
         SELECT day, CAST(julianday(day) AS INTEGER) AS ordinal
           FROM productive
          WHERE day IS NOT NULL
          ORDER BY ordinal DESC",
    )?;
    let rows = statement.query_map([], |row| Ok((row.get("day")?, row.get("ordinal")?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

// ---------------------------------------------------------------------------
// Achievements (section 47)
// ---------------------------------------------------------------------------

/// The counts every achievement rule is judged against, read in one pass.
///
/// Gathered together rather than queried per rule because the rules are
/// evaluated on every completion: six independent lookups on every finished
/// task would be five more than the work needs.
#[derive(Debug, Clone, Copy)]
struct ProgressFacts {
    completed_tasks: i64,
    routine_launches: i64,
    completed_focus_sessions: i64,
    focus_seconds: i64,
    /// Local days with at least one cleanup action — section 47's "cleanup
    /// tasks".
    ///
    /// A cleanup task is something the user did with one of the cleanup
    /// utilities (sections 38-42): a move, delete, archive or organize they
    /// confirmed in a review flow, which `services::cleanup_actions` records
    /// as a row. Organized counts the *days* with such a row rather than the
    /// rows, so ten deletes in one sitting are one day of cleanup, not the
    /// whole achievement — section 88's rule that the reward follows
    /// meaningful activity rather than repeated clicks.
    ///
    /// It used to count completed maintenance quests, back when no quest
    /// involved the cleanup tools and the count had nothing to do with
    /// cleanup. Those quests are still paid for; they no longer count here.
    cleanup_days: i64,
    longest_streak: i64,
}

fn facts(conn: &Connection) -> ServiceResult<ProgressFacts> {
    let one = |sql: &str| -> ServiceResult<i64> { Ok(conn.query_row(sql, [], |row| row.get(0))?) };

    Ok(ProgressFacts {
        completed_tasks: one("SELECT COUNT(*) FROM tasks WHERE status = 'completed'")?,
        routine_launches: one("SELECT COALESCE(SUM(launch_count), 0) FROM routines")?,
        // Only sessions that ran to their target count, here and for Deep
        // Work: an interrupted session records real seconds, but so does one
        // the app closed on, and a threshold that a crash can advance is not
        // a threshold. `completed` is the honest half of that pair.
        completed_focus_sessions: one("SELECT COUNT(*) FROM focus_sessions WHERE completed = 1")?,
        focus_seconds: one(
            "SELECT COALESCE(SUM(duration_seconds), 0) FROM focus_sessions WHERE completed = 1",
        )?,
        // Local days, converted the same way the streak converts its days.
        // Read here rather than through `cleanup_actions`, which calls into
        // this module, so the dependency keeps pointing one way.
        cleanup_days: one(
            "SELECT COUNT(DISTINCT DATE(created_at, 'localtime')) FROM cleanup_actions",
        )?,
        longest_streak: stored_streak(conn)?.longest_streak,
    })
}

/// Whether each of section 47's six is earned, given the facts.
///
/// Keyed by the `achievements.key` values `0005_seed_achievements.sql`
/// seeds. A key here with no row there simply never unlocks, and a row there
/// with no key here never unlocks either — neither is an error, which is what
/// lets a later migration add a seventh achievement before the rule for it
/// exists (or the other way round).
fn rules(facts: &ProgressFacts) -> [(&'static str, bool); 6] {
    [
        ("first_task", facts.completed_tasks >= 1),
        ("first_routine", facts.routine_launches >= 1),
        ("focused", facts.completed_focus_sessions >= FOCUSED_SESSIONS),
        ("consistent", facts.longest_streak >= CONSISTENT_STREAK_DAYS),
        ("organized", facts.cleanup_days >= ORGANIZED_DAYS),
        ("deep_work", facts.focus_seconds >= DEEP_WORK_SECONDS),
    ]
}

/// How far along an achievement is, or `None` for the two with nothing to
/// count.
///
/// First Task and First Routine are deliberately unmeasured: a bar reading
/// "0 / 1" beside "Complete your first task" says nothing the empty tile did
/// not already say. The other four each count in their own unit — see
/// [`AchievementProgress`].
///
/// The thresholds are the same constants [`rules`] tests against, so a bar
/// that reaches its end and an achievement that unlocks are the same event.
fn progress_towards(key: &str, facts: &ProgressFacts) -> Option<AchievementProgress> {
    let (current, target) = match key {
        "focused" => (facts.completed_focus_sessions, FOCUSED_SESSIONS),
        "consistent" => (facts.longest_streak, CONSISTENT_STREAK_DAYS),
        "organized" => (facts.cleanup_days, ORGANIZED_DAYS),
        "deep_work" => (facts.focus_seconds / 3600, DEEP_WORK_SECONDS / 3600),
        _ => return None,
    };

    Some(AchievementProgress {
        current: current.min(target),
        target,
    })
}

/// Evaluates every rule and unlocks whatever has become true, granting
/// [`ACHIEVEMENT_XP`] for each.
///
/// Called after every rewardable event rather than on a schedule, which is
/// what "evaluated whenever relevant events occur" means in practice: the
/// tenth focus session unlocks Focused as it ends, not the next time somebody
/// opens the Progress page.
///
/// Re-entrant and idempotent. The `UNIQUE (achievement_id)` on
/// `user_achievements` is the real guard — an insert that changes no rows is
/// an achievement somebody else already unlocked, and it earns nothing — so
/// two evaluations racing cannot pay twice.
pub fn evaluate(conn: &Connection) -> ServiceResult<Vec<Achievement>> {
    let facts = facts(conn)?;
    let mut unlocked = Vec::new();

    for (key, earned) in rules(&facts) {
        if !earned {
            continue;
        }

        let Some(achievement) = achievement_by_key(conn, key)? else {
            continue;
        };
        if achievement.unlocked_at.is_some() {
            continue;
        }

        let inserted = conn.execute(
            "INSERT OR IGNORE INTO user_achievements (achievement_id) VALUES (?1)",
            params![achievement.id],
        )?;
        if inserted == 0 {
            continue;
        }

        grant(conn, XpSource::Achievement, Some(achievement.id), ACHIEVEMENT_XP)?;

        // Re-read so the returned row carries the `unlocked_at` that was just
        // stamped, which is what a toast dates. No `progress` on it: it has
        // just been earned, so there is nothing left to be part-way through.
        if let Some(fresh) = achievement_by_key(conn, key)? {
            unlocked.push(fresh);
        }
    }

    Ok(unlocked)
}

fn achievement_by_key(conn: &Connection, key: &str) -> ServiceResult<Option<Achievement>> {
    conn.query_row(
        &format!("{ACHIEVEMENT_SELECT} WHERE a.key = ?1"),
        params![key],
        Achievement::from_row,
    )
    .map(Some)
    .or_else(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(ServiceError::Db(other)),
    })
}

// ---------------------------------------------------------------------------
// Awards
// ---------------------------------------------------------------------------

/// Writes one ledger row. The only place `xp_transactions` is inserted into.
fn grant(
    conn: &Connection,
    source: XpSource,
    source_id: Option<i64>,
    amount: i64,
) -> ServiceResult<()> {
    conn.execute(
        "INSERT INTO xp_transactions (source, source_id, amount) VALUES (?1, ?2, ?3)",
        params![source, source_id, amount],
    )?;
    Ok(())
}

/// Whether this exact thing has already been paid for — the once-per-row half
/// of section 88.
fn already_granted(conn: &Connection, source: XpSource, source_id: i64) -> ServiceResult<bool> {
    let exists = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM xp_transactions WHERE source = ?1 AND source_id = ?2
         )",
        params![source, source_id],
        |row| row.get(0),
    )?;
    Ok(exists)
}

/// Whether this source has already paid out today — the once-per-day half of
/// section 88, which is what stops "launch routine, +XP, launch routine, +XP".
fn granted_today(conn: &Connection, source: XpSource) -> ServiceResult<bool> {
    let exists = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM xp_transactions
              WHERE source = ?1
                AND DATE(created_at, 'localtime') = DATE('now', 'localtime')
         )",
        params![source],
        |row| row.get(0),
    )?;
    Ok(exists)
}

/// Finishes an award: recomputes the streak, evaluates the achievements the
/// event may have unlocked, and reports where the user now stands.
///
/// The order is the point. The streak is written before the achievements are
/// judged, so a seventh consecutive day unlocks Consistent on the completion
/// that made it seven rather than on the next one.
fn settle(conn: &Connection, source: XpSource, granted: i64) -> ServiceResult<XpAward> {
    let streak = streak(conn)?;
    let unlocked = evaluate(conn)?;
    let total = total_xp(conn)?;

    Ok(XpAward {
        granted,
        source,
        total_xp: total,
        level: level_for(total),
        streak,
        unlocked,
    })
}

/// Task completed (section 43: +10 XP).
///
/// Paid once per task, ever. Completing a task, un-completing it and
/// completing it again is one piece of work and earns one reward — without
/// that, the checkbox itself would be the farm section 88 describes.
///
/// A recurring task is not affected: each occurrence is its own row with its
/// own id (see `services::task_recurrence`), so a daily habit pays every day.
pub fn award_task_completion(conn: &Connection, task_id: i64) -> ServiceResult<XpAward> {
    let source = XpSource::TaskCompletion;
    if already_granted(conn, source, task_id)? {
        return settle(conn, source, 0);
    }

    grant(conn, source, Some(task_id), TASK_COMPLETION_XP)?;
    settle(conn, source, TASK_COMPLETION_XP)
}

/// Focus session completed (section 43: +25 XP).
///
/// Three conditions, all of them section 88's "meaningful activity":
///
/// * the session reached its target (`completed`), so abandoning one earns
///   nothing and neither does a session the app was closed on;
/// * it ran for at least [`MIN_REWARDED_FOCUS_SECONDS`], so a stopwatch
///   started and stopped is not 25 XP;
/// * it has not been paid for before.
pub fn award_focus_session(conn: &Connection, session_id: i64) -> ServiceResult<XpAward> {
    let source = XpSource::FocusSession;

    let qualifies: bool = conn.query_row(
        "SELECT completed = 1
                AND ended_at IS NOT NULL
                AND COALESCE(duration_seconds, 0) >= ?2
           FROM focus_sessions WHERE id = ?1",
        params![session_id, MIN_REWARDED_FOCUS_SECONDS],
        |row| row.get(0),
    )?;

    if !qualifies || already_granted(conn, source, session_id)? {
        return settle(conn, source, 0);
    }

    grant(conn, source, Some(session_id), FOCUS_SESSION_XP)?;
    settle(conn, source, FOCUS_SESSION_XP)
}

/// Routine launched — the first one of the day only (section 88: +10 XP).
///
/// This is the rule section 88 is written about. The user's second, fifth and
/// twentieth launch of the day all earn nothing; `granted` comes back 0 and
/// the routine still launches, because opening a workspace twice is a normal
/// thing to do and only the *reward* for it is capped.
///
/// The check is against the ledger rather than against `routines`, so it is
/// the first launch of the day across every routine, not per routine —
/// otherwise five routines would be five payouts and the rule would buy
/// nothing.
pub fn award_routine_launch(conn: &Connection, routine_id: i64) -> ServiceResult<XpAward> {
    let source = XpSource::RoutineLaunch;
    if granted_today(conn, source)? {
        return settle(conn, source, 0);
    }

    grant(conn, source, Some(routine_id), ROUTINE_LAUNCH_XP)?;
    settle(conn, source, ROUTINE_LAUNCH_XP)
}

/// Records a failed award instead of letting it fail the thing that caused it.
///
/// Every hook site calls this. Section 50 puts gamification below the
/// productivity UI, and the strongest form of that is: the task is completed,
/// the session is recorded, the routine has launched — the XP is a footnote,
/// and a footnote that cannot be written is not a reason to undo the page.
/// Returns the award when there was one, so a caller that wants it can have
/// it and a caller that does not can ignore it.
pub fn note(outcome: ServiceResult<XpAward>, occasion: &str) -> Option<XpAward> {
    match outcome {
        Ok(award) => Some(award),
        Err(error) => {
            crate::log_error!("[xp] could not award XP for {occasion}: {error}");
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Quests (sections 44, 62)
// ---------------------------------------------------------------------------

/// Records that one of today's quests was finished, and pays for it.
///
/// The caller names the quest and nothing else. Its title, its reward band
/// and what finishing it means all come from `services::quests`, which is the
/// one definition of the pool, so a request cannot describe a quest into
/// being worth something.
///
/// # Why a quest is stored on completion rather than on offer
///
/// Section 44's quests are *generated*, not authored: `services::quests`
/// derives the day's two or three from the calendar date, so every window on
/// every machine offers the same list for the same day without a table having
/// to agree first. Writing three rows a day forever to describe a pure
/// function of the date would be storing a derivation.
///
/// The completion is not a derivation — it is a thing that happened, and the
/// XP granted for it has to be auditable (section 63) — so it is stored, and
/// `quest_completions` and the ledger both point at a quest by row id. Hence
/// the row is created here, at the moment it is first needed, keyed by the
/// generator's own `key` and the day it was active for.
///
/// # The guards, in the order they are checked
///
/// * **A real quest, today.** An id the pool does not know is refused, and so
///   is a quest dated to any day but today: yesterday's unfinished objectives
///   are not a pile of XP waiting to be collected on a slow afternoon.
/// * **Once per quest per day.** The caller re-counts the day on every load
///   and will therefore keep concluding "Complete 3 tasks is done" for the
///   rest of the day, in every window at once. So the guard cannot be
///   memory: it is `(key, active_date)`, which every window can see, plus the
///   ledger check behind it. A second call answers with the completion the
///   first one recorded and grants nothing. It is checked before the two
///   below so that a quest paid this morning still answers the same way after
///   the user un-ticks a task or changes the daily quest count.
/// * **Offered today.** Only the day's two or three can be paid, at the quest
///   count Settings holds, so meeting an objective the day did not ask for is
///   not a second way to be paid for the same work.
/// * **Actually done.** The requirement is re-counted from the database for
///   the local day — completed tasks, completed focus sessions of the
///   required length, launches in `routine_launches`, confirmed cleanup
///   actions — and a quest that is not met is refused with a sentence saying
///   what is still outstanding. This is section 88: the reward follows the
///   work, not the request for it.
/// * **The reward is the type's.** `xp_reward` is written from
///   [`QuestType::xp_reward`], so a quest is worth what section 43 says its
///   band is worth.
pub fn complete_quest(
    conn: &Connection,
    quest_id: &str,
    date_key: &str,
) -> ServiceResult<QuestCompletion> {
    let Some(key) = normalize_text(Some(quest_id.to_owned())) else {
        return Err(ServiceError::validation("A quest needs an id."));
    };
    let date_key = validate_date(ACTIVE_DATE, date_key)?;
    let Some(quest) = quests::find(&key) else {
        return Err(ServiceError::validation(format!(
            "There is no objective called \"{key}\"."
        )));
    };
    let title = quest.title;

    let transaction = conn.unchecked_transaction()?;

    let today: String =
        transaction.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))?;
    if date_key != today {
        return Err(ServiceError::validation(format!(
            "\"{title}\" was one of {date_key}'s objectives and can no longer be completed."
        )));
    }

    // Already paid for — by an earlier load, or by another window that
    // reached the same conclusion a moment ago. Answer with what it actually
    // granted rather than with what today's pool says the quest is worth.
    if let Some(recorded) = recorded_completion(&transaction, &key, &date_key)? {
        transaction.commit()?;
        return Ok(QuestCompletion {
            quest_id: key,
            date_key,
            xp_awarded: recorded,
        });
    }

    if !quests::offered_on(&transaction, &date_key)?
        .iter()
        .any(|offered| offered.id == quest.id)
    {
        return Err(ServiceError::validation(format!(
            "\"{title}\" is not one of today's objectives."
        )));
    }

    let measured = quests::measure(&transaction, quest, &date_key)?;
    if let Some(outstanding) = measured.shortfall() {
        let noun = if outstanding.target == 1 {
            outstanding.noun.to_owned()
        } else {
            format!("{}s", outstanding.noun)
        };
        return Err(ServiceError::validation(format!(
            "\"{title}\" is not finished yet: {} of {} {noun} so far today.",
            outstanding.current, outstanding.target
        )));
    }

    let source = quest.quest_type.xp_source();
    let reward = quest.quest_type.xp_reward();
    let quest_id = ensure_quest_row(&transaction, &key, title, quest.quest_type, &date_key)?;

    transaction.execute(
        "INSERT INTO quest_completions (quest_id, xp_awarded) VALUES (?1, ?2)",
        params![quest_id, reward],
    )?;
    grant(&transaction, source, Some(quest_id), reward)?;

    // Settled for its side effects: the quest's XP can be what pushes the
    // level over, and the achievements are judged before this returns, as
    // they are after every other award.
    settle(&transaction, source, reward)?;
    transaction.commit()?;

    Ok(QuestCompletion {
        quest_id: key,
        date_key,
        xp_awarded: reward,
    })
}

/// The quests already paid for on a local date, so a caller that re-counts
/// the day can grant only the difference.
pub fn list_quest_completions(
    conn: &Connection,
    date_key: &str,
) -> ServiceResult<Vec<QuestCompletion>> {
    let date_key = validate_date(ACTIVE_DATE, date_key)?;

    let mut statement = conn.prepare(
        "SELECT q.key AS quest_id, q.active_date AS date_key, c.xp_awarded AS xp_awarded
           FROM quest_completions AS c
           JOIN quests AS q ON q.id = c.quest_id
          WHERE q.active_date = ?1 AND q.key IS NOT NULL
          ORDER BY c.id",
    )?;
    let rows = statement.query_map(params![date_key], |row| {
        Ok(QuestCompletion {
            quest_id: row.get("quest_id")?,
            date_key: row.get("date_key")?,
            xp_awarded: row.get("xp_awarded")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Finds or creates the row for one generated quest on one day, and returns
/// its id.
///
/// `INSERT OR IGNORE` against the unique `(key, active_date)` index rather
/// than a read-then-write, so two windows completing the same objective in
/// the same moment cannot both decide the row is missing and create it.
fn ensure_quest_row(
    conn: &Connection,
    key: &str,
    title: &str,
    quest_type: QuestType,
    active_date: &str,
) -> ServiceResult<i64> {
    conn.execute(
        "INSERT OR IGNORE INTO quests (key, type, title, xp_reward, active_date)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![key, quest_type, title, quest_type.xp_reward(), active_date],
    )?;

    let id = conn.query_row(
        "SELECT id FROM quests WHERE key = ?1 AND active_date = ?2",
        params![key, active_date],
        |row| row.get(0),
    )?;
    Ok(id)
}

/// What one quest has already been paid on one day, if anything.
///
/// Asked by `(key, active_date)` rather than by row id, so checking does not
/// create the row: a quest refused below leaves nothing behind.
fn recorded_completion(
    conn: &Connection,
    key: &str,
    active_date: &str,
) -> ServiceResult<Option<i64>> {
    let recorded: Option<i64> = conn.query_row(
        "SELECT (SELECT c.xp_awarded
                   FROM quest_completions AS c
                   JOIN quests AS q ON q.id = c.quest_id
                  WHERE q.key = ?1 AND q.active_date = ?2
                  ORDER BY c.id
                  LIMIT 1)",
        params![key, active_date],
        |row| row.get(0),
    )?;
    Ok(recorded)
}

/// The label `validate_date` puts in a rejection message.
const ACTIVE_DATE: &str = "Quest date";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;
    use crate::services::quests::{DailyMetric, QuestDefinition, Requirement};
    use crate::services::{focus, routines, tasks};
    use serde_json::json;

    fn conn() -> Connection {
        init_memory_db().expect("in-memory database")
    }

    fn a_task(conn: &Connection, title: &str) -> i64 {
        tasks::create(conn, serde_json::from_value(json!({ "title": title })).unwrap())
            .unwrap()
            .id
    }

    fn complete_task(conn: &Connection, id: i64) {
        tasks::update(
            conn,
            id,
            serde_json::from_value(json!({ "status": "completed" })).unwrap(),
        )
        .unwrap();
    }

    fn a_routine(conn: &Connection, name: &str) -> i64 {
        routines::create(
            conn,
            serde_json::from_value(json!({ "name": name, "actions": [] })).unwrap(),
        )
        .unwrap()
        .id
    }

    /// Runs a focus session end to end, backdating `started_at` so the
    /// recorded duration survives `focus::end`'s clamp to the wall clock.
    /// The start is moved back to now afterwards, so a quest counts the
    /// session for today even when the tests run just after midnight.
    fn a_completed_session(conn: &Connection, seconds: i64) -> i64 {
        let session = focus::start(
            conn,
            serde_json::from_value(json!({ "preset": "stopwatch" })).unwrap(),
        )
        .unwrap();

        conn.execute(
            "UPDATE focus_sessions
                SET started_at = datetime('now', ?2)
              WHERE id = ?1",
            params![session.id, format!("-{} seconds", seconds + 5)],
        )
        .unwrap();

        focus::end(
            conn,
            session.id,
            serde_json::from_value(json!({ "completed": true, "duration_seconds": seconds }))
                .unwrap(),
        )
        .unwrap();
        conn.execute(
            "UPDATE focus_sessions SET started_at = datetime('now') WHERE id = ?1",
            params![session.id],
        )
        .unwrap();
        session.id
    }

    /// Marks `day` (a `date()` modifier such as `'-3 days'`) productive by
    /// backdating a completed task onto it.
    fn productive_on(conn: &Connection, modifier: &str) {
        let id = a_task(conn, &format!("Task for {modifier}"));
        complete_task(conn, id);
        conn.execute(
            "UPDATE tasks SET completed_at = datetime('now', ?2) WHERE id = ?1",
            params![id, modifier],
        )
        .unwrap();
    }

    // -- the level curve ---------------------------------------------------

    #[test]
    fn level_one_starts_empty_and_costs_the_first_step() {
        assert_eq!(
            level_for(0),
            LevelProgress {
                level: 1,
                xp_into_level: 0,
                xp_for_next_level: 200,
            }
        );
    }

    #[test]
    fn the_curve_reproduces_the_section_45_mockup() {
        // 200 + 400 + 600 = 1200 to reach level 4, then 620 into it.
        let progress = level_for(1200 + 620);
        assert_eq!(progress.level, 4);
        assert_eq!(progress.xp_into_level, 620);
        assert_eq!(progress.xp_for_next_level, 800);
    }

    #[test]
    fn each_level_costs_more_than_the_last() {
        let mut previous = 0;
        for level in 1..=10 {
            let at_level_start = level_for(100 * level * (level - 1));
            assert_eq!(at_level_start.level, level, "level {level} boundary");
            assert_eq!(at_level_start.xp_into_level, 0);
            assert!(at_level_start.xp_for_next_level > previous);
            previous = at_level_start.xp_for_next_level;
        }
    }

    #[test]
    fn the_curve_stops_at_the_maximum_level() {
        let far_past_the_end = level_for(i64::MAX / 2);
        assert_eq!(far_past_the_end.level, MAX_LEVEL);
        assert_eq!(
            far_past_the_end.xp_for_next_level, 0,
            "a maximum level has no bar to fill"
        );
    }

    // -- task completion ---------------------------------------------------

    #[test]
    fn completing_a_task_grants_xp_once() {
        let conn = conn();
        let id = a_task(&conn, "Finish React project");

        complete_task(&conn, id);
        assert_eq!(total_xp(&conn).unwrap(), TASK_COMPLETION_XP + ACHIEVEMENT_XP);

        // Un-complete and re-complete: the same work, so the same reward.
        tasks::update(
            &conn,
            id,
            serde_json::from_value(json!({ "status": "todo" })).unwrap(),
        )
        .unwrap();
        complete_task(&conn, id);

        assert_eq!(
            total_xp(&conn).unwrap(),
            TASK_COMPLETION_XP + ACHIEVEMENT_XP,
            "re-ticking a checkbox is not more work"
        );
        let ledger = list_transactions(&conn, None).unwrap();
        assert_eq!(
            ledger
                .iter()
                .filter(|row| row.source == XpSource::TaskCompletion)
                .count(),
            1
        );
    }

    #[test]
    fn every_task_is_paid_separately() {
        let conn = conn();
        for index in 0..3 {
            let id = a_task(&conn, &format!("Task {index}"));
            complete_task(&conn, id);
        }

        let awarded: i64 = list_transactions(&conn, None)
            .unwrap()
            .iter()
            .filter(|row| row.source == XpSource::TaskCompletion)
            .map(|row| row.amount)
            .sum();
        assert_eq!(awarded, 3 * TASK_COMPLETION_XP);
    }

    #[test]
    fn the_ledger_records_what_earned_each_grant() {
        let conn = conn();
        let id = a_task(&conn, "Write the report");
        complete_task(&conn, id);

        let row = list_transactions(&conn, None)
            .unwrap()
            .into_iter()
            .find(|row| row.source == XpSource::TaskCompletion)
            .expect("a task completion row");
        assert_eq!(row.source_id, Some(id), "section 63's auditable source_id");
        assert_eq!(row.amount, TASK_COMPLETION_XP);
    }

    // -- focus sessions ----------------------------------------------------

    #[test]
    fn a_completed_focus_session_grants_xp_once() {
        let conn = conn();
        let session = a_completed_session(&conn, 25 * 60);

        let focus_rows: Vec<_> = list_transactions(&conn, None)
            .unwrap()
            .into_iter()
            .filter(|row| row.source == XpSource::FocusSession)
            .collect();
        assert_eq!(focus_rows.len(), 1);
        assert_eq!(focus_rows[0].amount, FOCUS_SESSION_XP);
        assert_eq!(focus_rows[0].source_id, Some(session));

        // Ending it again is refused by the focus service, so nothing can
        // double-pay through that path; asking directly is refused here.
        let again = award_focus_session(&conn, session).unwrap();
        assert_eq!(again.granted, 0);
    }

    #[test]
    fn an_interrupted_session_grants_nothing() {
        let conn = conn();
        let session = focus::start(
            &conn,
            serde_json::from_value(json!({ "preset": "25-5" })).unwrap(),
        )
        .unwrap();
        focus::end(
            &conn,
            session.id,
            serde_json::from_value(json!({ "completed": false })).unwrap(),
        )
        .unwrap();

        assert_eq!(total_xp(&conn).unwrap(), 0);
    }

    #[test]
    fn a_session_too_short_to_be_focus_grants_nothing() {
        let conn = conn();
        // Started and stopped inside a minute: section 88's button-clicking.
        focus::end(
            &conn,
            focus::start(
                &conn,
                serde_json::from_value(json!({ "preset": "stopwatch" })).unwrap(),
            )
            .unwrap()
            .id,
            serde_json::from_value(json!({ "completed": true, "duration_seconds": 3 })).unwrap(),
        )
        .unwrap();

        assert_eq!(total_xp(&conn).unwrap(), 0);
    }

    // -- routine launches (section 88) -------------------------------------

    #[test]
    fn only_the_first_routine_launch_of_the_day_grants_xp() {
        let conn = conn();
        let morning = a_routine(&conn, "Morning");
        let evening = a_routine(&conn, "Evening");

        routines::prepare_launch(&conn, morning).unwrap();
        assert_eq!(total_xp(&conn).unwrap(), ROUTINE_LAUNCH_XP + ACHIEVEMENT_XP);

        routines::prepare_launch(&conn, morning).unwrap();
        routines::prepare_launch(&conn, evening).unwrap();
        assert_eq!(
            total_xp(&conn).unwrap(),
            ROUTINE_LAUNCH_XP + ACHIEVEMENT_XP,
            "section 88: launching again is not more XP, and neither is another routine"
        );

        let launches = list_transactions(&conn, None)
            .unwrap()
            .into_iter()
            .filter(|row| row.source == XpSource::RoutineLaunch)
            .count();
        assert_eq!(launches, 1);
    }

    #[test]
    fn a_new_day_grants_a_routine_launch_again() {
        let conn = conn();
        let id = a_routine(&conn, "Morning");
        routines::prepare_launch(&conn, id).unwrap();

        // Backdate yesterday's launch, then launch again today.
        conn.execute(
            "UPDATE xp_transactions
                SET created_at = datetime('now', '-1 day')
              WHERE source = 'routine_launch'",
            [],
        )
        .unwrap();

        routines::prepare_launch(&conn, id).unwrap();
        let launches = list_transactions(&conn, None)
            .unwrap()
            .into_iter()
            .filter(|row| row.source == XpSource::RoutineLaunch)
            .count();
        assert_eq!(launches, 2);
    }

    // -- streaks (section 46) ----------------------------------------------

    #[test]
    fn a_fresh_database_has_no_streak() {
        let conn = conn();
        let streak = streak(&conn).unwrap();
        assert_eq!(streak.current_streak, 0);
        assert_eq!(streak.longest_streak, 0);
        assert_eq!(streak.last_active_date, None);
    }

    #[test]
    fn consecutive_productive_days_make_a_streak() {
        let conn = conn();
        for days_ago in 0..4 {
            productive_on(&conn, &format!("-{days_ago} days"));
        }

        let streak = streak(&conn).unwrap();
        assert_eq!(streak.current_streak, 4);
        assert_eq!(streak.longest_streak, 4);
        assert!(streak.last_active_date.is_some());
    }

    #[test]
    fn a_missed_day_ends_the_current_streak_but_not_the_record() {
        let conn = conn();
        // A five-day run a fortnight ago, then two days ending today.
        for days_ago in 10..15 {
            productive_on(&conn, &format!("-{days_ago} days"));
        }
        productive_on(&conn, "-1 days");
        productive_on(&conn, "-0 days");

        let streak = streak(&conn).unwrap();
        assert_eq!(streak.current_streak, 2);
        assert_eq!(streak.longest_streak, 5);
    }

    #[test]
    fn a_streak_ending_yesterday_is_still_current() {
        let conn = conn();
        productive_on(&conn, "-2 days");
        productive_on(&conn, "-1 days");

        assert_eq!(
            streak(&conn).unwrap().current_streak,
            2,
            "today is not over yet"
        );
    }

    #[test]
    fn a_streak_ending_the_day_before_yesterday_is_over() {
        let conn = conn();
        productive_on(&conn, "-3 days");
        productive_on(&conn, "-2 days");

        let streak = streak(&conn).unwrap();
        assert_eq!(streak.current_streak, 0);
        assert_eq!(streak.longest_streak, 2);
    }

    #[test]
    fn all_three_of_section_46s_activities_count_a_day() {
        for setup in ["task", "focus", "routine"] {
            let conn = conn();
            match setup {
                "task" => complete_task(&conn, a_task(&conn, "Tidy the desk")),
                "focus" => {
                    a_completed_session(&conn, 25 * 60);
                }
                _ => {
                    let id = a_routine(&conn, "Morning");
                    routines::prepare_launch(&conn, id).unwrap();
                }
            }

            assert_eq!(
                streak(&conn).unwrap().current_streak,
                1,
                "{setup} should count today as productive"
            );
        }
    }

    #[test]
    fn the_longest_streak_survives_the_history_that_proved_it() {
        let conn = conn();
        for days_ago in 20..27 {
            productive_on(&conn, &format!("-{days_ago} days"));
        }
        assert_eq!(streak(&conn).unwrap().longest_streak, 7);

        conn.execute("DELETE FROM tasks", []).unwrap();
        assert_eq!(
            streak(&conn).unwrap().longest_streak,
            7,
            "a record stands even once the rows behind it are gone"
        );
    }

    // -- achievements (section 47) -----------------------------------------

    #[test]
    fn all_six_achievements_are_seeded_and_start_locked() {
        let conn = conn();
        let achievements = list_achievements(&conn).unwrap();
        let keys: Vec<&str> = achievements.iter().map(|a| a.key.as_str()).collect();
        assert_eq!(
            keys,
            vec![
                "first_task",
                "first_routine",
                "focused",
                "consistent",
                "organized",
                "deep_work"
            ]
        );
        assert!(achievements.iter().all(|a| a.unlocked_at.is_none()));
    }

    #[test]
    fn first_task_unlocks_on_the_first_completion_and_pays_once() {
        let conn = conn();
        complete_task(&conn, a_task(&conn, "Finish React project"));

        let unlocked: Vec<String> = list_achievements(&conn)
            .unwrap()
            .into_iter()
            .filter(|a| a.unlocked_at.is_some())
            .map(|a| a.key)
            .collect();
        assert_eq!(unlocked, vec!["first_task".to_string()]);

        complete_task(&conn, a_task(&conn, "Another one"));
        let achievement_grants = list_transactions(&conn, None)
            .unwrap()
            .into_iter()
            .filter(|row| row.source == XpSource::Achievement)
            .count();
        assert_eq!(achievement_grants, 1);
    }

    #[test]
    fn first_routine_unlocks_on_the_first_launch() {
        let conn = conn();
        routines::prepare_launch(&conn, a_routine(&conn, "Morning")).unwrap();

        assert!(achievement_by_key(&conn, "first_routine")
            .unwrap()
            .unwrap()
            .unlocked_at
            .is_some());
    }

    #[test]
    fn focused_needs_ten_completed_sessions() {
        let conn = conn();
        for _ in 0..9 {
            a_completed_session(&conn, 6 * 60);
        }
        assert!(achievement_by_key(&conn, "focused")
            .unwrap()
            .unwrap()
            .unlocked_at
            .is_none());

        a_completed_session(&conn, 6 * 60);
        assert!(achievement_by_key(&conn, "focused")
            .unwrap()
            .unwrap()
            .unlocked_at
            .is_some());
    }

    #[test]
    fn consistent_unlocks_on_the_seventh_day_of_a_streak() {
        let conn = conn();
        for days_ago in (1..7).rev() {
            productive_on(&conn, &format!("-{days_ago} days"));
        }
        evaluate(&conn).unwrap();
        assert!(achievement_by_key(&conn, "consistent")
            .unwrap()
            .unwrap()
            .unlocked_at
            .is_none());

        // The seventh day is a real completion, so it settles on its own.
        complete_task(&conn, a_task(&conn, "Day seven"));
        assert_eq!(streak(&conn).unwrap().current_streak, 7);
        assert!(
            achievement_by_key(&conn, "consistent")
                .unwrap()
                .unwrap()
                .unlocked_at
                .is_some(),
            "the completion that made it seven days is the one that unlocks it"
        );
    }

    #[test]
    fn deep_work_needs_ten_hours() {
        let conn = conn();
        for _ in 0..9 {
            a_completed_session(&conn, 60 * 60);
        }
        assert!(achievement_by_key(&conn, "deep_work")
            .unwrap()
            .unwrap()
            .unlocked_at
            .is_none());

        a_completed_session(&conn, 60 * 60);
        assert!(achievement_by_key(&conn, "deep_work")
            .unwrap()
            .unwrap()
            .unlocked_at
            .is_some());
    }

    #[test]
    fn an_unlock_grants_its_own_xp_and_is_reported_by_the_award() {
        let conn = conn();
        let id = a_task(&conn, "Finish React project");

        // The hook site inside `tasks::update` throws its `XpAward` away, so
        // this puts the row into the state that hook would have put it in and
        // then asks for the award directly. Doing it the other way round — a
        // bare `award_task_completion` on a task still marked `todo` — earns
        // the XP but unlocks nothing, because the achievement rules are
        // judged against the tables rather than against the ledger.
        conn.execute(
            "UPDATE tasks SET status = 'completed', completed_at = datetime('now') WHERE id = ?1",
            params![id],
        )
        .unwrap();

        let award = award_task_completion(&conn, id).unwrap();

        assert_eq!(award.granted, TASK_COMPLETION_XP);
        assert_eq!(award.unlocked.len(), 1);
        assert_eq!(award.unlocked[0].key, "first_task");
        assert_eq!(
            award.total_xp,
            TASK_COMPLETION_XP + ACHIEVEMENT_XP,
            "the unlock's XP is in the total but not in `granted`"
        );
    }

    // -- quests (sections 44, 62) ------------------------------------------

    fn today(conn: &Connection) -> String {
        conn.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))
            .unwrap()
    }

    fn yesterday(conn: &Connection) -> String {
        conn.query_row("SELECT date('now', 'localtime', '-1 day')", [], |row| {
            row.get(0)
        })
        .unwrap()
    }

    /// Today's quests. Which ones they are depends on the date the tests run
    /// on, so every quest test below works through whatever today offers
    /// rather than naming a quest that may not be on the list.
    fn todays_quests(conn: &Connection) -> Vec<&'static QuestDefinition> {
        quests::offered_on(conn, &today(conn)).unwrap()
    }

    /// Does the work a quest asks for, through the same services the app
    /// uses, so the quest is met the way a user would meet it.
    fn do_the_work(conn: &Connection, quest: &QuestDefinition) {
        do_work_for(conn, quest.id, quest.requirements);
    }

    fn do_work_for(conn: &Connection, label: &str, requirements: &[Requirement]) {
        for requirement in requirements {
            for unit in 0..requirement.target {
                match requirement.metric {
                    DailyMetric::TasksCompleted => {
                        complete_task(conn, a_task(conn, &format!("{label} {unit}")));
                    }
                    DailyMetric::FocusSessionsCompleted => {
                        a_completed_session(conn, requirement.min_session_seconds.max(60));
                    }
                    DailyMetric::FocusMinutes => {
                        // One session covers the whole target.
                        if unit == 0 {
                            a_completed_session(conn, requirement.target * 60);
                        }
                    }
                    DailyMetric::RoutinesLaunched => {
                        let id = a_routine(conn, &format!("{label} {unit}"));
                        routines::prepare_launch(conn, id).unwrap();
                    }
                    DailyMetric::DownloadsCleanups => cleaned_up(conn, "downloads"),
                    DailyMetric::DesktopCleanups => cleaned_up(conn, "desktop"),
                    DailyMetric::ScreenshotCleanups => cleaned_up(conn, "screenshots"),
                }
            }
        }
    }

    fn cleaned_up(conn: &Connection, utility: &str) {
        conn.execute(
            "INSERT INTO cleanup_actions (utility, action, item_count) VALUES (?1, 'move', 1)",
            params![utility],
        )
        .unwrap();
    }

    /// The ledger rows quests have written.
    fn quest_grants(conn: &Connection) -> Vec<XpTransaction> {
        list_transactions(conn, None)
            .unwrap()
            .into_iter()
            .filter(|row| {
                matches!(
                    row.source,
                    XpSource::DailyObjective | XpSource::MaintenanceQuest
                )
            })
            .collect()
    }

    fn refusal(outcome: ServiceResult<QuestCompletion>) -> String {
        match outcome {
            Err(ServiceError::Validation(message)) => message,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_quest_not_yet_met_is_refused() {
        let conn = conn();
        let today = today(&conn);

        for quest in todays_quests(&conn) {
            let message = refusal(complete_quest(&conn, quest.id, &today));
            assert!(
                message.starts_with(&format!("\"{}\" is not finished yet: 0 of ", quest.title)),
                "{}: {message}",
                quest.id
            );
        }

        assert_eq!(total_xp(&conn).unwrap(), 0);
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM quests", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0, "a refused quest leaves no row behind");
    }

    #[test]
    fn a_quest_is_refused_until_every_requirement_is_met() {
        let conn = conn();
        let today = today(&conn);

        for quest in todays_quests(&conn) {
            // Everything but the last unit of work on the last requirement.
            let (last, rest) = quest.requirements.split_last().unwrap();
            let mut almost: Vec<Requirement> = rest.to_vec();
            if last.target > 1 {
                almost.push(Requirement {
                    target: last.target - 1,
                    ..*last
                });
            }
            do_work_for(&conn, quest.id, &almost);

            let message = refusal(complete_quest(&conn, quest.id, &today));
            assert!(message.contains("is not finished yet"), "{}: {message}", quest.id);
        }
        assert!(quest_grants(&conn).is_empty());
    }

    #[test]
    fn a_met_quest_pays_its_bands_reward_once() {
        let conn = conn();
        let today = today(&conn);

        for quest in todays_quests(&conn) {
            do_the_work(&conn, quest);
            let before = total_xp(&conn).unwrap();

            let completion = complete_quest(&conn, quest.id, &today).unwrap();

            let reward = match quest.quest_type {
                QuestType::Objective => DAILY_OBJECTIVE_XP,
                QuestType::Maintenance => MAINTENANCE_QUEST_XP,
            };
            assert_eq!(completion.quest_id, quest.id);
            assert_eq!(completion.date_key, today);
            assert_eq!(completion.xp_awarded, reward);
            assert_eq!(total_xp(&conn).unwrap(), before + reward, "{}", quest.id);
        }

        assert_eq!(quest_grants(&conn).len(), todays_quests(&conn).len());
    }

    #[test]
    fn a_second_call_pays_nothing() {
        let conn = conn();
        let today = today(&conn);
        let quest = todays_quests(&conn)[0];
        do_the_work(&conn, quest);

        let first = complete_quest(&conn, quest.id, &today).unwrap();
        let before = total_xp(&conn).unwrap();

        // The caller re-counts the day on every load and keeps concluding
        // this quest is finished; it must not keep being paid for it.
        let second = complete_quest(&conn, quest.id, &today).unwrap();

        assert_eq!(second, first);
        assert_eq!(total_xp(&conn).unwrap(), before);
        assert_eq!(quest_grants(&conn).len(), 1);
    }

    #[test]
    fn a_paid_quest_still_answers_after_the_work_is_undone() {
        // Un-ticking the tasks after the quest paid does not turn the second
        // call into a refusal: the completion was real when it was recorded.
        let conn = conn();
        let today = today(&conn);
        let quest = todays_quests(&conn)[0];
        do_the_work(&conn, quest);
        let first = complete_quest(&conn, quest.id, &today).unwrap();

        conn.execute("UPDATE tasks SET status = 'todo', completed_at = NULL", [])
            .unwrap();
        conn.execute("DELETE FROM focus_sessions", []).unwrap();
        conn.execute("DELETE FROM routine_launches", []).unwrap();
        conn.execute("DELETE FROM cleanup_actions", []).unwrap();

        assert_eq!(complete_quest(&conn, quest.id, &today).unwrap(), first);
        assert_eq!(quest_grants(&conn).len(), 1);
    }

    #[test]
    fn a_quest_not_offered_today_is_refused_even_when_met() {
        let conn = conn();
        let today = today(&conn);
        let offered = todays_quests(&conn);
        let other = quests::pool()
            .find(|quest| !offered.iter().any(|today| today.id == quest.id))
            .expect("the pool is bigger than one day");
        do_the_work(&conn, other);

        let message = refusal(complete_quest(&conn, other.id, &today));
        assert_eq!(
            message,
            format!("\"{}\" is not one of today's objectives.", other.title)
        );
        assert!(quest_grants(&conn).is_empty());
    }

    #[test]
    fn an_unknown_quest_is_refused() {
        let conn = conn();
        let message = refusal(complete_quest(&conn, "free-xp", &today(&conn)));
        assert_eq!(message, "There is no objective called \"free-xp\".");
        assert_eq!(total_xp(&conn).unwrap(), 0);
    }

    #[test]
    fn completions_are_reported_for_the_day_they_belong_to() {
        let conn = conn();
        let today = today(&conn);
        let quest = todays_quests(&conn)[0];
        do_the_work(&conn, quest);
        complete_quest(&conn, quest.id, &today).unwrap();

        let recorded = list_quest_completions(&conn, &today).unwrap();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].quest_id, quest.id);
        assert_eq!(recorded[0].xp_awarded, quest.quest_type.xp_reward());

        assert!(list_quest_completions(&conn, &yesterday(&conn))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_same_quest_pays_again_on_a_later_day() {
        let conn = conn();
        let today = today(&conn);
        let quest = todays_quests(&conn)[0];
        do_the_work(&conn, quest);
        complete_quest(&conn, quest.id, &today).unwrap();

        // Backdate the record so today becomes a fresh day for the same
        // repeating quest — the pool offers it again next week.
        conn.execute(
            "UPDATE quests SET active_date = date(active_date, '-1 day')",
            [],
        )
        .unwrap();

        let again = complete_quest(&conn, quest.id, &today).unwrap();
        assert_eq!(again.xp_awarded, quest.quest_type.xp_reward());
        assert_eq!(quest_grants(&conn).len(), 2);
    }

    #[test]
    fn yesterdays_quest_cannot_be_completed_today() {
        let conn = conn();
        let refused = complete_quest(&conn, "routine-launch", &yesterday(&conn));
        assert!(matches!(refused, Err(ServiceError::Validation(_))));
        assert_eq!(total_xp(&conn).unwrap(), 0);
    }

    /// A cleanup action `days_ago` local days back, as the utilities'
    /// commands record one.
    fn cleaned_up_on(conn: &Connection, days_ago: i64) {
        conn.execute(
            "INSERT INTO cleanup_actions (utility, action, item_count, created_at)
             VALUES ('downloads', 'delete', 1, datetime('now', ?1))",
            params![format!("-{days_ago} days")],
        )
        .unwrap();
    }

    fn organized_unlocked(conn: &Connection) -> bool {
        achievement_by_key(conn, "organized")
            .unwrap()
            .unwrap()
            .unlocked_at
            .is_some()
    }

    #[test]
    fn organized_counts_days_with_a_cleanup_action() {
        let conn = conn();
        for days_ago in 1..10 {
            cleaned_up_on(&conn, days_ago);
        }
        evaluate(&conn).unwrap();
        assert!(!organized_unlocked(&conn), "nine days is not ten");

        cleaned_up_on(&conn, 0);
        evaluate(&conn).unwrap();
        assert!(organized_unlocked(&conn));
    }

    #[test]
    fn many_cleanup_actions_on_one_day_are_one_day() {
        // Ten deletes in one sitting are one day of cleanup, not the whole
        // achievement.
        let conn = conn();
        for _ in 0..12 {
            cleaned_up_on(&conn, 0);
        }
        evaluate(&conn).unwrap();

        assert!(!organized_unlocked(&conn));
        let organized = list_achievements(&conn)
            .unwrap()
            .into_iter()
            .find(|a| a.key == "organized")
            .unwrap();
        assert_eq!(
            organized.progress,
            Some(AchievementProgress {
                current: 1,
                target: ORGANIZED_DAYS
            })
        );
    }

    #[test]
    fn maintenance_quests_no_longer_count_towards_organized() {
        // "Complete a task" is a maintenance quest and has nothing to do with
        // cleanup. Ten of them used to unlock Organized. A day pays one, so
        // ten are written as ten days' worth of completions.
        let conn = conn();
        for days_ago in 0..10 {
            conn.execute(
                "INSERT INTO quests (key, type, title, xp_reward, active_date)
                 VALUES ('tasks-1', 'maintenance', 'Complete a task', ?1,
                         date('now', 'localtime', ?2))",
                params![MAINTENANCE_QUEST_XP, format!("-{days_ago} days")],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO quest_completions (quest_id, xp_awarded)
                 VALUES (last_insert_rowid(), ?1)",
                params![MAINTENANCE_QUEST_XP],
            )
            .unwrap();
        }
        evaluate(&conn).unwrap();

        assert!(!organized_unlocked(&conn));
    }

    #[test]
    fn organized_says_what_it_counts() {
        let conn = conn();
        let organized = achievement_by_key(&conn, "organized").unwrap().unwrap();
        assert_eq!(
            organized.description.as_deref(),
            Some("Clean up files on 10 different days.")
        );
    }

    #[test]
    fn a_quest_needs_an_id() {
        let conn = conn();
        assert_eq!(
            refusal(complete_quest(&conn, "  ", &today(&conn))),
            "A quest needs an id."
        );
    }

    #[test]
    fn a_quest_date_has_to_be_a_date() {
        let conn = conn();
        let refused = complete_quest(&conn, "tasks-3", "next Tuesday");
        assert!(matches!(refused, Err(ServiceError::Validation(_))));
    }

    // -- achievement progress ----------------------------------------------

    #[test]
    fn only_the_countable_achievements_carry_progress() {
        let conn = conn();
        a_completed_session(&conn, 30 * 60);

        let by_key: std::collections::HashMap<String, Option<AchievementProgress>> =
            list_achievements(&conn)
                .unwrap()
                .into_iter()
                .map(|a| (a.key, a.progress))
                .collect();

        // There is nothing useful to count towards "complete your first task".
        assert_eq!(by_key["first_task"], None);
        assert_eq!(by_key["first_routine"], None);

        assert_eq!(
            by_key["focused"],
            Some(AchievementProgress {
                current: 1,
                target: FOCUSED_SESSIONS
            })
        );
        assert_eq!(
            by_key["deep_work"],
            Some(AchievementProgress {
                current: 0,
                target: 10
            }),
            "half an hour is not a whole hour yet"
        );
    }

    #[test]
    fn progress_never_overshoots_its_target() {
        let conn = conn();
        for _ in 0..12 {
            a_completed_session(&conn, 6 * 60);
        }

        let focused = list_achievements(&conn)
            .unwrap()
            .into_iter()
            .find(|a| a.key == "focused")
            .unwrap();
        assert_eq!(
            focused.progress,
            Some(AchievementProgress {
                current: FOCUSED_SESSIONS,
                target: FOCUSED_SESSIONS
            })
        );
    }

    // -- the combined read -------------------------------------------------

    #[test]
    fn progress_reports_level_streak_and_total_together() {
        let conn = conn();
        complete_task(&conn, a_task(&conn, "Finish React project"));

        let progress = progress(&conn).unwrap();
        assert_eq!(progress.total_xp, TASK_COMPLETION_XP + ACHIEVEMENT_XP);
        assert_eq!(progress.level, level_for(progress.total_xp));
        assert_eq!(progress.streak.current_streak, 1);
    }
}
