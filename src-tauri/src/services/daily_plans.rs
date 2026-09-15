//! A day's top priorities: the stored half of development-plan.md sections 20
//! and 51's PLAN TODAY.
//!
//! ```text
//! PLAN TODAY
//!
//! Top priorities:
//! 1. Finish project report
//! 2. Complete database implementation
//! 3. Study JavaScript
//! ```
//!
//! Only the priorities are kept. Everything else the panel shows is worked
//! out when it is drawn: the other tasks are the rest of the Today view, the
//! workload is a sum over their estimates, and the time left comes from the
//! clock and the Daily Settings. None of those is a choice the user made, so
//! none of them is stored.
//!
//! A plan is written whole. The panel moves a task up, takes one out or adds
//! one, and each of those sends the full ordered list back. The rank is the
//! position in that list, so the wire cannot carry two tasks at one rank or a
//! gap between ranks, and the one rank rule left to check is the cap of three.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::error::{ServiceError, ServiceResult};
use super::validate::validate_date;

/// Section 51's mockup numbers three, and section 20's asks for "a quick
/// overview", which a longer list stops being. The table's CHECK holds the
/// same line.
pub const MAX_PRIORITIES: usize = 3;

const DATE: &str = "Plan date";

/// One day's top priorities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyPlan {
    /// The local `YYYY-MM-DD` the priorities are for.
    pub date: String,
    /// Task ids, rank 1 first. At most [`MAX_PRIORITIES`]; empty for a day
    /// nothing has been picked for.
    pub task_ids: Vec<i64>,
}

