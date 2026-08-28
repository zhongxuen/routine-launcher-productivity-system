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
];

pub fn run(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    for migration in MIGRATIONS {
        let already_applied: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM _migrations WHERE version = ?1)",
            params![migration.version],
            |row| row.get(0),
        )?;

        if already_applied {
            continue;
        }

        conn.execute_batch(migration.sql)?;
        conn.execute(
            "INSERT INTO _migrations (version, name) VALUES (?1, ?2)",
            params![migration.version, migration.name],
        )?;
    }

    Ok(())
}
