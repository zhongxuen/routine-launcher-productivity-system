//! The day's objectives (development-plan.md sections 44, 52, 88): the pool
//! they are drawn from, which of them a date offers, and how far the user has
//! got with each, counted from the database.
//!
//! # Why this lives in Rust
//!
//! Section 88 asks that XP reward meaningful activity rather than button
//! clicking. A quest used to be judged finished by the frontend, which then
//! asked `xp::complete_quest` to pay for it; whatever sent that request was
//! believed. Now this module is the one definition of every quest and of what
//! finishing it means, and `complete_quest` asks it before paying. The
//! frontend reads the same definitions and the same counts through
//! [`daily_quests`], so the tick it draws and the payout Rust makes are
//! decided by the same code rather than by two copies that have to agree.
//!
//! # What it reads, and what it does not do
//!
//! Every count is read from the table that records the work itself, for one
//! local day:
//!
//! | Metric | Read from |
//! |---|---|
//! | Tasks completed | `tasks.completed_at` |
//! | Focus sessions completed | `focus_sessions`, `completed = 1`, at least a minimum length |
//! | Focused minutes | `focus_sessions.duration_seconds` of every ended session |
//! | Routines launched | distinct `routine_id` in `routine_launches` |
//! | Cleanup actions | `cleanup_actions`, per utility |
//!
//! Nothing here writes, and nothing here pays. The quest's reward band is
//! [`QuestType`]'s, which `xp` owns alongside the rest of section 43's table.
//! Cleanup is counted with its own query rather than through
//! `cleanup_actions::day`, because `cleanup_actions` calls into `xp` and `xp`
//! calls into this module, and the dependency should keep pointing one way.
//!
//! # Days
//!
//! A day is a local `YYYY-MM-DD`. Timestamps are stored as UTC, so each one is
//! converted with `'localtime'` before it is compared, the same conversion the
//! streak and the statistics use. A focus session belongs to the day it was
//! *started* on: one that runs past midnight belongs to the evening it began
//! in, which is how the user remembers it.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::services::error::ServiceResult;
use crate::services::settings::{self, MAX_QUEST_COUNT, MIN_QUEST_COUNT};
use crate::services::validate::validate_date;
use crate::services::xp::{QuestType, MIN_REWARDED_FOCUS_SECONDS};

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/// Something about a day that a quest can be measured against. The wire names
/// are the `DailyMetric` strings in `src/types/quest.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DailyMetric {
    /// Tasks whose `completed_at` falls on the day.
    TasksCompleted,
    /// Focus sessions started on the day that ran to their target and lasted
    /// at least the requirement's minimum length.
    FocusSessionsCompleted,
    /// Whole minutes recorded by every session started on the day, finished
    /// or not: an abandoned session's minutes were still focused.
    FocusMinutes,
    /// *Distinct* routines launched on the day. Launching the same routine ten
    /// times counts once, so no quest can be ground out by pressing START.
    RoutinesLaunched,
    /// Confirmed Downloads Cleanup actions on the day.
    DownloadsCleanups,
    /// Confirmed Desktop Cleanup actions on the day.
    DesktopCleanups,
    /// Confirmed Screenshot Organizer actions on the day.
    ScreenshotCleanups,
}

/// One condition a quest needs met. A quest's conditions combine with AND.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Requirement {
    pub metric: DailyMetric,
    /// How many are needed. Always at least 1.
    pub target: i64,
    /// The singular word for one unit as this quest counts it, so a progress
    /// line and a refusal can both say "2 of 3 tasks".
    pub noun: &'static str,
    /// For [`DailyMetric::FocusSessionsCompleted`] only: the shortest session
    /// that counts, in seconds.
    pub min_session_seconds: i64,
}

impl Requirement {
    const fn count(metric: DailyMetric, target: i64, noun: &'static str) -> Self {
        Self {
            metric,
            target,
            noun,
            min_session_seconds: 0,
        }
    }

    /// A completed focus session of at least `min_seconds`.
    const fn session(min_seconds: i64, noun: &'static str) -> Self {
        Self {
            metric: DailyMetric::FocusSessionsCompleted,
            target: 1,
            noun,
            min_session_seconds: min_seconds,
        }
    }
}

