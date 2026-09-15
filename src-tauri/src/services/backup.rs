//! Export, import and reset of everything the app stores
//! (development-plan.md section 69).
//!
//! Section 68 promises the user that their tasks, routines, focus history and
//! productivity data stay on their computer. Section 69 is the other half of
//! that promise: data that lives in one place, and only one place, has to be
//! something the user can carry. So a backup is a single file they choose the
//! location of, in a format they can read, and nothing here ever talks to a
//! network.
//!
//! # Why the tables are read by introspection
//!
//! Every other service in this crate names its columns. This one deliberately
//! does not: it asks SQLite what the columns *are* (`PRAGMA table_info`) and
//! copies whatever it finds.
//!
//! That is what makes the round trip lossless "including any columns added by
//! later stages". A hand-written `SELECT id, title, status, ...` is a second
//! copy of the schema, and the two only agree until the next migration adds a
//! column — at which point the export silently stops carrying it and nothing
//! fails, which is the worst way for a backup to be wrong. Stage 0 shipped
//! `focus_sessions` with eight columns; migration 0003 made it ten, 0004 put
//! five more on `tasks` and 0006 one more on `quests`. None of those needed a
//! line here, and neither will the next one.
//!
//! The list this module *does* hold is which tables are user data
//! ([`BACKUP_TABLES`]), because that is a judgement no pragma can make.
//! `_migrations` is not on it: it describes the shape of the database rather
//! than anything in it, and is carried as [`Backup::schema_version`] instead.
//!
//! # What import actually does
//!
//! Import is a replacement, not a merge. Rows carry their own ids — a focus
//! session points at the task it was worked on, an XP transaction points at
//! its source — so restoring rows under fresh ids would restore the data and
//! lose what it was about. Keeping the ids means the destination has to be
//! empty of anything that could collide with them, and "empty" here means
//! *fresh install*: the schema is dropped and rebuilt from the migrations
//! before anything is inserted, so an import lands on exactly the database a
//! new user gets rather than on the leftovers of the old one.
//!
//! Three things make that safe to do to somebody's only copy:
//!
//! * **The file is fully validated before the database is touched.** Parsing,
//!   the format check, the version check and every column and value are
//!   resolved into a plan first, so a truncated or hand-edited file is
//!   rejected while the existing data is still there.
//! * **It is one transaction.** Drop, rebuild, insert and commit either all
//!   happen or none do. A crash mid-import leaves the old database.
//! * **Foreign keys are deferred, not disabled.** `PRAGMA defer_foreign_keys`
//!   moves the check to `COMMIT` — which is the only place it can be made,
//!   because rows arrive one table at a time and a `focus_sessions` row is
//!   legitimately an orphan until `tasks` has been filled in. What it does
//!   *not* do is skip the check: a backup whose references do not line up
//!   fails the commit and rolls back. Turning the pragma off would have
//!   imported it and left the damage.
//!
//! # Reset
//!
//! [`reset`] is the same rebuild without the insert, and is why the two share
//! [`crate::db::rebuild`] rather than each clearing tables their own way. A
//! reset that deleted rows would leave `sqlite_sequence` counting from where
//! the old data stopped and would keep any table a later migration had added
//! and a later version had stopped using; dropping the schema and re-running
//! the migrations cannot, because it is the same code path a first launch
//! takes. Section 67's rule — destructive actions are user initiated — is
//! kept at the UI, where this is behind a typed confirmation, and in the API,
//! where the function takes no arguments and therefore cannot be aimed.

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::db;

use super::error::{ServiceError, ServiceResult};
use super::routines::COMMAND_ACTIONS_ENABLED_KEY;

/// The filename section 69 names. Offered as the default in the save dialog;
/// the user is free to rename it, and import does not care what it is called.
pub const BACKUP_FILE_NAME: &str = "routine-launcher-backup.json";

/// Marks the file as ours. Checked on import, so pointing the flow at some
/// other JSON file is refused with a sentence rather than with a stack trace.
pub const BACKUP_FORMAT: &str = "routine-launcher-backup";

/// The version of the *envelope* — the keys around the data, not the schema
/// of the data itself, which travels as [`Backup::schema_version`].
///
/// It has never been bumped. It exists so that a future rearrangement of this
/// file's shape can be recognised rather than guessed at: a reader that finds
/// a number it does not know refuses the file instead of half-understanding
/// it.
pub const BACKUP_FORMAT_VERSION: i64 = 1;

/// The tables a backup carries, parents before children.
///
/// The order is the insert order, and it is the reason import can put a
/// `routine_actions` row in at all — its `routine_id` has to exist first.
/// Deferred foreign keys mean the order is belt and braces rather than load
/// bearing, but a backup whose tables go in the right way round is also one
/// whose file reads in the right way round.
///
/// Section 69 lists tasks, routines, focus sessions, XP, achievements and
/// settings. The rest are here because leaving them out would make the six it
/// names wrong: a quest completion without its quest, an unlocked achievement
/// without the unlock, a streak that has to be recomputed from a history that
/// was not carried. `cleanup_actions` is the same: without it, Organized's
/// day count and today's cleanup quest would restart from nothing.
const BACKUP_TABLES: &[&str] = &[
    "settings",
    "task_categories",
    "task_recurrence",
    "routines",
    "routine_actions",
    "tasks",
    "daily_plans",
    "focus_sessions",
    "quests",
    "quest_completions",
    "xp_transactions",
    "achievements",
    "user_achievements",
    "streaks",
    "routine_launches",
    "cleanup_actions",
];

