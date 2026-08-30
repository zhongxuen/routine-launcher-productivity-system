//! SQLite connection setup for the app's local, on-disk database.
//!
//! This module is the only place that knows about the database *file*.
//! Everything else in the backend (services, commands) talks to a
//! `rusqlite::Connection` handed to it — it never needs to know where the
//! file lives or how migrations are applied.
//!
//! It is also the only place that knows how to *un*-apply them, which is what
//! [`rebuild`] is for — see its docs and `services::backup` for why section
//! 69's Import and Reset both go through here rather than clearing tables of
//! their own.

mod migrations;

pub use migrations::applied_version as schema_version;

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
///
/// The error is a sentence rather than a `rusqlite::Error` because there are
/// two quite different ways this fails and only one of them is SQLite's: a
/// directory that cannot be created is an `io::Error`, and it used to be a
/// `panic!` here. Both end up in front of the user through
/// `services::logging::fatal`, which is the only caller that can do anything
/// with either — see there for why a failure this early has to be shown and
/// not just logged.
pub fn init_db(app_data_dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(app_data_dir).map_err(|error| {
        format!(
            "This app's data folder could not be created:\n{}\n\n{error}",
            app_data_dir.display()
        )
    })?;

    let db_path = app_data_dir.join(DB_FILE_NAME);
    let conn = Connection::open(&db_path)
        .map_err(|error| format!("The database could not be opened:\n{}\n\n{error}", db_path.display()))?;

    // Enforce FK constraints (off by default in SQLite) and use WAL for
    // better read/write concurrency within the app.
    conn.pragma_update(None, "foreign_keys", true)
        .and_then(|()| conn.pragma_update(None, "journal_mode", "WAL"))
        .map_err(|error| format!("The database could not be prepared:\n{}\n\n{error}", db_path.display()))?;

    // A database written by a *later* build than this one, which the Windows
    // installers do not reliably prevent: `allowDowngrades: false` is
    // enforced from the NSIS reinstall *page*, and a silent install (`/S`,
    // which is how deployment tooling runs it) skips pages — so an older
    // package will happily replace a newer one.
    //
    // Migrating is not the risk; `migrations::run` leaves versions it does
    // not know alone. The risk is everything after it: this build's services
    // would then be reading and writing a schema they were not written
    // against, with no idea they were doing it, and the first thing the user
    // would know is data that had quietly stopped making sense. Refusing is
    // the recoverable answer — nothing has been touched, and reinstalling the
    // newer version puts them back exactly where they were.
    let recorded = migrations::recorded_version(&conn).map_err(|error| {
        format!(
            "The database could not be read:\n{}\n\n{error}",
            db_path.display()
        )
    })?;
    let latest = migrations::latest_version();
    if recorded > latest {
        return Err(format!(
            "Your data was saved by a newer version of Routine Launcher than this one, and \
             this version cannot read it safely.\n\nThe database is at schema {recorded}; \
             this build understands schema {latest}.\n\nInstall the newer version again to \
             carry on. Nothing has been changed."
        ));
    }

    // A migration that will not apply is the one failure the user cannot be
    // asked to work around, so it is named separately from "could not open":
    // the file is readable and the app still will not run on it.
    migrations::run(&conn).map_err(|error| {
        format!(
            "The database could not be brought up to date:\n{}\n\n{error}",
            db_path.display()
        )
    })?;

    Ok(conn)
}

/// Drops every table and re-applies the migrations, leaving the schema and
/// seed rows exactly as a first launch would.
///
/// This is the destructive half of development-plan.md section 69 — Reset
/// uses it on its own, Import uses it before restoring — and it is one
/// function rather than two because "wiped" and "ready to be restored into"
/// have to mean the same thing. Anything less than dropping the tables would
/// not: `DELETE FROM` leaves `sqlite_sequence` counting on from the deleted
/// rows, so a reset user's first task would carry the id of their thousandth,
/// and it would keep any table a superseded version had created. Re-running
/// the migrations against nothing is the same code path a fresh install
/// takes, so there is no second definition of "empty" to keep in step.
///
/// **The caller supplies the transaction.** This takes `&Connection` — which
/// a `rusqlite::Transaction` derefs to — and does not open one, because
/// between the drop and the rebuild there is no database at all: that window
/// has to close inside somebody's transaction or a failure would leave the
/// user with neither their data nor a schema. Callers also want
/// `PRAGMA defer_foreign_keys = ON` set on it, so the implicit deletes a
/// `DROP TABLE` performs are checked once at `COMMIT` rather than table by
/// table on the way down.
pub fn rebuild(conn: &Connection) -> rusqlite::Result<()> {
    let tables: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?;
        let names = stmt.query_map([], |row| row.get::<_, String>(0))?;
        names.collect::<rusqlite::Result<_>>()?
    };

    for table in tables {
        // `sqlite_sequence` is excluded above and cannot be dropped directly;
        // SQLite removes it once the last AUTOINCREMENT table is gone.
        conn.execute_batch(&format!(
            "DROP TABLE IF EXISTS \"{}\";",
            table.replace('"', "\"\"")
        ))?;
    }

    migrations::run(conn)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of this test's own under the temp folder, so a run never
    /// meets another run's `app.db`.
    fn a_data_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("routine-launcher-db-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_first_launch_creates_the_folder_the_database_goes_in() {
        // `init_db` is given a directory that does not exist yet — which is
        // every first launch, and used to be a `panic!` if it could not be
        // made.
        let dir = a_data_dir("fresh");
        assert!(!dir.exists());

        let conn = init_db(&dir).expect("a fresh install should open");

        assert!(dir.join(DB_FILE_NAME).is_file());
        assert_eq!(schema_version(&conn).unwrap(), migrations::latest_version());

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_database_that_cannot_be_opened_is_reported_and_not_panicked_on() {
        // The section 85 permission case, staged the one way a test can stage
        // it deterministically: something that is not a database file where
        // the database file goes.
        let dir = a_data_dir("unopenable");
        std::fs::create_dir_all(dir.join(DB_FILE_NAME)).unwrap();

        let error = init_db(&dir).expect_err("a directory is not a database");

        assert!(error.contains("could not be opened"), "{error}");
        assert!(error.contains(DB_FILE_NAME), "it names the file: {error}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_database_from_a_newer_build_is_refused_rather_than_used() {
        // The downgrade the Windows installers do not reliably stop: a silent
        // install of an older package over a newer one. This build must not
        // read and write a schema it was not written against — see the note
        // in `init_db`.
        let dir = a_data_dir("from-the-future");
        let conn = init_db(&dir).unwrap();
        let future = migrations::latest_version() + 1;
        conn.execute(
            "INSERT INTO _migrations (version, name) VALUES (?1, '0999_from_the_future')",
            rusqlite::params![future],
        )
        .unwrap();
        conn.execute("INSERT INTO tasks (title) VALUES ('Written by the newer build')", [])
            .unwrap();
        drop(conn);

        let error = init_db(&dir).expect_err("this build should refuse it");

        assert!(error.contains("newer version"), "{error}");
        assert!(
            error.contains(&future.to_string()),
            "it names the schema it found: {error}"
        );
        assert!(
            error.contains("Nothing has been changed."),
            "and says the data is safe: {error}"
        );

        // And it means it: the row the newer build wrote is still there.
        let conn = Connection::open(dir.join(DB_FILE_NAME)).unwrap();
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(kept, 1);

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
