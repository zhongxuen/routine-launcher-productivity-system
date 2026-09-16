//! Shared routine templates (development-plan.md section 92 Tier 5).
//!
//! A routine is exported to a small, readable `.routine.json` file, and a file
//! like that can be imported as a new routine. That is the whole of sharing:
//! the file travels however the user already sends files — email, a chat, a
//! shared drive — and this app never uploads anything (sections 56, 68).
//!
//! # A shared file is someone else's routine
//!
//! Importing runs nothing, and three things keep it that way:
//!
//! * **Show, then act.** [`inspect_file`] reads and validates the file and
//!   describes every action without creating anything; only
//!   [`import_from_file`] creates the routine, after the user has seen that
//!   description. The same scan / show / confirm / act as section 67 and
//!   section 69's import.
//! * **Commands arrive switched off.** Section 66: a command must be
//!   explicitly configured by the user. A `command` action in a shared file
//!   was configured by somebody else, so it is imported disabled whatever the
//!   file says, and the user turns it on in the builder once they have read
//!   it. The destructive-command guardrail still applies on the way in.
//! * **Every target is validated** by the same rules the builder uses
//!   (`routines::validate_target`), so a file cannot smuggle in a
//!   `javascript:` URL or a zero-minute timer.
//!
//! Paths are not rewritten. `C:\Users\alex\...` is wrong on anyone else's
//! machine, so the preview marks a path that does not exist here, and the
//! import opens the builder, where it can be re-pointed before the first
//! launch — the same advice the built-in templates give.

use std::path::Path;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::error::{ServiceError, ServiceResult};
use super::routines::{self, NewRoutine, NewRoutineAction, Routine, RoutineActionType};

/// Marks the file as a shared routine.
pub const ROUTINE_FILE_FORMAT: &str = "routine-launcher-routine";
/// The envelope's version. A file with a larger one is refused.
pub const ROUTINE_FILE_FORMAT_VERSION: i64 = 1;
/// Suffix of the file name export suggests.
pub const ROUTINE_FILE_SUFFIX: &str = ".routine.json";

/// The most actions a shared routine may carry. Far more than any routine
/// needs; it only stops a hostile file from being a very long one.
const MAX_ACTIONS: usize = 100;
/// Files larger than this are not routines.
const MAX_FILE_BYTES: u64 = 256 * 1024;

/// One action as it travels in the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedAction {
    #[serde(rename = "type")]
    pub action_type: RoutineActionType,
    pub target: String,
    #[serde(default)]
    pub arguments: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

/// The routine as it travels in the file. No ids, no launch counts, no dates:
/// only what someone else needs to rebuild it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedRoutine {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    pub actions: Vec<SharedAction>,
}

/// The whole file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineFile {
    pub format: String,
    pub format_version: i64,
    pub app_version: String,
    pub routine: SharedRoutine,
}

/// One action as the import preview shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAction {
    #[serde(rename = "type")]
    pub action_type: RoutineActionType,
    /// Normalised the way it will be stored.
    pub target: String,
    pub arguments: Option<String>,
    /// Whether it will be imported enabled.
    pub enabled: bool,
    /// Something the user should know before importing, or null.
    pub note: Option<String>,
}

/// What importing a file would create.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutinePreview {
    pub path: String,
    /// The name the routine will be created with, after any de-duplication.
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub app_version: String,
    pub actions: Vec<PreviewAction>,
    /// How many `command` actions will arrive switched off.
    pub commands_disabled: usize,
    /// How many file, folder or application paths do not exist here.
    pub missing_paths: usize,
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// The file name export suggests for a routine: its name, made safe for
/// Windows, plus [`ROUTINE_FILE_SUFFIX`].
pub fn suggested_file_name(routine_name: &str) -> String {
    let cleaned: String = routine_name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_') { c } else { ' ' })
        .collect();
    let joined = cleaned.split_whitespace().collect::<Vec<_>>().join("-");
    let stem = if joined.is_empty() { "routine".to_string() } else { joined.to_lowercase() };
    format!("{stem}{ROUTINE_FILE_SUFFIX}")
}

/// The file for routine `id`, without writing it.
pub fn build_file(conn: &Connection, id: i64, app_version: &str) -> ServiceResult<RoutineFile> {
    let routine = routines::get(conn, id)?
        .ok_or_else(|| ServiceError::not_found(format!("Routine {id} was not found.")))?;

    Ok(RoutineFile {
        format: ROUTINE_FILE_FORMAT.to_string(),
        format_version: ROUTINE_FILE_FORMAT_VERSION,
        app_version: app_version.to_string(),
        routine: SharedRoutine {
            name: routine.name,
            description: routine.description,
            icon: routine.icon,
            actions: routine
                .actions
                .into_iter()
                .map(|action| SharedAction {
                    action_type: action.action_type,
                    target: action.target,
                    arguments: action.arguments,
                    enabled: action.enabled,
                })
                .collect(),
        },
    })
}

