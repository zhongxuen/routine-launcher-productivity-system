//! SQLite connection setup for the app's local, on-disk database.
//!
//! This module is the only place that knows about the database *file*.
//! Everything else in the backend (services, commands) talks to a
//! `rusqlite::Connection` handed to it — it never needs to know where the
//! file lives or how migrations are applied.

mod migrations;

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

/// The database filename inside the app's data directory.
const DB_FILE_NAME: &str = "app.db";

/// Tauri-managed state wrapping the single SQLite connection.
///
/// A `Mutex` is sufficient here: this is a desktop app with modest,
/// bursty query volume, not a highly-concurrent server. If contention
/// ever becomes a problem this can be swapped for a connection pool
/// (e.g. `r2d2_sqlite`) without changing the service/command layers.
pub type DbConnection = Mutex<Connection>;

/// Opens (creating if necessary) the SQLite database file inside
/// `app_data_dir`, applies any pending migrations, and returns the
/// ready-to-use connection.
pub fn init_db(app_data_dir: &Path) -> rusqlite::Result<Connection> {
    std::fs::create_dir_all(app_data_dir)
        .unwrap_or_else(|e| panic!("failed to create app data dir {app_data_dir:?}: {e}"));

    let db_path = app_data_dir.join(DB_FILE_NAME);
    let conn = Connection::open(db_path)?;

    // Enforce FK constraints (off by default in SQLite) and use WAL for
    // better read/write concurrency within the app.
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;

    migrations::run(&conn)?;

    Ok(conn)
}

/// Opens a throwaway in-memory database with every migration applied.
///
/// Service tests use this so they exercise the real schema (constraints,
/// defaults and seed rows included) without touching the user's `app.db`.
#[cfg(test)]
pub fn init_memory_db() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.pragma_update(None, "foreign_keys", true)?;
    migrations::run(&conn)?;
    Ok(conn)
}