/// One quest in the pool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuestDefinition {
    /// Stable across days, so the same quest offered next week keeps its id
    /// and a completion is keyed by `(id, day)`. Stored as `quests.key`.
    pub id: &'static str,
    pub quest_type: QuestType,
    /// The checklist line, written the way section 44 writes it.
    pub title: &'static str,
    /// Everything that has to be true. Never empty.
    pub requirements: &'static [Requirement],
    /// The in-app route where the work is done, for the cleanup quests. A
    /// link and nothing more (section 67).
    pub href: Option<&'static str>,
}

/// "Complete a 25-minute focus session" means twenty-five minutes. A shorter
/// completed session, a Custom 10 or a stopwatch stopped early, does not
/// finish it.
const FOCUS_QUEST_SESSION_SECONDS: i64 = 25 * 60;

/// The three tracks, each holding the alternatives for one slot in the day.
///
/// Two per track, easy and harder, so a quiet day and a heavy one both have a
/// winnable version of the list, and the user has seen all six within a week.
/// Changing a quest's id or its position changes which quests existing users
/// are offered on which day, so treat the order as part of the data.
const QUEST_TRACKS: [&[QuestDefinition]; 3] = [
    // Tasks, the productivity system's own unit of work.
    &[
        QuestDefinition {
            id: "tasks-3",
            quest_type: QuestType::Objective,
            title: "Complete 3 tasks",
            requirements: &[Requirement::count(DailyMetric::TasksCompleted, 3, "task")],
            href: None,
        },
        QuestDefinition {
            id: "tasks-1",
            quest_type: QuestType::Maintenance,
            title: "Complete a task",
            requirements: &[Requirement::count(DailyMetric::TasksCompleted, 1, "task")],
            href: None,
        },
    ],
    // Focus. Section 44's own worked example is the first of these.
    &[
        QuestDefinition {
            id: "focus-session",
            quest_type: QuestType::Maintenance,
            title: "Complete a 25-minute focus session",
            requirements: &[Requirement::session(
                FOCUS_QUEST_SESSION_SECONDS,
                "25-minute session",
            )],
            href: None,
        },
        QuestDefinition {
            id: "focus-50-minutes",
            quest_type: QuestType::Objective,
            title: "Focus for 50 minutes",
            requirements: &[Requirement::count(DailyMetric::FocusMinutes, 50, "minute")],
            href: None,
        },
    ],
    // Routines. The harder half is a pair of conditions rather than "launch 2
    // routines" because a quest that counts launches pays for pressing START
    // twice. Section 88 names this exact combination as the fix: "routine
    // launch + completed focus session". The session has to be long enough to
    // earn XP on its own, so a stopwatch started and stopped does not count.
    &[
        QuestDefinition {
            id: "routine-launch",
            quest_type: QuestType::Maintenance,
            title: "Launch a routine",
            requirements: &[Requirement::count(DailyMetric::RoutinesLaunched, 1, "routine")],
            href: None,
        },
        QuestDefinition {
            id: "routine-then-focus",
            quest_type: QuestType::Objective,
            title: "Launch a routine, then finish a focus session",
            requirements: &[
                Requirement::count(DailyMetric::RoutinesLaunched, 1, "routine"),
                Requirement::session(MIN_REWARDED_FOCUS_SECONDS, "focus session"),
            ],
            href: None,
        },
    ],
];

/// Section 44's "Organize Downloads" and its two siblings, one per cleanup
/// utility whose folder has an obvious name. Each is done by one confirmed
/// action in its own utility that day, of any size: a quest that paid by the
/// file would reward deleting more than the user meant to.
const CLEANUP_TRACK: [QuestDefinition; 3] = [
    QuestDefinition {
        id: "cleanup-downloads",
        quest_type: QuestType::Maintenance,
        title: "Organize Downloads",
        requirements: &[Requirement::count(DailyMetric::DownloadsCleanups, 1, "cleanup")],
        href: Some("/cleanup/downloads"),
    },
    QuestDefinition {
        id: "cleanup-desktop",
        quest_type: QuestType::Maintenance,
        title: "Tidy your Desktop",
        requirements: &[Requirement::count(DailyMetric::DesktopCleanups, 1, "cleanup")],
        href: Some("/cleanup/desktop"),
    },
    QuestDefinition {
        id: "cleanup-screenshots",
        quest_type: QuestType::Maintenance,
        title: "File your screenshots",
        requirements: &[Requirement::count(DailyMetric::ScreenshotCleanups, 1, "cleanup")],
        href: Some("/cleanup/screenshots"),
    },
];