/// One backup file, deserialized.
///
/// `tables` is a map of table name to rows, and a row is a map of column name
/// to value — which is the whole format. There is no per-table struct here on
/// purpose: see the module docs for why the columns are discovered rather
/// than declared.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    /// Always [`BACKUP_FORMAT`].
    pub format: String,
    /// Always [`BACKUP_FORMAT_VERSION`] for files this build writes.
    pub format_version: i64,
    /// The highest migration applied to the database this came out of.
    pub schema_version: i64,
    /// The build that wrote it, for the user's benefit rather than the code's.
    pub app_version: String,
    /// UTC, `YYYY-MM-DD HH:MM:SS`, matching every other timestamp in the app.
    pub exported_at: String,
    /// Table name -> rows, each row a column-name-keyed object.
    pub tables: BTreeMap<String, Vec<JsonMap<String, JsonValue>>>,
}

/// How many rows one table contributed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCount {
    pub table: String,
    pub rows: i64,
}

/// What a backup file contains, without the contents.
///
/// Returned by all three of [`export_to_file`], [`inspect_file`] and
/// [`import_from_file`], because all three are answering the same question
/// from different sides — what is in this file. It is what the Import
/// confirmation is built from: section 67 asks that a destructive action be
/// shown before it is taken, and "3 routines, 812 tasks, exported on the 4th"
/// is the only description of an import that lets a user tell the right file
/// from the wrong one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// The file this describes, as the OS spells it.
    pub path: String,
    pub format_version: i64,
    pub schema_version: i64,
    pub app_version: String,
    pub exported_at: String,
    /// Per table, in [`BACKUP_TABLES`] order. Tables the file does not carry
    /// are absent rather than zero — "not in this backup" and "empty in this
    /// backup" are different facts and import treats them differently.
    pub counts: Vec<TableCount>,
    pub total_rows: i64,
    /// Whether importing this file would switch section 66's command actions
    /// on. Surfaced because it is the one setting in the backup that widens
    /// what the app is allowed to do, and a file is a route to it that the
    /// Settings switch's own confirmation does not cover.
    pub enables_command_actions: bool,
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Reads the whole database and writes it to `path` as JSON.
///
/// Pretty-printed, because section 68's promise is easier to believe about a
/// file the user can open and read than about one they cannot. The cost is
/// perhaps a third more bytes on a file that is measured in hundreds of
/// kilobytes at the top end.
pub fn export_to_file(conn: &Connection, app_version: &str, path: &str) -> ServiceResult<BackupInfo> {
    let backup = snapshot(conn, app_version)?;

    let json = serde_json::to_string_pretty(&backup)
        .map_err(|e| ServiceError::validation(format!("Could not build the backup: {e}")))?;

    let target = Path::new(path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(ServiceError::validation(format!(
                "There is no folder at {}, so the backup could not be saved there.",
                parent.display()
            )));
        }
    }

    std::fs::write(target, json)
        .map_err(|e| ServiceError::validation(format!("Could not write {path}: {e}")))?;

    Ok(describe(path, &backup))
}

/// Reads every backed-up table into an in-memory [`Backup`].
fn snapshot(conn: &Connection, app_version: &str) -> ServiceResult<Backup> {
    let mut tables = BTreeMap::new();

    for table in BACKUP_TABLES {
        tables.insert((*table).to_string(), read_table(conn, table)?);
    }

    Ok(Backup {
        format: BACKUP_FORMAT.to_string(),
        format_version: BACKUP_FORMAT_VERSION,
        schema_version: db::schema_version(conn)?,
        app_version: app_version.to_string(),
        exported_at: conn.query_row("SELECT datetime('now')", [], |row| row.get(0))?,
        tables,
    })
}

/// Every row of one table, oldest first, as column-keyed objects.
///
/// `ORDER BY rowid` rather than by any particular column: every table here is
/// an ordinary rowid table, so this is insertion order for all of them and
/// needs no per-table knowledge. It is also what makes two exports of an
/// unchanged database byte-identical, which is what lets the round-trip test
/// compare them directly.
fn read_table(conn: &Connection, table: &str) -> ServiceResult<Vec<JsonMap<String, JsonValue>>> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM {} ORDER BY rowid", quote(table)))?;

    let columns: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();

    let rows = stmt.query_map([], |row| {
        let mut object = JsonMap::with_capacity(columns.len());
        for (index, column) in columns.iter().enumerate() {
            object.insert(column.clone(), to_json(row.get::<_, SqlValue>(index)?));
        }
        Ok(object)
    })?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(ServiceError::from)
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Reads and validates a backup file without changing anything.
///
/// This is the "show" of section 67's scan / show / confirm / act: the Import
/// card calls it to fill in the confirmation, and only calls
/// [`import_from_file`] if the user goes ahead. It performs the same checks
/// the import does, so a file that will be refused is refused here — before
/// the user has been asked to confirm replacing their data with it.
pub fn inspect_file(conn: &Connection, path: &str) -> ServiceResult<BackupInfo> {
    let backup = read_file(path)?;
    validate(conn, &backup)?;
    Ok(describe(path, &backup))
}