/// The priorities picked for `date`, rank 1 first.
///
/// A deleted task has already gone, taken out by the table's cascade. A task
/// that has been moved to another day since it was picked is still here: the
/// panel only shows the ones on today's list, and its next save leaves the
/// rest out.
pub fn get(conn: &Connection, date: &str) -> ServiceResult<DailyPlan> {
    let date = validate_date(DATE, date)?;

    let mut statement =
        conn.prepare("SELECT task_id FROM daily_plans WHERE date = ?1 ORDER BY rank")?;
    let task_ids = statement
        .query_map(params![date], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?;

    Ok(DailyPlan { date, task_ids })
}

/// Replaces `date`'s priorities with `task_ids`, in order, and answers with
/// what was stored. An empty list clears the day.
///
/// Every check runs before anything is written, so a refused plan leaves the
/// day's existing one as it was.
pub fn set(conn: &Connection, date: &str, task_ids: Vec<i64>) -> ServiceResult<DailyPlan> {
    let date = validate_date(DATE, date)?;

    for (index, id) in task_ids.iter().enumerate() {
        let rank = rank_at(index);
        if !(1..=MAX_PRIORITIES as i64).contains(&rank) {
            return Err(ServiceError::validation(format!(
                "A day has at most {MAX_PRIORITIES} top priorities."
            )));
        }
        if task_ids[..index].contains(id) {
            return Err(ServiceError::validation(format!(
                "Task {id} is already one of this day's top priorities."
            )));
        }
        if !task_exists(conn, *id)? {
            return Err(ServiceError::not_found(format!(
                "Task {id} was not found, so it cannot be a top priority."
            )));
        }
    }

    let transaction = conn.unchecked_transaction()?;
    transaction.execute("DELETE FROM daily_plans WHERE date = ?1", params![date])?;
    for (index, id) in task_ids.iter().enumerate() {
        transaction.execute(
            "INSERT INTO daily_plans (date, task_id, rank) VALUES (?1, ?2, ?3)",
            params![date, id, rank_at(index)],
        )?;
    }
    transaction.commit()?;

    get(conn, &date)
}

/// The rank of the task at `index` in a plan's list: 1 for the first.
fn rank_at(index: usize) -> i64 {
    index as i64 + 1
}

fn task_exists(conn: &Connection, id: i64) -> ServiceResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM tasks WHERE id = ?1)",
        params![id],
        |row| row.get(0),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    const MONDAY: &str = "2026-09-14";
    const TUESDAY: &str = "2026-09-15";

    /// A task, returning its id.
    fn a_task(conn: &Connection, title: &str) -> i64 {
        conn.execute("INSERT INTO tasks (title) VALUES (?1)", params![title])
            .unwrap();
        conn.last_insert_rowid()
    }

    fn priorities(conn: &Connection, date: &str) -> Vec<i64> {
        get(conn, date).unwrap().task_ids
    }

    #[test]
    fn a_day_nothing_was_picked_for_has_no_priorities() {
        let conn = init_memory_db().unwrap();
        let plan = get(&conn, TUESDAY).unwrap();
        assert_eq!(plan.date, TUESDAY);
        assert!(plan.task_ids.is_empty());
    }

    #[test]
    fn priorities_come_back_in_the_order_they_were_picked() {
        let conn = init_memory_db().unwrap();
        let report = a_task(&conn, "Finish project report");
        let database = a_task(&conn, "Complete database implementation");
        let study = a_task(&conn, "Study JavaScript");

        // Not id order, so an ORDER BY task_id would fail this.
        let stored = set(&conn, TUESDAY, vec![study, report, database]).unwrap();
        assert_eq!(stored.task_ids, vec![study, report, database]);
        assert_eq!(priorities(&conn, TUESDAY), vec![study, report, database]);

        let ranks: Vec<(i64, i64)> = conn
            .prepare("SELECT task_id, rank FROM daily_plans ORDER BY rank")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(ranks, vec![(study, 1), (report, 2), (database, 3)]);
    }

    #[test]
    fn saving_replaces_the_day_rather_than_adding_to_it() {
        let conn = init_memory_db().unwrap();
        let first = a_task(&conn, "First");
        let second = a_task(&conn, "Second");
        let third = a_task(&conn, "Third");

        set(&conn, TUESDAY, vec![first, second, third]).unwrap();
        // Moving #3 to the top renumbers the other two.
        set(&conn, TUESDAY, vec![third, first, second]).unwrap();
        assert_eq!(priorities(&conn, TUESDAY), vec![third, first, second]);

        set(&conn, TUESDAY, vec![second]).unwrap();
        assert_eq!(priorities(&conn, TUESDAY), vec![second]);

        set(&conn, TUESDAY, Vec::new()).unwrap();
        assert!(priorities(&conn, TUESDAY).is_empty(), "an empty list clears the day");
    }

    #[test]
    fn each_day_has_its_own_priorities() {
        let conn = init_memory_db().unwrap();
        let carried = a_task(&conn, "Carried over from Monday");
        let fresh = a_task(&conn, "Due Tuesday");

        set(&conn, MONDAY, vec![carried]).unwrap();
        // The same task can be #2 on the next day without Monday changing.
        set(&conn, TUESDAY, vec![fresh, carried]).unwrap();

        assert_eq!(priorities(&conn, MONDAY), vec![carried]);
        assert_eq!(priorities(&conn, TUESDAY), vec![fresh, carried]);

        set(&conn, TUESDAY, Vec::new()).unwrap();
        assert_eq!(priorities(&conn, MONDAY), vec![carried], "clearing a day clears only it");
    }

    #[test]
    fn a_fourth_priority_is_refused_and_nothing_is_written() {
        let conn = init_memory_db().unwrap();
        let ids: Vec<i64> = (1..=4).map(|n| a_task(&conn, &format!("Task {n}"))).collect();
        set(&conn, TUESDAY, vec![ids[0]]).unwrap();

        let error = set(&conn, TUESDAY, ids.clone()).unwrap_err();
        assert!(error.to_string().contains("at most 3"), "{error}");
        assert_eq!(priorities(&conn, TUESDAY), vec![ids[0]], "the old plan stands");
    }

    #[test]
    fn a_task_cannot_hold_two_ranks() {
        let conn = init_memory_db().unwrap();
        let task = a_task(&conn, "Only once");

        let error = set(&conn, TUESDAY, vec![task, task]).unwrap_err();
        assert!(error.to_string().contains("already one of"), "{error}");
        assert!(priorities(&conn, TUESDAY).is_empty());
    }

    #[test]
    fn a_task_that_does_not_exist_is_refused_and_nothing_is_written() {
        let conn = init_memory_db().unwrap();
        let real = a_task(&conn, "Real");
        set(&conn, TUESDAY, vec![real]).unwrap();

        // The missing one is last, so a write that ran row by row would
        // already have replaced the day by the time it failed.
        let error = set(&conn, TUESDAY, vec![real, 4_242]).unwrap_err();
        assert!(matches!(error, ServiceError::NotFound(_)), "{error}");
        assert!(error.to_string().contains("4242"), "it names the task: {error}");
        assert_eq!(priorities(&conn, TUESDAY), vec![real]);
    }

    #[test]
    fn the_date_must_be_yyyy_mm_dd() {
        let conn = init_memory_db().unwrap();
        let task = a_task(&conn, "Task");

        for bad in ["", "today", "2026-9-15", "15/09/2026", "2026-13-01"] {
            let error = set(&conn, bad, vec![task]).unwrap_err();
            assert!(error.to_string().contains("Plan date"), "{bad:?}: {error}");
            assert!(get(&conn, bad).is_err(), "{bad:?} should be refused on read too");
        }
    }

    #[test]
    fn deleting_a_task_takes_it_out_of_every_plan() {
        let conn = init_memory_db().unwrap();
        let first = a_task(&conn, "First");
        let second = a_task(&conn, "Second");
        set(&conn, MONDAY, vec![first]).unwrap();
        set(&conn, TUESDAY, vec![first, second]).unwrap();

        conn.execute("DELETE FROM tasks WHERE id = ?1", params![first])
            .unwrap();

        assert!(priorities(&conn, MONDAY).is_empty());
        assert_eq!(
            priorities(&conn, TUESDAY),
            vec![second],
            "what was #2 is now the first priority listed"
        );
        // And the day saves again as it now reads.
        set(&conn, TUESDAY, priorities(&conn, TUESDAY)).unwrap();
    }

    #[test]
    fn the_table_refuses_what_the_service_refuses() {
        // The CHECK and UNIQUE behind the checks above, for any writer that
        // is not this module: a backup edited by hand, for one.
        let conn = init_memory_db().unwrap();
        let first = a_task(&conn, "First");
        let second = a_task(&conn, "Second");

        let insert = |task: i64, rank: i64| {
            conn.execute(
                "INSERT INTO daily_plans (date, task_id, rank) VALUES (?1, ?2, ?3)",
                params![TUESDAY, task, rank],
            )
        };

        assert!(insert(first, 0).is_err(), "rank 0");
        assert!(insert(first, 4).is_err(), "rank 4");
        insert(first, 1).unwrap();
        assert!(insert(second, 1).is_err(), "two tasks at one rank");
        assert!(insert(first, 2).is_err(), "one task at two ranks");
        assert!(insert(9_999, 2).is_err(), "a task that does not exist");
    }
}