/// Writes routine `id` to `path`.
pub fn export_to_file(conn: &Connection, id: i64, app_version: &str, path: &str) -> ServiceResult<()> {
    let file = build_file(conn, id, app_version)?;
    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| ServiceError::validation(format!("Could not build the routine file: {e}")))?;
    std::fs::write(path, json)
        .map_err(|e| ServiceError::validation(format!("Could not write {path}: {e}")))
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Reads and checks a shared routine file, and describes what importing it
/// would create. Creates nothing.
pub fn inspect_file(conn: &Connection, path: &str) -> ServiceResult<RoutinePreview> {
    let file = read_file(path)?;
    preview(conn, path, &file)
}

/// Creates a routine from a shared file. Commands arrive disabled.
pub fn import_from_file(conn: &Connection, path: &str) -> ServiceResult<Routine> {
    let file = read_file(path)?;
    let preview = preview(conn, path, &file)?;

    routines::create(
        conn,
        NewRoutine {
            name: preview.name,
            description: preview.description,
            icon: preview.icon,
            actions: preview
                .actions
                .into_iter()
                .map(|action| NewRoutineAction {
                    action_type: action.action_type,
                    target: action.target,
                    arguments: action.arguments,
                    sort_order: None,
                    enabled: Some(action.enabled),
                })
                .collect(),
        },
    )
}

fn read_file(path: &str) -> ServiceResult<RoutineFile> {
    let size = std::fs::metadata(path)
        .map_err(|e| ServiceError::validation(format!("Could not read {path}: {e}")))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(ServiceError::validation(
            "That file is too large to be a shared routine.",
        ));
    }

    let text = std::fs::read_to_string(path)
        .map_err(|e| ServiceError::validation(format!("Could not read {path}: {e}")))?;
    parse(&text)
}

/// Parses and checks the envelope.
pub fn parse(text: &str) -> ServiceResult<RoutineFile> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| ServiceError::validation("That file is not a shared Routine Launcher routine."))?;
    if value.get("format").and_then(|format| format.as_str()) != Some(ROUTINE_FILE_FORMAT) {
        return Err(ServiceError::validation(
            "That file is not a shared Routine Launcher routine.",
        ));
    }

    let file: RoutineFile = serde_json::from_value(value).map_err(|e| {
        ServiceError::validation(format!("That routine file could not be read: {e}"))
    })?;

    if file.format_version > ROUTINE_FILE_FORMAT_VERSION {
        return Err(ServiceError::validation(
            "That routine was shared from a newer version of Routine Launcher. Update the app \
             and try again.",
        ));
    }
    if file.routine.actions.len() > MAX_ACTIONS {
        return Err(ServiceError::validation(format!(
            "A shared routine can have at most {MAX_ACTIONS} actions."
        )));
    }
    Ok(file)
}

fn preview(conn: &Connection, path: &str, file: &RoutineFile) -> ServiceResult<RoutinePreview> {
    let routine = &file.routine;
    let base_name = routine.name.trim();
    if base_name.is_empty() {
        return Err(ServiceError::validation("The shared routine has no name."));
    }

    let mut actions = Vec::with_capacity(routine.actions.len());
    let mut commands_disabled = 0;
    let mut missing_paths = 0;

    for (index, action) in routine.actions.iter().enumerate() {
        let target = routines::validate_target(action.action_type, &action.target).map_err(|error| {
            ServiceError::validation(format!("Action {} of the shared routine: {error}", index + 1))
        })?;

        let mut enabled = action.enabled;
        let mut note = None;

        match action.action_type {
            RoutineActionType::Command => {
                if enabled {
                    commands_disabled += 1;
                }
                enabled = false;
                note = Some(
                    "Imported switched off. Read the command, then turn it on in the builder."
                        .to_string(),
                );
            }
            RoutineActionType::Application | RoutineActionType::File | RoutineActionType::Folder => {
                if looks_like_path(&target) && !Path::new(&target).exists() {
                    missing_paths += 1;
                    note = Some("Not found on this computer. Point it at the right place before launching.".to_string());
                }
            }
            RoutineActionType::Url | RoutineActionType::Timer => {}
        }

        actions.push(PreviewAction {
            action_type: action.action_type,
            target,
            arguments: action
                .arguments
                .as_deref()
                .map(str::trim)
                .filter(|arguments| !arguments.is_empty())
                .map(str::to_owned),
            enabled,
            note,
        });
    }

    Ok(RoutinePreview {
        path: path.to_string(),
        name: unique_name(conn, base_name)?,
        description: routine.description.clone(),
        icon: routine.icon.clone(),
        app_version: file.app_version.clone(),
        actions,
        commands_disabled,
        missing_paths,
    })
}

/// A target that names a place on disk rather than a program on `PATH`.
fn looks_like_path(target: &str) -> bool {
    target.contains('\\') || target.contains('/') || target.chars().nth(1) == Some(':')
}

