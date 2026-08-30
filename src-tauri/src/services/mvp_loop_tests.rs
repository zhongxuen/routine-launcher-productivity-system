//! The whole of development-plan.md section 94, run once, in order.
//!
//! ```text
//! Create a task -> Assign it to a routine -> Click "Start Task"
//!   -> Applications and folders launch -> Focus timer starts
//!   -> User works -> Task is completed -> Daily progress updates
//! ```
//!
//! Every other test in this crate checks one service. This one checks that
//! the eight of them still add up to the product, because that is the thing
//! section 94 says the MVP either does or does not do — and it is exactly the
//! sort of thing that keeps working per-service and stops working end to end:
//! a launch that no longer dates itself, a completion that no longer pays XP,
//! a day whose figures do not move.
//!
//! It is a *backend* run of the loop. The click and the clock belong to the
//! webview, so what stands in for them is the same call the webview makes —
//! `routines::prepare_launch` + `routine_exec::run` for START TASK, and
//! `focus::start` / `focus::end` for the timer.
//!
//! The application and the folder are real and really open, because "the
//! routine launched it" is not worth asserting about a stub. The application
//! is a one-line `.cmd` the test writes and deletes: it is a real process,
//! started down the real `cmd /C` branch of the executor, and it exits on its
//! own without drawing anything — where pointing the action at a GUI program
//! would leave a window open on whoever ran the suite. The folder is the
//! temp directory, and opening it does put one Explorer window on screen;
//! that is the action being tested, and there is no honest way to test it
//! without performing it.

use std::path::PathBuf;

use crate::db::init_memory_db;
use crate::services::{analytics, focus, routine_exec, routines, tasks, xp};

use routines::{NewRoutine, NewRoutineAction, RoutineActionType};
use tasks::{NewTask, TaskPriority, TaskStatus, TaskUpdate};

/// A folder that exists on every machine and opening which is harmless — the
/// routine's "Project Folder" action.
fn a_real_folder() -> PathBuf {
    std::env::temp_dir()
}

