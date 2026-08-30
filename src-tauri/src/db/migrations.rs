//! Minimal, dependency-free migration runner.
//!
//! Migration SQL files live in `database/migrations/` at the repo root
//! (shared conceptually with any future non-Rust tooling) and are embedded
//! into the binary at compile time with `include_str!`, so the app never
//! needs to read them from disk at runtime — this keeps things working the
//! same in `tauri dev` and in a packaged installer.
//!
//! To add a migration: create the next-numbered `.sql` file under
//! `database/migrations/`, then append a `Migration` entry below. Applied
//! migrations are tracked in the `_migrations` table so each one only ever
//! runs once per database.

use rusqlite::{params, Connection};

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "0001_init",
        sql: include_str!("../../../database/migrations/0001_init.sql"),
    },
    Migration {
        version: 2,
        name: "0002_seed_task_categories",
        sql: include_str!("../../../database/migrations/0002_seed_task_categories.sql"),
    },
    Migration {
        version: 3,
        name: "0003_focus_session_preset",
        sql: include_str!("../../../database/migrations/0003_focus_session_preset.sql"),
    },
    Migration {
        version: 4,
        name: "0004_task_reminders",
        sql: include_str!("../../../database/migrations/0004_task_reminders.sql"),
    },
    Migration {
        version: 5,
        name: "0005_seed_achievements",
        sql: include_str!("../../../database/migrations/0005_seed_achievements.sql"),
    },
    Migration {
        version: 6,
        name: "0006_quest_keys",
        sql: include_str!("../../../database/migrations/0006_quest_keys.sql"),
    },
    Migration {
        version: 7,
        name: "0007_routine_launches",
        sql: include_str!("../../../database/migrations/0007_routine_launches.sql"),
    },
];

/// Applies every migration this build carries that the database has not had
/// yet, oldest first.
pub fn run(conn: &Connection) -> rusqlite::Result<()> {
    run_through(conn, i64::MAX)
}

/// [`run`], stopping after `target` — the schema an older build of the app
/// would have left behind.
///
/// Only the test module passes anything but [`i64::MAX`]: it is how a
/// "database written by the previous version" is produced for the upgrade
/// tests, without keeping a copy of every past binary around to write one.
fn run_through(conn: &Connection, target: i64) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    for migration in MIGRATIONS {
        if migration.version > target {
            break;
        }

        let already_applied: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM _migrations WHERE version = ?1)",
            params![migration.version],
            |row| row.get(0),
        )?;

        if already_applied {
            continue;
        }

        apply(conn, migration)?;
    }

    Ok(())
}

/// Runs one migration's SQL and records it, both or neither.
///
/// The savepoint is the whole function. Without it the two halves are
/// separate autocommits and an upgrade interrupted between them — a crash, a
/// kill, a machine losing power while the installer's new binary starts for
/// the first time — leaves the schema changed and `_migrations` still saying
/// it is not. The next launch would then re-run the migration from the top,
/// and none of the interesting ones survive that: `0003` and `0004` are
/// `ALTER TABLE ... ADD COLUMN`, which fails with "duplicate column name" the
/// second time, and `init_db` treats a migration that will not apply as
/// fatal. The user's app would refuse to start, on every launch, with no way
/// back — so the window in which that is possible has to not exist.
///
/// The same hazard exists *within* a migration: `execute_batch` runs the
/// statements one at a time, so `0004`'s five `ALTER TABLE`s are five
/// autocommits and a failure at the third leaves two columns added. The
/// savepoint covers those too, which is what lets a failed migration be
/// reported as an error the caller can act on rather than as a half-changed
/// database nobody can.
///
/// A savepoint rather than a transaction because [`super::rebuild`] calls
/// [`run`] from inside one the caller opened — `BEGIN` would fail there,
/// while savepoints nest.
fn apply(conn: &Connection, migration: &Migration) -> rusqlite::Result<()> {
    conn.execute_batch("SAVEPOINT _migration;")?;

    let result = conn.execute_batch(migration.sql).and_then(|()| {
        conn.execute(
            "INSERT INTO _migrations (version, name) VALUES (?1, ?2)",
            params![migration.version, migration.name],
        )
        .map(drop)
    });

    match result {
        Ok(()) => conn.execute_batch("RELEASE _migration;"),
        Err(error) => {
            // Rolling back leaves the savepoint open, so it is released too —
            // otherwise the failure would also leave a transaction behind on
            // a connection the caller may still be using.
            conn.execute_batch("ROLLBACK TO _migration; RELEASE _migration;")
                .and(Err(error))
        }
    }
}

/// The highest migration this database has had applied to it, or 0 for one
/// that has had none.
///
/// This is the number a backup file carries (development-plan.md section 69):
/// it says which columns the rows in it were written with, which is what lets
/// an import tell "an older backup, restore what it has" from "a backup this
/// build is too old to understand, refuse it". Reading `MAX(version)` rather
/// than `MIGRATIONS.len()` is deliberate — it describes the *file* in front of
/// us rather than the build that is looking at it.
/// The newest schema this build can produce — the version a database has
/// once [`run`] is finished with it.
///
/// Compared against [`recorded_version`] to recognise a database written by a
/// *later* build than this one; see `super::init_db` for what is done about
/// it.
pub fn latest_version() -> i64 {
    MIGRATIONS.last().map_or(0, |migration| migration.version)
}