/// `name`, or `name (2)`, `name (3)` … if a routine is already called that.
fn unique_name(conn: &Connection, name: &str) -> ServiceResult<String> {
    let taken = |candidate: &str| -> ServiceResult<bool> {
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM routines WHERE lower(name) = lower(?1))",
            [candidate],
            |row| row.get(0),
        )?)
    };

    if !taken(name)? {
        return Ok(name.to_string());
    }
    for n in 2.. {
        let candidate = format!("{name} ({n})");
        if !taken(&candidate)? {
            return Ok(candidate);
        }
    }
    unreachable!("an unbounded range always yields a free name")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    fn temp_path(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("routine-launcher-share-test-{name}.routine.json"));
        let _ = std::fs::remove_file(&path);
        path.to_string_lossy().into_owned()
    }

    fn coding_routine(conn: &Connection) -> i64 {
        routines::create(
            conn,
            serde_json::from_value(serde_json::json!({
                "name": "Coding Mode",
                "description": "Editor, docs, focus",
                "icon": "💻",
                "actions": [
                    { "type": "application", "target": "code" },
                    { "type": "url", "target": "https://docs.rs" },
                    { "type": "command", "target": "git status", "enabled": true },
                    { "type": "folder", "target": r"C:\Definitely\Not\Here" },
                    { "type": "timer", "target": "25", "enabled": false }
                ]
            }))
            .unwrap(),
        )
        .unwrap()
        .id
    }

    #[test]
    fn a_routine_round_trips_with_commands_switched_off_and_a_fresh_name() {
        let conn = init_memory_db().unwrap();
        let id = coding_routine(&conn);
        let path = temp_path("round-trip");
        export_to_file(&conn, id, "0.1.5", &path).unwrap();

        let preview = inspect_file(&conn, &path).unwrap();
        assert_eq!(preview.name, "Coding Mode (2)", "the original is still there");
        assert_eq!(preview.commands_disabled, 1);
        assert_eq!(preview.missing_paths, 1);
        assert!(preview.actions[2].note.is_some());
        let routines_before = routines::list(&conn).unwrap().len();
        assert_eq!(routines_before, 1, "inspecting creates nothing");

        let imported = import_from_file(&conn, &path).unwrap();
        assert_eq!(imported.name, "Coding Mode (2)");
        assert_eq!(imported.icon.as_deref(), Some("💻"));
        let types: Vec<_> = imported.actions.iter().map(|a| a.action_type).collect();
        assert_eq!(
            types,
            [
                RoutineActionType::Application,
                RoutineActionType::Url,
                RoutineActionType::Command,
                RoutineActionType::Folder,
                RoutineActionType::Timer
            ]
        );
        let enabled: Vec<bool> = imported.actions.iter().map(|a| a.enabled).collect();
        assert_eq!(enabled, [true, true, false, true, false]);

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn the_file_carries_no_ids_or_history() {
        let conn = init_memory_db().unwrap();
        let id = coding_routine(&conn);
        let json = serde_json::to_value(build_file(&conn, id, "0.1.5").unwrap()).unwrap();
        let text = json.to_string();
        for field in ["\"id\"", "launch_count", "last_launched_at", "routine_id", "sort_order"] {
            assert!(!text.contains(field), "{field} should not be shared");
        }
        assert_eq!(json["format"], ROUTINE_FILE_FORMAT);
    }

    #[test]
    fn unsafe_or_foreign_files_are_refused() {
        assert!(parse("not json").is_err());
        assert!(parse(r#"{"format":"routine-launcher-backup"}"#).is_err());
        assert!(parse(
            r#"{"format":"routine-launcher-routine","formatVersion":9,"appVersion":"9",
                "routine":{"name":"x","actions":[]}}"#
        )
        .unwrap_err()
        .to_string()
        .contains("newer version"));

        let conn = init_memory_db().unwrap();
        let path = temp_path("unsafe");
        std::fs::write(
            &path,
            r#"{"format":"routine-launcher-routine","formatVersion":1,"appVersion":"1",
                "routine":{"name":"Sneaky","actions":[{"type":"url","target":"javascript:alert(1)"}]}}"#,
        )
        .unwrap();
        assert!(inspect_file(&conn, &path).is_err());
        assert!(import_from_file(&conn, &path).is_err());
        assert!(routines::list(&conn).unwrap().is_empty());

        std::fs::write(
            &path,
            r#"{"format":"routine-launcher-routine","formatVersion":1,"appVersion":"1",
                "routine":{"name":"Wipe","actions":[{"type":"command","target":"format c: /q"}]}}"#,
        )
        .unwrap();
        assert!(import_from_file(&conn, &path).is_err(), "the command guardrail still applies");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn suggested_file_names_are_safe() {
        assert_eq!(suggested_file_name("Coding Mode"), "coding-mode.routine.json");
        assert_eq!(suggested_file_name(r"a/b\c:d*"), "a-b-c-d.routine.json");
        assert_eq!(suggested_file_name("  "), "routine.routine.json");
    }
}