/// Writes the routine's "application": a real program that starts, does
/// nothing and exits, without a console or a window. Returns its path.
///
/// On Windows this is a `.cmd`, which `routine_exec` runs through `cmd /C`
/// with `CREATE_NO_WINDOW` — so the test covers a launch path the app really
/// uses rather than a special case built for it.
fn write_a_harmless_program() -> PathBuf {
    let path = std::env::temp_dir().join(if cfg!(windows) {
        "routine-launcher-mvp-loop.cmd"
    } else {
        "routine-launcher-mvp-loop.sh"
    });

    let script = if cfg!(windows) { "@exit /b 0
" } else { "#!/bin/sh
exit 0
" };
    std::fs::write(&path, script).expect("the test needs somewhere to write its program");

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    path
}

fn action(action_type: RoutineActionType, target: String) -> NewRoutineAction {
    NewRoutineAction {
        action_type,
        target,
        arguments: None,
        sort_order: None,
        enabled: Some(true),
    }
}

#[test]
fn the_mvp_loop_runs_end_to_end() {
    let conn = init_memory_db().unwrap();

    // --- Assign it to a routine ------------------------------------------
    //
    // The routine first, because a task can only point at one that exists.
    // Three actions, which is section 32's shape: something to work in,
    // somewhere to work, and how long for.
    let folder = a_real_folder().to_string_lossy().into_owned();
    let program = write_a_harmless_program();
    let routine = routines::create(
        &conn,
        NewRoutine {
            name: "Coding Mode".to_owned(),
            description: Some("Everything for a coding session".to_owned()),
            icon: Some("code".to_owned()),
            actions: vec![
                action(
                    RoutineActionType::Application,
                    program.to_string_lossy().into_owned(),
                ),
                action(RoutineActionType::Folder, folder.clone()),
                action(RoutineActionType::Timer, "50".to_owned()),
            ],
        },
    )
    .unwrap();

    // --- Create a task ----------------------------------------------------
    let task = tasks::create(
        &conn,
        NewTask {
            title: "Finish the release notes".to_owned(),
            description: None,
            status: None,
            priority: Some(TaskPriority::High),
            category_id: None,
            due_date: Some(today(&conn)),
            due_time: None,
            estimated_minutes: Some(50),
            routine_id: Some(routine.id),
            recurrence: None,
        },
    )
    .unwrap();

    assert_eq!(task.status, TaskStatus::Todo);
    assert_eq!(
        task.routine_id,
        Some(routine.id),
        "the task knows its routine, which is what makes START TASK possible at all"
    );

    // Nothing has happened yet, and the day says so. Everything below is
    // measured against this.
    let before = analytics::productivity_stats(&conn).unwrap();
    assert_eq!(before.today.tasks_completed, 0);
    assert_eq!(before.today.routine_launches, 0);
    assert_eq!(before.today.focus_sessions, 0);
    assert_eq!(before.today.tasks_total, 1, "the task is owed today");
    assert_eq!(xp::total_xp(&conn).unwrap(), 0);

    // --- Click "Start Task" ----------------------------------------------
    //
    // Which is these two calls: the plan is read and the launch recorded
    // under the connection lock, then the actions run without it.
    let plan = routines::prepare_launch(&conn, routine.id).unwrap();
    assert_eq!(plan.launch_count, 1, "the launch is counted as it is prepared");

    let run = routine_exec::run(plan);

    // --- Applications and folders launch ----------------------------------
    assert_eq!(run.total, 3);
    assert_eq!(
        run.failed, 0,
        "every action should have started: {:?}",
        run.actions
            .iter()
            .filter(|a| a.status == routine_exec::ActionStatus::Failure)
            .map(|a| (a.label.clone(), a.message.clone()))
            .collect::<Vec<_>>()
    );
    assert_eq!(run.succeeded, 3);
    assert_eq!(run.summary, "Ready.", "section 32's happy path ends on this");

    // --- Focus timer starts -----------------------------------------------
    //
    // The timer action is a *signal*: it reports the minutes, and the caller
    // turns them into a session. That handoff is the Stage 5 seam, and it is
    // the reason the loop does not need the user to start a clock by hand.
    let minutes = run
        .timer_minutes
        .expect("the routine's timer action should ask for a session");
    assert_eq!(minutes, 50);

    let session = focus::start(
        &conn,
        focus::NewFocusSession {
            task_id: Some(task.id),
            routine_id: Some(routine.id),
            preset: focus::FocusPreset::Custom,
            planned_seconds: Some(minutes * 60),
        },
    )
    .unwrap();

    assert!(
        focus::active(&conn).unwrap().is_some(),
        "the clock is running and the app can find it"
    );
    assert_eq!(session.task_id, Some(task.id));
    assert_eq!(session.routine_id, Some(routine.id));

    // --- User works -------------------------------------------------------
    //
    // Fifty minutes of it, which a test cannot spend and cannot fake by
    // asking for: `end` clamps the reported seconds down to the wall clock
    // (section 88 — a wrong number may shorten a session's record and never
    // inflate it), so a session started and ended in the same instant is
    // correctly recorded as nothing at all. Moving `started_at` back is the
    // only honest way to have worked: it makes the wall clock real, and the
    // clamp then has something to agree with.
    conn.execute(
        "UPDATE focus_sessions
            SET started_at = datetime('now', '-50 minutes')
          WHERE id = ?1",
        rusqlite::params![session.id],
    )
    .unwrap();

    let finished = focus::end(
        &conn,
        session.id,
        focus::FocusSessionOutcome {
            completed: true,
            duration_seconds: Some(minutes * 60),
        },
    )
    .unwrap();

    assert!(finished.completed);
    assert!(!finished.interrupted);
    assert_eq!(
        finished.duration_seconds,
        Some(3000),
        "the fifty minutes are recorded, not clamped away"
    );
    assert!(
        focus::active(&conn).unwrap().is_none(),
        "and stops being the active one once it has ended"
    );

    // --- Task is completed ------------------------------------------------
    let completed = tasks::update(
        &conn,
        task.id,
        TaskUpdate {
            status: Some(TaskStatus::Completed),
            ..TaskUpdate::default()
        },
    )
    .unwrap();

    assert_eq!(completed.status, TaskStatus::Completed);
    assert!(
        completed.completed_at.is_some(),
        "completion is dated, which is what puts it in today's figures"
    );

    // --- Daily progress updates -------------------------------------------
    let after = analytics::productivity_stats(&conn).unwrap();

    assert_eq!(after.today.tasks_completed, 1, "the task shows in today's total");
    assert_eq!(after.today.tasks_total, 1);
    assert_eq!(after.today.focus_sessions, 1);
    assert_eq!(after.today.focus_seconds, 3000, "50 minutes of it");
    assert_eq!(
        after.today.routine_launches, 1,
        "the launch is dated, so today can count it"
    );

    assert_eq!(
        after.routine_usage.first().map(|usage| usage.name.as_str()),
        Some("Coding Mode"),
        "and it is the week's most used routine"
    );

    let today_square = after
        .week_days
        .iter()
        .find(|day| day.date == after.today_date)
        .expect("today is one of the week's days");
    assert!(today_square.productive, "a day this full has to count (section 46)");

    assert_eq!(after.streak.current_streak, 1, "which starts the streak");

    // Section 43's three payouts, none of which the loop above asked for:
    // `prepare_launch`, `focus::end` and `tasks::update` each write their own
    // as part of doing the thing (section 50 — the XP is a footnote to the
    // work, not a step the caller has to remember).
    let ledger = xp::list_transactions(&conn, None).unwrap();
    let paid = |source: xp::XpSource| -> i64 {
        ledger
            .iter()
            .filter(|entry| entry.source == source)
            .map(|entry| entry.amount)
            .sum()
    };

    assert_eq!(paid(xp::XpSource::RoutineLaunch), 10, "the day's first launch");
    assert_eq!(paid(xp::XpSource::FocusSession), 25, "the completed session");
    assert_eq!(paid(xp::XpSource::TaskCompletion), 10, "the finished task");

    // And the two of section 47's achievements this one run can unlock.
    let unlocked: Vec<String> = xp::list_achievements(&conn)
        .unwrap()
        .into_iter()
        .filter(|achievement| achievement.unlocked_at.is_some())
        .map(|achievement| achievement.key)
        .collect();
    for key in ["first_task", "first_routine"] {
        assert!(
            unlocked.iter().any(|unlocked| unlocked == key),
            "{key} should be unlocked by one run of the loop, got {unlocked:?}"
        );
    }

    let progress = xp::progress(&conn).unwrap();
    assert_eq!(
        progress.total_xp,
        ledger.iter().map(|entry| entry.amount).sum::<i64>(),
        "the headline total is the ledger, not a second tally of it"
    );
    assert!(progress.total_xp >= 45, "at least the three payouts: {progress:?}");

    // Section 33's per-routine figures agree with the day's, so the routine
    // card and the dashboard cannot tell the user two different stories about
    // the same session.
    let statistics = analytics::routine_statistics_for(&conn, routine.id)
        .unwrap()
        .expect("the routine has figures once it has been launched");
    assert_eq!(statistics.launches, 1);
    assert_eq!(statistics.focus_seconds, 3000);
    assert_eq!(statistics.tasks_completed, 1);
    assert!(statistics.last_used.is_some());

    // The loop is repeatable: the routine is still there, still assigned to
    // nothing that has gone stale, and can be launched again tomorrow.
    assert_eq!(routines::list(&conn).unwrap().len(), 1);

    let _ = std::fs::remove_file(&program);
}

/// Local `YYYY-MM-DD`, asked of the same database the figures are read from —
/// so "today" means the same thing here as it does inside `analytics`.
fn today(conn: &rusqlite::Connection) -> String {
    conn.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))
        .unwrap()
}