/// [`applied_version`], for a database that may not have been migrated at all
/// yet.
///
/// `applied_version` reads `_migrations`, which does not exist before [`run`]
/// has created it — so asking a brand new file what version it is would be an
/// error rather than the answer, which is 0. This is the form the check in
/// `super::init_db` needs, because that runs before the migrations do.
pub fn recorded_version(conn: &Connection) -> rusqlite::Result<i64> {
    let has_bookkeeping: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master
              WHERE type = 'table' AND name = '_migrations'
         )",
        [],
        |row| row.get(0),
    )?;

    if has_bookkeeping {
        applied_version(conn)
    } else {
        Ok(0)
    }
}

pub fn applied_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COALESCE(MAX(version), 0) FROM _migrations", [], |row| {
        row.get(0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The version the shipping build migrates to. Read from the table rather
    /// than written down, so adding a migration does not need this file
    /// edited — only the assertions that name a specific one do.
    fn latest() -> i64 {
        MIGRATIONS.last().expect("there is at least one migration").version
    }

    /// A connection set up the way [`super::super::init_db`] sets up the real
    /// one, minus the file: foreign keys on, no migrations applied yet.
    fn blank() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        conn
    }

    /// A database as the build that shipped migration `version` would have
    /// left it — the "previous version" half of every upgrade test below.
    fn at_version(version: i64) -> Connection {
        let conn = blank();
        run_through(&conn, version).unwrap();
        conn
    }

    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let names = stmt.query_map([], |row| row.get::<_, String>(1)).unwrap();
        names.collect::<rusqlite::Result<_>>().unwrap()
    }

    fn tables(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master
                  WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                  ORDER BY name",
            )
            .unwrap();
        let names = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
        names.collect::<rusqlite::Result<_>>().unwrap()
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn versions_are_unique_and_in_ascending_order() {
        // The runner applies migrations in the order they are declared and
        // records them by version, so a duplicate or an out-of-order entry
        // would be applied to a fresh install and skipped on an upgrade —
        // the two would end up with different schemas.
        let versions: Vec<i64> = MIGRATIONS.iter().map(|m| m.version).collect();
        let mut sorted = versions.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(versions, sorted, "migration versions must ascend and not repeat");
        assert_eq!(versions.first(), Some(&1), "numbering starts at 1");
    }

    #[test]
    fn a_fresh_install_ends_at_the_latest_version() {
        let conn = blank();
        run(&conn).unwrap();

        assert_eq!(applied_version(&conn).unwrap(), latest());
        assert_eq!(
            count(&conn, "_migrations"),
            MIGRATIONS.len() as i64,
            "every migration is recorded, not just the last"
        );
    }

    #[test]
    fn running_again_changes_nothing() {
        // The ordinary case: the app is opened a second time on a database
        // that is already current.
        let conn = blank();
        run(&conn).unwrap();
        let before = tables(&conn);
        let categories = count(&conn, "task_categories");

        run(&conn).unwrap();
        run(&conn).unwrap();

        assert_eq!(tables(&conn), before);
        assert_eq!(count(&conn, "task_categories"), categories, "seeds are not re-seeded");
        assert_eq!(count(&conn, "_migrations"), MIGRATIONS.len() as i64);
    }

    #[test]
    fn upgrading_from_every_shipped_version_reaches_the_same_schema() {
        // What the installer actually does: replace the binary over a
        // database written by an older one. Every version that has ever
        // shipped has to arrive at the schema a fresh install gets, or the
        // upgraded user and the new user are running different apps.
        let fresh = blank();
        run(&fresh).unwrap();
        let expected_tables = tables(&fresh);

        for migration in MIGRATIONS {
            let conn = at_version(migration.version);
            assert_eq!(applied_version(&conn).unwrap(), migration.version);

            run(&conn).unwrap();

            assert_eq!(
                applied_version(&conn).unwrap(),
                latest(),
                "upgrading from {} should reach the latest version",
                migration.name
            );
            assert_eq!(
                tables(&conn),
                expected_tables,
                "upgrading from {} should reach the fresh-install schema",
                migration.name
            );
            for table in &expected_tables {
                assert_eq!(
                    columns(&conn, table),
                    columns(&fresh, table),
                    "{table} differs after upgrading from {}",
                    migration.name
                );
            }
        }
    }

    #[test]
    fn an_upgrade_keeps_the_rows_the_old_version_wrote() {
        // Migration 1 is the oldest database that can exist, so it is the
        // longest upgrade path there is; a task and a routine written then
        // have to still be there at the end of it, and the columns the newer
        // migrations added have to arrive empty rather than not at all.
        let conn = at_version(1);
        conn.execute("INSERT INTO tasks (id, title) VALUES (7, 'Write the release notes')", [])
            .unwrap();
        conn.execute("INSERT INTO routines (id, name) VALUES (3, 'Coding Mode')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO focus_sessions (id, task_id, started_at)
             VALUES (5, 7, '2026-01-01 09:00:00')",
            [],
        )
        .unwrap();

        run(&conn).unwrap();

        let title: String = conn
            .query_row("SELECT title FROM tasks WHERE id = 7", [], |row| row.get(0))
            .unwrap();
        assert_eq!(title, "Write the release notes");

        let reminder: Option<String> = conn
            .query_row("SELECT reminder_kind FROM tasks WHERE id = 7", [], |row| row.get(0))
            .unwrap();
        assert_eq!(reminder, None, "0004's columns arrive unset on an existing task");

        let preset: String = conn
            .query_row("SELECT preset FROM focus_sessions WHERE id = 5", [], |row| row.get(0))
            .unwrap();
        assert_eq!(preset, "custom", "0003's column takes its default on existing rows");

        assert_eq!(count(&conn, "routines"), 1);
        assert_eq!(
            count(&conn, "task_categories"),
            7,
            "0002's seed still lands on a database that predates it"
        );
        assert_eq!(count(&conn, "achievements"), 6, "and so does 0005's");
    }

    #[test]
    fn the_launch_history_backfill_dates_one_launch_and_only_runs_once() {
        // 0007 is the only migration that copies existing rows, so it is the
        // only one that would double its own work if it were ever applied
        // twice. A routine that has been launched gets exactly one dated row
        // — see the migration for why it is a seed rather than a back-fill —
        // and a routine that never has gets none.
        let conn = at_version(6);
        conn.execute(
            "INSERT INTO routines (id, name, launch_count, last_launched_at)
             VALUES (1, 'Coding Mode', 42, '2026-01-02 08:30:00')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO routines (id, name, launch_count) VALUES (2, 'Wind Down', 0)",
            [],
        )
        .unwrap();

        run(&conn).unwrap();
        run(&conn).unwrap();

        assert_eq!(count(&conn, "routine_launches"), 1);
        let (routine_id, launched_at): (i64, String) = conn
            .query_row("SELECT routine_id, launched_at FROM routine_launches", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(routine_id, 1);
        assert_eq!(launched_at, "2026-01-02 08:30:00");

        let launch_count: i64 = conn
            .query_row("SELECT launch_count FROM routines WHERE id = 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(launch_count, 42, "the lifetime total is not recomputed from the new table");
    }

    #[test]
    fn a_migration_that_fails_partway_leaves_nothing_behind() {
        // The upgrade hazard this runner exists to close. A migration whose
        // second statement fails must not commit its first: `0003` and
        // `0004` are `ALTER TABLE ... ADD COLUMN`, and a half-applied one
        // would fail with "duplicate column name" on every launch afterwards
        // — an app that cannot start, permanently, because an upgrade was
        // interrupted.
        let conn = at_version(2);
        let before = columns(&conn, "tasks");

        let broken = Migration {
            version: 999,
            name: "0999_broken",
            sql: "ALTER TABLE tasks ADD COLUMN half_applied TEXT;
                  INSERT INTO no_such_table (whatever) VALUES (1);",
        };

        let error = apply(&conn, &broken).unwrap_err();
        assert!(
            error.to_string().contains("no_such_table"),
            "the real failure is reported, not the rollback: {error}"
        );

        assert_eq!(
            columns(&conn, "tasks"),
            before,
            "the column added before the failure is rolled back with it"
        );
        assert_eq!(
            applied_version(&conn).unwrap(),
            2,
            "a migration that failed is not recorded as applied"
        );

        // And the connection is still usable: the savepoint was released on
        // the way out, so nothing is left open on it.
        run(&conn).unwrap();
        assert_eq!(applied_version(&conn).unwrap(), latest());
    }

    #[test]
    fn a_database_reports_its_version_before_it_has_been_migrated() {
        // The check in `init_db` runs before `run` does, so it has to be able
        // to ask a file that has never been opened by this app what version it
        // is — and get 0 rather than "no such table: _migrations".
        let conn = blank();
        assert_eq!(recorded_version(&conn).unwrap(), 0);

        run(&conn).unwrap();
        assert_eq!(recorded_version(&conn).unwrap(), latest());
        assert_eq!(latest_version(), latest());
    }

    #[test]
    fn a_database_from_a_newer_build_is_left_alone() {
        // Downgrades are refused by the installer (`allowDowngrades: false`),
        // but a user can still run an older portable copy against a newer
        // database. It has to be a no-op rather than a re-run: every
        // migration this build knows is already recorded, so there is nothing
        // to apply and nothing is dropped.
        let conn = blank();
        run(&conn).unwrap();
        conn.execute(
            "INSERT INTO _migrations (version, name) VALUES (?1, '0999_from_the_future')",
            params![latest() + 1],
        )
        .unwrap();
        let before = tables(&conn);

        run(&conn).unwrap();

        assert_eq!(tables(&conn), before);
        assert_eq!(applied_version(&conn).unwrap(), latest() + 1);
    }
}