/// Replaces the entire database with the contents of `path`.
///
/// Returns what was restored, which is the same [`BackupInfo`] the
/// confirmation was built from — so the success message describes what
/// actually landed rather than repeating what was promised.
pub fn import_from_file(conn: &mut Connection, path: &str) -> ServiceResult<BackupInfo> {
    let backup = read_file(path)?;
    let plan = plan_restore(conn, &backup)?;
    let info = describe(path, &backup);

    let tx = conn.transaction()?;

    // Deferred rather than disabled: the check still runs, at COMMIT, once
    // every table is in. See the module docs.
    tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;

    // Back to a fresh install, seeds and all, so nothing of the old database
    // can survive under an id the backup is about to reuse.
    db::rebuild(&tx)?;

    for table in &plan {
        // The rebuild leaves seeded rows in `task_categories`, `achievements`
        // and `streaks`. A backup that carries those tables carries its own
        // copies — including the ones the user renamed or deleted — so the
        // seeds have to go before they land.
        tx.execute(&format!("DELETE FROM {}", quote(&table.name)), [])?;

        if table.rows.is_empty() {
            continue;
        }

        let placeholders = (1..=table.columns.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let column_list = table
            .columns
            .iter()
            .map(|column| quote(column))
            .collect::<Vec<_>>()
            .join(", ");

        let mut stmt = tx.prepare(&format!(
            "INSERT INTO {} ({column_list}) VALUES ({placeholders})",
            quote(&table.name)
        ))?;

        for row in &table.rows {
            stmt.execute(params_from_iter(row.iter()))?;
        }
    }

    tx.commit().map_err(|error| {
        // The one failure the user can do something about, and the one this
        // module cannot rule out in advance: rows that refer to rows the
        // backup did not carry. Nothing was written — the transaction rolled
        // back — so the old data is still there.
        ServiceError::validation(format!(
            "The backup could not be restored because its records do not line up \
             with each other, so nothing was changed: {error}"
        ))
    })?;

    Ok(info)
}

/// One table's rows, resolved into the exact columns and values that will be
/// inserted.
struct TablePlan {
    name: String,
    columns: Vec<String>,
    rows: Vec<Vec<SqlValue>>,
}

/// Turns a parsed backup into an insert plan, or into the reason it cannot be
/// one.
///
/// Everything that can be refused is refused here, while the database is
/// untouched: the format, the schema version, unknown tables, unknown
/// columns, and any value SQLite could not hold. What is left afterwards is a
/// list of statements that are only going to fail for reasons no amount of
/// reading the file could have predicted.
fn plan_restore(conn: &Connection, backup: &Backup) -> ServiceResult<Vec<TablePlan>> {
    validate(conn, backup)?;

    let mut plan = Vec::new();

    for table in BACKUP_TABLES {
        let Some(rows) = backup.tables.get(*table) else {
            // Absent, not empty: a backup written before this table existed
            // says nothing about it, so the fresh install's own rows stay.
            continue;
        };

        let schema = table_columns(conn, table)?;

        // The columns actually present in the file, in schema order, taken
        // from the first row — every row of a table written by `read_table`
        // has the same keys, and a hand-edited one that does not is caught
        // below.
        let first = rows.first();
        let columns: Vec<String> = match first {
            Some(row) => schema
                .iter()
                .filter(|column| row.contains_key(*column))
                .cloned()
                .collect(),
            None => Vec::new(),
        };

        let mut values = Vec::with_capacity(rows.len());
        for (index, row) in rows.iter().enumerate() {
            for key in row.keys() {
                if !schema.iter().any(|column| column == key) {
                    return Err(ServiceError::validation(format!(
                        "The backup's `{table}` rows have a `{key}` column this version of \
                         Routine Launcher does not know about."
                    )));
                }
            }

            let mut row_values = Vec::with_capacity(columns.len());
            for column in &columns {
                let value = row.get(column).ok_or_else(|| {
                    ServiceError::validation(format!(
                        "Row {} of the backup's `{table}` is missing the `{column}` column that \
                         the rest of the table has.",
                        index + 1
                    ))
                })?;
                row_values.push(to_sql(value).map_err(|reason| {
                    ServiceError::validation(format!(
                        "Row {} of the backup's `{table}` has a `{column}` value that cannot be \
                         stored: {reason}",
                        index + 1
                    ))
                })?);
            }
            values.push(row_values);
        }

        plan.push(TablePlan {
            name: (*table).to_string(),
            columns,
            rows: values,
        });
    }

    Ok(plan)
}

/// The checks that decide whether a file is a backup this build can restore.
fn validate(conn: &Connection, backup: &Backup) -> ServiceResult<()> {
    if backup.format != BACKUP_FORMAT {
        return Err(ServiceError::validation(
            "That file is not a Routine Launcher backup.",
        ));
    }

    if backup.format_version > BACKUP_FORMAT_VERSION {
        return Err(ServiceError::validation(format!(
            "That backup is written in a newer format (version {}) than this build understands. \
             Update Routine Launcher and try again.",
            backup.format_version
        )));
    }

    let current = db::schema_version(conn)?;
    if backup.schema_version > current {
        return Err(ServiceError::validation(format!(
            "That backup was made by a newer version of Routine Launcher (database version {}, \
             this build is at {}). Update Routine Launcher and try again — importing it here \
             would drop whatever the newer version added.",
            backup.schema_version, current
        )));
    }

    for table in backup.tables.keys() {
        if !BACKUP_TABLES.contains(&table.as_str()) {
            return Err(ServiceError::validation(format!(
                "The backup contains a `{table}` section this version of Routine Launcher does \
                 not know about."
            )));
        }
    }

    Ok(())
}

/// Parses a backup file, saying which of the two things went wrong.
fn read_file(path: &str) -> ServiceResult<Backup> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| ServiceError::validation(format!("Could not read {path}: {e}")))?;

    serde_json::from_str(&text).map_err(|e| {
        ServiceError::validation(format!(
            "{path} is not a readable Routine Launcher backup: {e}"
        ))
    })
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