/// A cleanup quest appears on every day whose number is a multiple of this,
/// two or three days a week. Every day would make a chore a daily obligation;
/// once a week would bring each folder round less than once a fortnight. Not
/// a multiple of the tracks' two-day rotation, so a cleanup day does not
/// always land on the same task and focus quests.
const CLEANUP_EVERY_DAYS: i64 = 3;

/// Every quest that can ever be offered.
pub fn pool() -> impl Iterator<Item = &'static QuestDefinition> {
    QUEST_TRACKS
        .iter()
        .flat_map(|track| track.iter())
        .chain(CLEANUP_TRACK.iter())
}

/// The pool entry with this id, offered today or not.
pub fn find(id: &str) -> Option<&'static QuestDefinition> {
    pool().find(|quest| quest.id == id)
}

// ---------------------------------------------------------------------------
// Picking the day's quests
// ---------------------------------------------------------------------------

/// A `YYYY-MM-DD` key as days since 1970-01-01, for rotating the pool.
///
/// Calendar arithmetic with no timezone in it, because a calendar day has
/// none (Howard Hinnant's `days_from_civil`). A day past the end of its month
/// rolls into the next, as `Date.UTC` does, which is what the frontend's
/// generator used before this one replaced it. Returns `None` for anything
/// that is not shaped like a date.
fn day_number(date_key: &str) -> Option<i64> {
    let mut parts = date_key.splitn(3, '-').map(str::parse::<i64>);
    let (Some(Ok(year)), Some(Ok(month)), Some(Ok(day))) = (parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    if !(1..=12).contains(&month) {
        return None;
    }

    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_from_march = (month + 9) % 12;
    let day_of_year = (153 * month_from_march + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

/// The quests for one local day: `count` of them, held to section 44's 2-3.
///
/// A pure function of the date, so every window agrees about the day without
/// a table having to, and the list cannot change under the user mid-morning.
/// One quest from each of the first `count` tracks, chosen by the day's
/// number offset by the track's index, so the tracks do not all flip on the
/// same night. A two-quest day drops the routines track.
///
/// On a cleanup day the cleanup quest replaces the last line rather than
/// joining the list, so the count stays at 2 or 3 and a user on two quests
/// still sees cleanup quests. A two-quest day and a three-quest day on the
/// same date agree on every line they share.
pub fn quests_for_day(date_key: &str, count: i64) -> Vec<&'static QuestDefinition> {
    let Some(day) = day_number(date_key) else {
        return Vec::new();
    };
    let count = count.clamp(MIN_QUEST_COUNT, MAX_QUEST_COUNT) as usize;

    let mut quests: Vec<&'static QuestDefinition> = QUEST_TRACKS
        .iter()
        .take(count)
        .enumerate()
        .map(|(index, track)| {
            let slot = (day + index as i64).rem_euclid(track.len() as i64);
            &track[slot as usize]
        })
        .collect();

    if day.rem_euclid(CLEANUP_EVERY_DAYS) == 0 {
        let turn = day.div_euclid(CLEANUP_EVERY_DAYS);
        let cleanup = &CLEANUP_TRACK[turn.rem_euclid(CLEANUP_TRACK.len() as i64) as usize];
        if let Some(last) = quests.last_mut() {
            *last = cleanup;
        }
    }

    quests
}

/// The quests the user is offered on `date_key`, at the daily quest count
/// Settings holds now (section 52).
pub fn offered_on(conn: &Connection, date_key: &str) -> ServiceResult<Vec<&'static QuestDefinition>> {
    let count = settings::daily_settings(conn)?.daily_quest_count;
    Ok(quests_for_day(date_key, count))
}

// ---------------------------------------------------------------------------
// Measuring them
// ---------------------------------------------------------------------------

/// One requirement with the day's count put through it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequirementProgress {
    pub metric: DailyMetric,
    pub target: i64,
    pub noun: &'static str,
    /// The day's count, uncapped. The frontend caps it for drawing.
    pub current: i64,
}

