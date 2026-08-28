//! Temporary service used only to prove the SQLite round trip works
//! end-to-end (write step 5 of the local-persistence task). Remove this
//! once a real feature (tasks, routines, ...) exercises the database from
//! the UI instead.

use rusqlite::{params, Connection};

/// Writes a fresh timestamp into `settings` under a fixed key and reads it
/// straight back, proving both the write path and the read path work
/// against the on-disk database.
pub fn check(conn: &Connection) -> rusqlite::Result<String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
        .as_millis()
        .to_string();

    conn.execute(
        "INSERT INTO settings (key, value, updated_at)
         VALUES ('db_health_check', ?1, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at",
        params![now],
    )?;

    conn.query_row(
        "SELECT value FROM settings WHERE key = 'db_health_check'",
        [],
        |row| row.get(0),
    )
}