/// Wipes every trace of the user's data, leaving the database as a fresh
/// install has it.
///
/// Takes no arguments, and there is nothing partial it can be asked to do —
/// which is deliberate. Section 67 requires destructive actions to be user
/// initiated, and a function with no target cannot be called by mistake with
/// the wrong one; the confirmation that stands in front of it lives in the
/// Settings card that calls it.
pub fn reset(conn: &mut Connection) -> ServiceResult<()> {
    let tx = conn.transaction()?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
    db::rebuild(&tx)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Summarises a backup for the UI.
fn describe(path: &str, backup: &Backup) -> BackupInfo {
    let counts: Vec<TableCount> = BACKUP_TABLES
        .iter()
        .filter_map(|table| {
            backup.tables.get(*table).map(|rows| TableCount {
                table: (*table).to_string(),
                rows: rows.len() as i64,
            })
        })
        .collect();

    BackupInfo {
        path: path.to_string(),
        format_version: backup.format_version,
        schema_version: backup.schema_version,
        app_version: backup.app_version.clone(),
        exported_at: backup.exported_at.clone(),
        total_rows: counts.iter().map(|count| count.rows).sum(),
        counts,
        enables_command_actions: enables_command_actions(backup),
    }
}

/// Whether the backup's `settings` rows turn section 66's command actions on.
///
/// Read the same way `settings::get_bool` reads it — only the exact string
/// `"true"` counts — so a backup cannot enable commands through a value the
/// running app would have read as off.
fn enables_command_actions(backup: &Backup) -> bool {
    let Some(rows) = backup.tables.get("settings") else {
        return false;
    };

    rows.iter().any(|row| {
        row.get("key").and_then(JsonValue::as_str) == Some(COMMAND_ACTIONS_ENABLED_KEY)
            && row.get("value").and_then(JsonValue::as_str) == Some("true")
    })
}

/// The column names of `table`, in schema order.
fn table_columns(conn: &Connection, table: &str) -> ServiceResult<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", quote(table)))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if columns.is_empty() {
        return Err(ServiceError::validation(format!(
            "This database has no `{table}` table to restore into."
        )));
    }

    Ok(columns)
}

/// Wraps an identifier in double quotes, doubling any it contains.
///
/// Table and column names here come from `BACKUP_TABLES` and from
/// `PRAGMA table_info`, so neither is user input — but they are interpolated
/// into SQL, and an escaping rule that is applied everywhere is worth more
/// than an argument about which call sites need it.
fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

/// One SQLite value as JSON.
///
/// Blobs become arrays of byte numbers. No column in the current schema is a
/// blob, so this is only ever the fallback that keeps the conversion total —
/// but it is a *round-trippable* fallback, which base64 in a hand-readable
/// file would not be and a lossy stringification certainly would not.
fn to_json(value: SqlValue) -> JsonValue {
    match value {
        SqlValue::Null => JsonValue::Null,
        SqlValue::Integer(number) => JsonValue::from(number),
        SqlValue::Real(number) => serde_json::Number::from_f64(number)
            .map_or(JsonValue::Null, JsonValue::Number),
        SqlValue::Text(text) => JsonValue::String(text),
        SqlValue::Blob(bytes) => JsonValue::Array(bytes.into_iter().map(JsonValue::from).collect()),
    }
}