impl RequirementProgress {
    pub fn is_met(&self) -> bool {
        self.current >= self.target
    }
}

/// A quest with the day's counts, as `get_daily_quests` sends it and as
/// `xp::complete_quest` judges it. The frontend's `Quest` type in
/// `src/types/quest.ts` mirrors this field for field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyQuest {
    pub id: &'static str,
    #[serde(rename = "type")]
    pub quest_type: QuestType,
    pub title: &'static str,
    /// What finishing it pays: the band's reward, [`QuestType::xp_reward`].
    pub xp_reward: i64,
    pub requirements: Vec<RequirementProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<&'static str>,
}

impl DailyQuest {
    /// The first requirement still outstanding, or `None` when the quest is
    /// finished: every requirement met.
    pub fn shortfall(&self) -> Option<&RequirementProgress> {
        self.requirements.iter().find(|step| !step.is_met())
    }
}

/// Puts one local day's counts through a quest.
pub fn measure(
    conn: &Connection,
    quest: &'static QuestDefinition,
    date_key: &str,
) -> ServiceResult<DailyQuest> {
    let requirements = quest
        .requirements
        .iter()
        .map(|requirement| {
            Ok(RequirementProgress {
                metric: requirement.metric,
                target: requirement.target,
                noun: requirement.noun,
                current: count(conn, requirement, date_key)?,
            })
        })
        .collect::<ServiceResult<Vec<_>>>()?;

    Ok(DailyQuest {
        id: quest.id,
        quest_type: quest.quest_type,
        title: quest.title,
        xp_reward: quest.quest_type.xp_reward(),
        requirements,
        href: quest.href,
    })
}

/// The day's quests with the day's counts. What the checklist draws.
pub fn daily_quests(conn: &Connection, date_key: &str) -> ServiceResult<Vec<DailyQuest>> {
    let date_key = validate_date("Quest date", date_key)?;
    offered_on(conn, &date_key)?
        .into_iter()
        .map(|quest| measure(conn, quest, &date_key))
        .collect()
}

