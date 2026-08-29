//! Key/value access to the `settings` table.
//!
//! The table is a plain string map (see `database/migrations/0001_init.sql`
//! and development-plan.md section 52): every feature that needs a persisted
//! preference owns its own key and its own typed accessor, and this module
//! only handles the read/write/parse mechanics they share.
//!
//! Keys are namespaced by feature (`routines.command_actions_enabled`, ...)
//! so two features can never collide on one.

use rusqlite::{params, Connection, OptionalExtension};

use super::error::{ServiceError, ServiceResult};

/// Returns the raw stored string, or `None` if the key was never written.
pub fn get(conn: &Connection, key: &str) -> ServiceResult<Option<String>> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(ServiceError::from)
}

/// Writes `value`, replacing whatever was there and refreshing `updated_at`.
pub fn set(conn: &Connection, key: &str, value: &str) -> ServiceResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at)
         VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at",
        params![key, value],
    )?;
    Ok(())
}

/// Reads a boolean flag, falling back to `default` when the key is unset.
///
/// Anything that is not exactly `"true"` reads as false, so a corrupted or
/// hand-edited value can never accidentally *enable* a flag — which matters
/// for the command-execution switch in development-plan.md section 66.
pub fn get_bool(conn: &Connection, key: &str, default: bool) -> ServiceResult<bool> {
    Ok(get(conn, key)?.map_or(default, |value| value == "true"))
}

pub fn set_bool(conn: &Connection, key: &str, value: bool) -> ServiceResult<()> {
    set(conn, key, if value { "true" } else { "false" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    #[test]
    fn round_trips_values_and_defaults_unset_keys() {
        let conn = init_memory_db().unwrap();

        assert_eq!(get(&conn, "missing").unwrap(), None);
        assert!(get_bool(&conn, "missing", true).unwrap());
        assert!(!get_bool(&conn, "missing", false).unwrap());

        set(&conn, "greeting", "hello").unwrap();
        set(&conn, "greeting", "hi").unwrap();
        assert_eq!(get(&conn, "greeting").unwrap().as_deref(), Some("hi"));

        set_bool(&conn, "flag", true).unwrap();
        assert!(get_bool(&conn, "flag", false).unwrap());
    }

    #[test]
    fn only_the_exact_string_true_reads_as_enabled() {
        let conn = init_memory_db().unwrap();
        for stored in ["TRUE", "1", "yes", "", "false"] {
            set(&conn, "flag", stored).unwrap();
            assert!(
                !get_bool(&conn, "flag", false).unwrap(),
                "{stored:?} must not enable a flag"
            );
        }
    }
}