/// One JSON value back as SQLite, or why it cannot be.
fn to_sql(value: &JsonValue) -> Result<SqlValue, String> {
    match value {
        JsonValue::Null => Ok(SqlValue::Null),
        // JSON has no integer type of its own, so a `true` here is a value
        // some other tool wrote for a column SQLite stores as 0 or 1.
        JsonValue::Bool(flag) => Ok(SqlValue::Integer(i64::from(*flag))),
        JsonValue::Number(number) => {
            if let Some(integer) = number.as_i64() {
                Ok(SqlValue::Integer(integer))
            } else if let Some(float) = number.as_f64() {
                Ok(SqlValue::Real(float))
            } else {
                Err(format!("{number} is out of range"))
            }
        }
        JsonValue::String(text) => Ok(SqlValue::Text(text.clone())),
        JsonValue::Array(items) => {
            let mut bytes = Vec::with_capacity(items.len());
            for item in items {
                let byte = item
                    .as_u64()
                    .and_then(|number| u8::try_from(number).ok())
                    .ok_or_else(|| "a list of bytes was expected".to_string())?;
                bytes.push(byte);
            }
            Ok(SqlValue::Blob(bytes))
        }
        JsonValue::Object(_) => Err("an object cannot be stored in a column".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    /// Writes something into every table a backup carries, including the
    /// columns later migrations added, so a round trip that drops any of them
    /// fails rather than passing on a database that never used them.
    fn populate(conn: &Connection) {
        conn.execute_batch(
            "INSERT INTO settings (key, value) VALUES
                 ('routines.command_actions_enabled', 'true'),
                 ('widget.opacity', '0.85');

             INSERT INTO task_categories (name, color, icon) VALUES ('Deep Work', '#000', 'brain');

             INSERT INTO task_recurrence (frequency, interval, days_of_week, start_date)
             VALUES ('weekly', 2, 'MON,THU', '2026-01-05');

             INSERT INTO routines (name, description, icon, last_launched_at, launch_count)
             VALUES ('Start Coding', 'Editor and terminal', 'code', '2026-01-06 09:00:00', 7);

             INSERT INTO routine_actions (routine_id, type, target, arguments, sort_order, enabled)
             VALUES (1, 'application', 'C:/editor.exe', '--fast', 0, 1),
                    (1, 'url', 'https://example.test', NULL, 1, 0);

             -- Reminder columns are migration 0004's; preset/planned_seconds
             -- are 0003's; `key` on quests is 0006's.
             INSERT INTO tasks
                 (title, description, status, priority, category_id, due_date, due_time,
                  estimated_minutes, routine_id, recurrence_id, completed_at,
                  reminder_kind, reminder_minutes_before, reminder_fired_at)
             VALUES ('Ship the backup', 'Section 69', 'completed', 'high', 1, '2026-01-06',
                     '17:00', 90, 1, 1, '2026-01-06 16:12:00',
                     'minutes_before', 10, '2026-01-06 16:50:00');

             INSERT INTO tasks (title, status, priority, reminder_kind, reminder_time)
             VALUES ('Still open', 'todo', 'normal', 'at_time', '08:30');

             -- Migration 0008's. Rank order is not id order, so a restore
             -- that renumbered by id would show.
             INSERT INTO daily_plans (date, task_id, rank)
             VALUES ('2026-01-06', 2, 1), ('2026-01-06', 1, 2), ('2026-01-07', 2, 1);

             INSERT INTO focus_sessions
                 (task_id, routine_id, started_at, ended_at, duration_seconds, completed,
                  interrupted, preset, planned_seconds)
             VALUES (1, 1, '2026-01-06 14:00:00', '2026-01-06 14:25:00', 1500, 1, 0, 'pomodoro', 1500),
                    (NULL, NULL, '2026-01-06 15:00:00', NULL, NULL, 0, 1, 'stopwatch', NULL);

             INSERT INTO quests (type, title, description, difficulty, requirement, xp_reward,
                                 active_date, key)
             VALUES ('daily', 'Complete 3 tasks', NULL, 'medium', '3', 20, '2026-01-06', 'tasks-3');

             INSERT INTO quest_completions (quest_id, xp_awarded) VALUES (1, 20);

             INSERT INTO xp_transactions (source, source_id, amount)
             VALUES ('task_completion', 1, 10), ('quest', 1, 20);

             INSERT INTO user_achievements (achievement_id) VALUES (1);

             UPDATE streaks SET current_streak = 4, longest_streak = 9,
                                last_active_date = '2026-01-06' WHERE id = 1;

             INSERT INTO routine_launches (routine_id, launched_at)
             VALUES (1, '2026-01-06 09:00:00');

             -- Migration 0009's. Noon UTC, days apart, so the two stay on
             -- two different local days in every timezone the tests run in.
             INSERT INTO cleanup_actions (utility, action, item_count, created_at)
             VALUES ('downloads', 'move', 12, '2026-01-03 12:00:00'),
                    ('screenshots', 'organize', 40, '2026-01-06 12:00:00');",
        )
        .unwrap();
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("routine-launcher-backup-test-{name}.json"));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn a_backup_carries_every_table_and_every_column() {
        let conn = init_memory_db().unwrap();
        populate(&conn);

        let backup = snapshot(&conn, "0.1.0").unwrap();

        assert_eq!(backup.format, BACKUP_FORMAT);
        assert_eq!(backup.format_version, BACKUP_FORMAT_VERSION);
        for table in BACKUP_TABLES {
            assert!(
                backup.tables.contains_key(*table),
                "`{table}` is missing from the backup"
            );
        }

        // The columns migrations 0003, 0004 and 0006 added are in the file
        // without this module ever having named them.
        let task = &backup.tables["tasks"][0];
        assert_eq!(task["reminder_kind"], JsonValue::from("minutes_before"));
        assert_eq!(task["reminder_minutes_before"], JsonValue::from(10));
        let session = &backup.tables["focus_sessions"][0];
        assert_eq!(session["preset"], JsonValue::from("pomodoro"));
        assert_eq!(session["planned_seconds"], JsonValue::from(1500));
        assert_eq!(backup.tables["quests"][0]["key"], JsonValue::from("tasks-3"));

        // NULL survives as null rather than as an empty string, which is the
        // difference between "no reminder" and "a reminder at ''".
        assert_eq!(
            backup.tables["tasks"][1]["reminder_minutes_before"],
            JsonValue::Null
        );
    }

    #[test]
    fn export_and_import_round_trip_losslessly() {
        let mut conn = init_memory_db().unwrap();
        populate(&conn);

        let before = snapshot(&conn, "0.1.0").unwrap();
        let path = temp_path("round-trip");
        let written = export_to_file(&conn, "0.1.0", path.to_str().unwrap()).unwrap();
        assert!(written.total_rows > 0);

        // Somebody else's data, so a merge would be visible as leftovers.
        conn.execute_batch(
            "DELETE FROM tasks;
             DELETE FROM routines;
             INSERT INTO routines (name) VALUES ('Someone else''s routine');
             INSERT INTO tasks (title) VALUES ('Someone else''s task');",
        )
        .unwrap();

        let info = import_from_file(&mut conn, path.to_str().unwrap()).unwrap();
        assert_eq!(info.total_rows, written.total_rows);

        let after = snapshot(&conn, "0.1.0").unwrap();
        assert_eq!(
            after.tables, before.tables,
            "every table should come back exactly as it went out"
        );

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_days_top_priorities_round_trip() {
        // PLAN TODAY's picks (migration 0008), read back through the service
        // that draws them, so what is checked is the order the panel shows.
        use crate::services::daily_plans;

        let mut conn = init_memory_db().unwrap();
        populate(&conn);
        assert_eq!(daily_plans::get(&conn, "2026-01-06").unwrap().task_ids, vec![2, 1]);

        let path = temp_path("daily-plans");
        let written = export_to_file(&conn, "0.1.0", path.to_str().unwrap()).unwrap();
        assert_eq!(
            written
                .counts
                .iter()
                .find(|count| count.table == "daily_plans")
                .map(|count| count.rows),
            Some(3)
        );

        daily_plans::set(&conn, "2026-01-06", vec![1]).unwrap();
        daily_plans::set(&conn, "2026-01-07", Vec::new()).unwrap();

        import_from_file(&mut conn, path.to_str().unwrap()).unwrap();

        assert_eq!(daily_plans::get(&conn, "2026-01-06").unwrap().task_ids, vec![2, 1]);
        assert_eq!(daily_plans::get(&conn, "2026-01-07").unwrap().task_ids, vec![2]);

        // A backup written before 0008 has no `daily_plans` at all. It still
        // restores, with no priorities rather than a refusal.
        let mut older = snapshot(&conn, "0.1.4").unwrap();
        older.tables.remove("daily_plans");
        older.schema_version = 7;
        std::fs::write(&path, serde_json::to_string(&older).unwrap()).unwrap();

        import_from_file(&mut conn, path.to_str().unwrap()).unwrap();
        assert!(daily_plans::get(&conn, "2026-01-06").unwrap().task_ids.is_empty());

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn the_cleanup_record_round_trips_and_an_older_backup_restores_without_it() {
        // Migration 0009's table, read back through the achievement that
        // counts it, so what is checked is what the user would see.
        let mut conn = init_memory_db().unwrap();
        populate(&conn);
        let organized_days = |conn: &Connection| -> i64 {
            crate::services::xp::list_achievements(conn)
                .unwrap()
                .into_iter()
                .find(|a| a.key == "organized")
                .and_then(|a| a.progress)
                .map(|progress| progress.current)
                .unwrap()
        };
        assert_eq!(organized_days(&conn), 2);

        let path = temp_path("cleanup-actions");
        export_to_file(&conn, "0.1.0", path.to_str().unwrap()).unwrap();

        conn.execute("DELETE FROM cleanup_actions", []).unwrap();
        import_from_file(&mut conn, path.to_str().unwrap()).unwrap();
        assert_eq!(organized_days(&conn), 2);

        // A backup written before 0009 has no `cleanup_actions` at all. It
        // still restores, with no cleanup on record rather than a refusal.
        let mut older = snapshot(&conn, "0.1.4").unwrap();
        older.tables.remove("cleanup_actions");
        older.schema_version = 8;
        std::fs::write(&path, serde_json::to_string(&older).unwrap()).unwrap();

        import_from_file(&mut conn, path.to_str().unwrap()).unwrap();
        assert_eq!(organized_days(&conn), 0);

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn importing_replaces_rather_than_merges() {
        let mut conn = init_memory_db().unwrap();
        populate(&conn);

        let path = temp_path("replace");
        export_to_file(&conn, "0.1.0", path.to_str().unwrap()).unwrap();

        conn.execute_batch("INSERT INTO routines (name) VALUES ('Added afterwards');")
            .unwrap();
        let extra: i64 = conn
            .query_row("SELECT COUNT(*) FROM routines", [], |row| row.get(0))
            .unwrap();
        assert_eq!(extra, 2);

        import_from_file(&mut conn, path.to_str().unwrap()).unwrap();

        let names: Vec<String> = conn
            .prepare("SELECT name FROM routines ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(names, vec!["Start Coding".to_string()]);

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn importing_keeps_ids_so_references_still_point_at_the_right_rows() {
        let mut conn = init_memory_db().unwrap();
        populate(&conn);

        let path = temp_path("references");
        export_to_file(&conn, "0.1.0", path.to_str().unwrap()).unwrap();
        import_from_file(&mut conn, path.to_str().unwrap()).unwrap();

        let (task_title, routine_name): (String, String) = conn
            .query_row(
                "SELECT t.title, r.name
                   FROM focus_sessions s
                   JOIN tasks t ON t.id = s.task_id
                   JOIN routines r ON r.id = s.routine_id
                  WHERE s.id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(task_title, "Ship the backup");
        assert_eq!(routine_name, "Start Coding");

        // And the next insert does not collide with a restored id.
        conn.execute("INSERT INTO routines (name) VALUES ('Next')", [])
            .unwrap();
        let next: i64 = conn
            .query_row("SELECT id FROM routines WHERE name = 'Next'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(next > 1, "a new routine should not reuse a restored id");

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_backup_from_a_newer_schema_is_refused_before_anything_is_touched() {
        let mut conn = init_memory_db().unwrap();
        populate(&conn);

        let mut backup = snapshot(&conn, "9.9.9").unwrap();
        backup.schema_version = 999;

        let path = temp_path("from-the-future");
        std::fs::write(&path, serde_json::to_string(&backup).unwrap()).unwrap();

        let error = import_from_file(&mut conn, path.to_str().unwrap()).unwrap_err();
        assert!(
            error.to_string().contains("newer version"),
            "unexpected message: {error}"
        );

        // Refused, and the existing data is still there.
        let tasks: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tasks, 2);

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_file_that_is_not_a_backup_is_refused() {
        let mut conn = init_memory_db().unwrap();

        let path = temp_path("not-a-backup");
        std::fs::write(&path, r#"{"hello": "world"}"#).unwrap();
        assert!(import_from_file(&mut conn, path.to_str().unwrap()).is_err());

        std::fs::write(&path, r#"{"format":"something-else","formatVersion":1,"schemaVersion":1,"appVersion":"1","exportedAt":"","tables":{}}"#).unwrap();
        let error = import_from_file(&mut conn, path.to_str().unwrap()).unwrap_err();
        assert!(error.to_string().contains("not a Routine Launcher backup"));

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_backup_whose_rows_do_not_line_up_is_rolled_back() {
        let mut conn = init_memory_db().unwrap();
        populate(&conn);

        let mut backup = snapshot(&conn, "0.1.0").unwrap();
        // A focus session pointing at a task the backup does not carry. The
        // column is nullable but the reference is not optional: SQLite has to
        // reject it, and the rejection has to arrive as a rollback.
        backup.tables.get_mut("focus_sessions").unwrap()[0]
            .insert("task_id".to_string(), JsonValue::from(4242));

        let path = temp_path("dangling");
        std::fs::write(&path, serde_json::to_string(&backup).unwrap()).unwrap();

        let error = import_from_file(&mut conn, path.to_str().unwrap()).unwrap_err();
        assert!(
            error.to_string().contains("nothing was changed"),
            "unexpected message: {error}"
        );

        let title: String = conn
            .query_row("SELECT title FROM tasks WHERE id = 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(title, "Ship the backup");

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn inspecting_a_backup_describes_it_without_importing_it() {
        let conn = init_memory_db().unwrap();
        populate(&conn);

        let path = temp_path("inspect");
        export_to_file(&conn, "0.4.2", path.to_str().unwrap()).unwrap();

        conn.execute_batch("DELETE FROM tasks;").unwrap();

        let info = inspect_file(&conn, path.to_str().unwrap()).unwrap();
        assert_eq!(info.app_version, "0.4.2");
        assert_eq!(info.schema_version, db::schema_version(&conn).unwrap());
        assert_eq!(
            info.counts
                .iter()
                .find(|count| count.table == "tasks")
                .unwrap()
                .rows,
            2
        );
        // Reading the file changed nothing.
        let tasks: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tasks, 0);

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_backup_that_would_switch_command_actions_on_says_so() {
        let conn = init_memory_db().unwrap();
        populate(&conn);
        assert!(enables_command_actions(&snapshot(&conn, "0.1.0").unwrap()));

        // Only the exact string the running app reads as enabled counts.
        for stored in ["false", "TRUE", "1", ""] {
            conn.execute(
                "UPDATE settings SET value = ?1 WHERE key = 'routines.command_actions_enabled'",
                [stored],
            )
            .unwrap();
            assert!(
                !enables_command_actions(&snapshot(&conn, "0.1.0").unwrap()),
                "{stored:?} must not read as enabled"
            );
        }
    }

    #[test]
    fn a_table_the_backup_does_not_carry_keeps_the_fresh_installs_rows() {
        let mut conn = init_memory_db().unwrap();
        populate(&conn);

        let mut backup = snapshot(&conn, "0.1.0").unwrap();
        // As a backup written before `achievements` was seeded would look.
        backup.tables.remove("achievements");
        backup.tables.remove("user_achievements");

        let path = temp_path("older-format");
        std::fs::write(&path, serde_json::to_string(&backup).unwrap()).unwrap();

        let info = import_from_file(&mut conn, path.to_str().unwrap()).unwrap();
        assert!(!info.counts.iter().any(|count| count.table == "achievements"));

        let seeded: i64 = conn
            .query_row("SELECT COUNT(*) FROM achievements", [], |row| row.get(0))
            .unwrap();
        assert_eq!(seeded, 6, "the seeded achievements should still be there");

        std::fs::remove_file(path).unwrap();
    }

    /// The columns whose value is "whenever this row happened to be written".
    ///
    /// Only [`without_write_times`] uses this — see there for why comparing
    /// two databases means comparing everything except these.
    const WRITE_TIME_COLUMNS: [&str; 2] = ["created_at", "updated_at"];

    /// A snapshot's tables with the write-time columns blanked.
    ///
    /// Two databases built from the same migrations a moment apart are the
    /// same database, but their seed rows do not carry the same timestamps:
    /// the defaults are `datetime('now')`, evaluated per statement, so a
    /// rebuild that starts at `09:00:00.996` stamps `task_categories` with
    /// one second and `achievements` with the next. Comparing the stamps
    /// would make the test fail roughly once per thousand runs on nothing —
    /// and, worse, pass for the wrong reason the rest of the time. Every
    /// other column is still compared, so a reset that lost a seed row, kept
    /// a user's row, or reordered anything still fails.
    fn without_write_times(
        tables: &BTreeMap<String, Vec<JsonMap<String, JsonValue>>>,
    ) -> BTreeMap<String, Vec<JsonMap<String, JsonValue>>> {
        tables
            .iter()
            .map(|(table, rows)| {
                let rows = rows
                    .iter()
                    .map(|row| {
                        let mut row = row.clone();
                        for column in WRITE_TIME_COLUMNS {
                            if let Some(value) = row.get_mut(column) {
                                *value = JsonValue::Null;
                            }
                        }
                        row
                    })
                    .collect();
                (table.clone(), rows)
            })
            .collect()
    }

    #[test]
    fn reset_leaves_the_database_as_a_fresh_install() {
        let mut conn = init_memory_db().unwrap();
        populate(&conn);

        reset(&mut conn).unwrap();

        let fresh = init_memory_db().unwrap();
        let after = snapshot(&conn, "0.1.0").unwrap();
        let expected = snapshot(&fresh, "0.1.0").unwrap();
        assert_eq!(
            without_write_times(&after.tables),
            without_write_times(&expected.tables)
        );
        assert_eq!(
            after.tables.keys().collect::<Vec<_>>(),
            expected.tables.keys().collect::<Vec<_>>(),
            "the same tables, not merely the same contents"
        );
        assert_eq!(after.schema_version, expected.schema_version);

        // Including the counter behind new rows: a reset user's first task is
        // task 1, not task 3.
        conn.execute("INSERT INTO tasks (title) VALUES ('First')", [])
            .unwrap();
        let id: i64 = conn
            .query_row("SELECT id FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(id, 1);
    }

    #[test]
    fn exporting_to_a_folder_that_does_not_exist_says_so() {
        let conn = init_memory_db().unwrap();
        let missing = std::env::temp_dir()
            .join("routine-launcher-no-such-folder")
            .join(BACKUP_FILE_NAME);

        let error = export_to_file(&conn, "0.1.0", missing.to_str().unwrap()).unwrap_err();
        assert!(error.to_string().contains("no folder"));
    }
}