/// How much of one requirement's metric the day holds.
fn count(conn: &Connection, requirement: &Requirement, date_key: &str) -> ServiceResult<i64> {
    let cleanups = |utility: &str| -> ServiceResult<i64> {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM cleanup_actions
              WHERE utility = ?2 AND DATE(created_at, 'localtime') = ?1",
            params![date_key, utility],
            |row| row.get(0),
        )?)
    };

    let value = match requirement.metric {
        DailyMetric::TasksCompleted => conn.query_row(
            "SELECT COUNT(*) FROM tasks
              WHERE status = 'completed'
                AND completed_at IS NOT NULL
                AND DATE(completed_at, 'localtime') = ?1",
            params![date_key],
            |row| row.get(0),
        )?,
        DailyMetric::FocusSessionsCompleted => conn.query_row(
            "SELECT COUNT(*) FROM focus_sessions
              WHERE completed = 1
                AND ended_at IS NOT NULL
                AND COALESCE(duration_seconds, 0) >= ?2
                AND DATE(started_at, 'localtime') = ?1",
            params![date_key, requirement.min_session_seconds],
            |row| row.get(0),
        )?,
        DailyMetric::FocusMinutes => conn.query_row(
            "SELECT COALESCE(SUM(MAX(0, COALESCE(duration_seconds, 0))), 0) / 60
               FROM focus_sessions
              WHERE ended_at IS NOT NULL
                AND DATE(started_at, 'localtime') = ?1",
            params![date_key],
            |row| row.get(0),
        )?,
        DailyMetric::RoutinesLaunched => conn.query_row(
            "SELECT COUNT(DISTINCT routine_id) FROM routine_launches
              WHERE DATE(launched_at, 'localtime') = ?1",
            params![date_key],
            |row| row.get(0),
        )?,
        DailyMetric::DownloadsCleanups => cleanups("downloads")?,
        DailyMetric::DesktopCleanups => cleanups("desktop")?,
        DailyMetric::ScreenshotCleanups => cleanups("screenshots")?,
    };
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;
    use crate::services::{focus, routines, tasks};
    use serde_json::json;

    fn conn() -> Connection {
        init_memory_db().expect("in-memory database")
    }

    fn today(conn: &Connection) -> String {
        conn.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))
            .unwrap()
    }

    fn ids(quests: &[&QuestDefinition]) -> Vec<&'static str> {
        quests.iter().map(|quest| quest.id).collect()
    }

    fn current(conn: &Connection, id: &str) -> Vec<i64> {
        measure(conn, find(id).unwrap(), &today(conn))
            .unwrap()
            .requirements
            .iter()
            .map(|step| step.current)
            .collect()
    }

    /// A session of `seconds`, counted for today.
    ///
    /// `started_at` is backdated so the length survives `focus::end`'s clamp
    /// to the wall clock, then moved to now once the length is recorded: in
    /// the first hour after midnight a backdated start would otherwise fall
    /// on yesterday, which is the day a session belongs to.
    fn a_session(conn: &Connection, seconds: i64, completed: bool) {
        let session = focus::start(
            conn,
            serde_json::from_value(json!({ "preset": "stopwatch" })).unwrap(),
        )
        .unwrap();
        conn.execute(
            "UPDATE focus_sessions SET started_at = datetime('now', ?2) WHERE id = ?1",
            params![session.id, format!("-{} seconds", seconds + 5)],
        )
        .unwrap();
        focus::end(
            conn,
            session.id,
            serde_json::from_value(json!({ "completed": completed, "duration_seconds": seconds }))
                .unwrap(),
        )
        .unwrap();
        conn.execute(
            "UPDATE focus_sessions SET started_at = datetime('now') WHERE id = ?1",
            params![session.id],
        )
        .unwrap();
    }

    // -- the generator -----------------------------------------------------

    #[test]
    fn day_numbers_count_from_the_epoch() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("1970-01-02"), Some(1));
        assert_eq!(day_number("2000-03-01"), Some(11_017));
        assert_eq!(day_number("2024-02-29"), Some(19_782));
        // Rolls over the way `Date.UTC` does.
        assert_eq!(day_number("2026-02-31"), day_number("2026-03-03"));
        assert_eq!(day_number("next Tuesday"), None);
        assert_eq!(day_number("2026-13-01"), None);
    }

    #[test]
    fn the_rust_generator_offers_what_the_frontend_one_did() {
        // Captured from `dailyQuests` in `src/lib/quests.ts` before it moved
        // here, so nobody's list changes on the day they upgrade.
        let expected = [
            ("2026-09-16", "tasks-3,focus-50-minutes,cleanup-desktop"),
            ("2026-09-17", "tasks-1,focus-session,routine-then-focus"),
            ("2026-09-18", "tasks-3,focus-50-minutes,routine-launch"),
            ("2026-09-19", "tasks-1,focus-session,cleanup-screenshots"),
            ("2026-01-01", "tasks-3,focus-50-minutes,cleanup-screenshots"),
            ("2025-12-31", "tasks-1,focus-session,routine-then-focus"),
            ("2024-02-29", "tasks-3,focus-50-minutes,cleanup-downloads"),
            ("2000-03-01", "tasks-1,focus-session,routine-then-focus"),
            ("1999-12-31", "tasks-3,focus-50-minutes,cleanup-desktop"),
        ];
        for (date, three) in expected {
            assert_eq!(ids(&quests_for_day(date, 3)).join(","), three, "{date}");
        }

        let two = [
            ("2026-09-16", "tasks-3,cleanup-desktop"),
            ("2026-09-17", "tasks-1,focus-session"),
            ("2026-09-18", "tasks-3,focus-50-minutes"),
        ];
        for (date, expected) in two {
            assert_eq!(ids(&quests_for_day(date, 2)).join(","), expected, "{date}");
        }
    }

    #[test]
    fn the_count_is_held_to_two_or_three() {
        assert_eq!(quests_for_day("2026-09-17", 0).len(), 2);
        assert_eq!(quests_for_day("2026-09-17", 9).len(), 3);
        assert!(quests_for_day("not a date", 3).is_empty());
    }

    #[test]
    fn the_settings_quest_count_decides_how_many_are_offered() {
        let conn = conn();
        let today = today(&conn);
        assert_eq!(offered_on(&conn, &today).unwrap().len(), 3);

        let mut daily = settings::daily_settings(&conn).unwrap();
        daily.daily_quest_count = 2;
        settings::set_daily_settings(&conn, daily).unwrap();
        assert_eq!(offered_on(&conn, &today).unwrap().len(), 2);
    }

    #[test]
    fn every_quest_in_the_pool_has_a_unique_id_and_a_requirement() {
        let all: Vec<_> = pool().collect();
        assert_eq!(all.len(), 9);
        for quest in &all {
            assert!(!quest.requirements.is_empty(), "{}", quest.id);
            assert!(quest.requirements.iter().all(|step| step.target >= 1));
            assert_eq!(all.iter().filter(|other| other.id == quest.id).count(), 1);
        }
    }

    // -- measuring ---------------------------------------------------------

    #[test]
    fn tasks_are_counted_for_the_day_they_were_completed() {
        let conn = conn();
        for title in ["One", "Two"] {
            let id = tasks::create(&conn, serde_json::from_value(json!({ "title": title })).unwrap())
                .unwrap()
                .id;
            tasks::update(
                &conn,
                id,
                serde_json::from_value(json!({ "status": "completed" })).unwrap(),
            )
            .unwrap();
        }
        // Yesterday's completion is not today's.
        conn.execute(
            "UPDATE tasks SET completed_at = datetime('now', '-1 day') WHERE title = 'Two'",
            [],
        )
        .unwrap();

        assert_eq!(current(&conn, "tasks-3"), vec![1]);
    }

    #[test]
    fn a_focus_session_counts_only_if_it_finished_and_was_long_enough() {
        let conn = conn();
        a_session(&conn, 10 * 60, true);
        a_session(&conn, 40 * 60, false);
        assert_eq!(
            current(&conn, "focus-session"),
            vec![0],
            "ten finished minutes are not a 25-minute session, and an abandoned one is not finished"
        );

        a_session(&conn, 25 * 60, true);
        assert_eq!(current(&conn, "focus-session"), vec![1]);
    }

    #[test]
    fn focused_minutes_include_sessions_that_were_cut_short() {
        let conn = conn();
        a_session(&conn, 30 * 60, true);
        a_session(&conn, 20 * 60 + 59, false);
        assert_eq!(current(&conn, "focus-50-minutes"), vec![50]);
    }

    #[test]
    fn routines_are_counted_from_the_launch_log_once_each() {
        let conn = conn();
        let morning = routines::create(
            &conn,
            serde_json::from_value(json!({ "name": "Morning", "actions": [] })).unwrap(),
        )
        .unwrap()
        .id;
        for _ in 0..3 {
            routines::prepare_launch(&conn, morning).unwrap();
        }
        assert_eq!(current(&conn, "routine-launch"), vec![1]);

        // A stopwatch stopped after a minute does not make the pair.
        a_session(&conn, 60, true);
        assert_eq!(current(&conn, "routine-then-focus"), vec![1, 0]);
        a_session(&conn, 6 * 60, true);
        assert_eq!(current(&conn, "routine-then-focus"), vec![1, 1]);
    }

    #[test]
    fn a_cleanup_quest_counts_only_its_own_utility() {
        let conn = conn();
        conn.execute(
            "INSERT INTO cleanup_actions (utility, action, item_count) VALUES ('desktop', 'move', 3)",
            [],
        )
        .unwrap();

        assert_eq!(current(&conn, "cleanup-desktop"), vec![1]);
        assert_eq!(current(&conn, "cleanup-downloads"), vec![0]);
        assert_eq!(current(&conn, "cleanup-screenshots"), vec![0]);
    }

    #[test]
    fn a_quest_reports_what_is_still_outstanding() {
        let conn = conn();
        let quest = measure(&conn, find("tasks-3").unwrap(), &today(&conn)).unwrap();
        assert_eq!(quest.shortfall().map(|step| step.target), Some(3));
        assert_eq!(quest.xp_reward, QuestType::Objective.xp_reward());
    }
}
