//! Task category persistence.
//!
//! The seven categories from development-plan.md section 13 (Work, Study,
//! Personal, Coding, Admin, Errands, Other) are inserted once by migration
//! `0002_seed_task_categories.sql`. They are ordinary rows from then on:
//! nothing here treats them differently from a category the user made, so
//! they can be renamed, recoloured or deleted like any other.
//!
//! Deleting a category does not delete its tasks — `tasks.category_id` is
//! `ON DELETE SET NULL`, so those tasks fall back into the uncategorised
//! pile.

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::error::{ServiceError, ServiceResult};
use super::serde_util::double_option;

const CATEGORY_COLUMNS: &str = "id, name, color, icon, created_at";

/// Colours are hex strings (`#3b82f6`) and icons are lucide-react icon names
/// (`briefcase`), both stored verbatim so the UI can render a category
/// straight from the row.
#[derive(Debug, Clone, Serialize)]
pub struct TaskCategory {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub created_at: String,
}

impl TaskCategory {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            color: row.get("color")?,
            icon: row.get("icon")?,
            created_at: row.get("created_at")?,
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct NewTaskCategory {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

/// A partial update: omitted fields are left alone, and `color`/`icon` can be
/// cleared by passing null.
#[derive(Debug, Default, Deserialize)]
pub struct TaskCategoryUpdate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub icon: Option<Option<String>>,
}

/// Ordered by id so the section 13 defaults keep their listed order and
/// user-created categories append to the end.
pub fn list(conn: &Connection) -> ServiceResult<Vec<TaskCategory>> {
    let sql = format!("SELECT {CATEGORY_COLUMNS} FROM task_categories ORDER BY id");
    let mut statement = conn.prepare(&sql)?;
    let categories = statement
        .query_map([], TaskCategory::from_row)?
        .collect::<rusqlite::Result<Vec<TaskCategory>>>()?;

    Ok(categories)
}

pub fn get(conn: &Connection, id: i64) -> ServiceResult<Option<TaskCategory>> {
    let sql = format!("SELECT {CATEGORY_COLUMNS} FROM task_categories WHERE id = ?1");
    conn.query_row(&sql, params![id], TaskCategory::from_row)
        .optional()
        .map_err(ServiceError::from)
}

pub fn create(conn: &Connection, new_category: NewTaskCategory) -> ServiceResult<TaskCategory> {
    let name = validate_name(&new_category.name)?;
    let color = normalize_text(new_category.color);
    let icon = normalize_text(new_category.icon);

    conn.execute(
        "INSERT INTO task_categories (name, color, icon) VALUES (?1, ?2, ?3)",
        params![name, color, icon],
    )
    .map_err(|err| ServiceError::from_constraint(err, duplicate_name(&name)))?;

    let id = conn.last_insert_rowid();
    get(conn, id)?.ok_or_else(|| category_not_found(id))
}

pub fn update(
    conn: &Connection,
    id: i64,
    update: TaskCategoryUpdate,
) -> ServiceResult<TaskCategory> {
    let existing = get(conn, id)?.ok_or_else(|| category_not_found(id))?;

    let mut assignments: Vec<&str> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    let mut next_name = existing.name.clone();

    if let Some(name) = update.name {
        next_name = validate_name(&name)?;
        assignments.push("name = ?");
        values.push(Value::Text(next_name.clone()));
    }

    if let Some(color) = update.color {
        assignments.push("color = ?");
        values.push(optional_text(normalize_text(color)));
    }

    if let Some(icon) = update.icon {
        assignments.push("icon = ?");
        values.push(optional_text(normalize_text(icon)));
    }

    if assignments.is_empty() {
        return Ok(existing);
    }

    values.push(Value::Integer(id));
    let sql = format!(
        "UPDATE task_categories SET {} WHERE id = ?",
        assignments.join(", ")
    );
    conn.execute(&sql, params_from_iter(values))
        .map_err(|err| ServiceError::from_constraint(err, duplicate_name(&next_name)))?;

    get(conn, id)?.ok_or_else(|| category_not_found(id))
}

/// Deletes the category. Tasks that used it become uncategorised rather than
/// being deleted with it.
pub fn delete(conn: &Connection, id: i64) -> ServiceResult<()> {
    let deleted = conn.execute("DELETE FROM task_categories WHERE id = ?1", params![id])?;
    if deleted == 0 {
        return Err(category_not_found(id));
    }
    Ok(())
}

fn category_not_found(id: i64) -> ServiceError {
    ServiceError::not_found(format!("Task category {id} was not found."))
}

fn duplicate_name(name: &str) -> String {
    format!("A category named {name:?} already exists.")
}

fn validate_name(name: &str) -> ServiceResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ServiceError::validation("A category needs a name."));
    }
    Ok(name.to_owned())
}

fn normalize_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

fn optional_text(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::Text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    #[test]
    fn seeds_the_default_categories_in_section_13_order() {
        let conn = init_memory_db().unwrap();
        let names: Vec<String> = list(&conn).unwrap().into_iter().map(|c| c.name).collect();

        assert_eq!(
            names,
            vec!["Work", "Study", "Personal", "Coding", "Admin", "Errands", "Other"]
        );
    }

    #[test]
    fn creates_and_updates_a_custom_category() {
        let conn = init_memory_db().unwrap();

        let created = create(
            &conn,
            NewTaskCategory {
                name: "  Fitness  ".to_owned(),
                color: Some("#ef4444".to_owned()),
                icon: Some(String::new()),
            },
        )
        .unwrap();

        assert_eq!(created.name, "Fitness");
        assert_eq!(created.color.as_deref(), Some("#ef4444"));
        assert_eq!(created.icon, None, "blank icon should store as NULL");

        let updated = update(
            &conn,
            created.id,
            TaskCategoryUpdate {
                name: Some("Health".to_owned()),
                color: Some(None),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(updated.name, "Health");
        assert_eq!(updated.color, None, "explicit null should clear the colour");
    }

    #[test]
    fn rejects_blank_and_duplicate_names() {
        let conn = init_memory_db().unwrap();

        let blank = create(
            &conn,
            NewTaskCategory { name: "   ".to_owned(), color: None, icon: None },
        );
        assert!(matches!(blank, Err(ServiceError::Validation(_))));

        let duplicate = create(
            &conn,
            NewTaskCategory { name: "Work".to_owned(), color: None, icon: None },
        );
        assert!(matches!(duplicate, Err(ServiceError::Validation(_))));
    }

    #[test]
    fn deleting_a_category_uncategorises_its_tasks_instead_of_deleting_them() {
        let conn = init_memory_db().unwrap();
        let category = get(&conn, 1).unwrap().unwrap();

        let task = crate::services::tasks::create(
            &conn,
            serde_json::from_value(serde_json::json!({
                "title": "Write the report",
                "category_id": category.id,
            }))
            .unwrap(),
        )
        .unwrap();

        delete(&conn, category.id).unwrap();

        let orphaned = crate::services::tasks::get(&conn, task.id).unwrap().unwrap();
        assert_eq!(orphaned.category_id, None);
        assert!(matches!(delete(&conn, category.id), Err(ServiceError::NotFound(_))));
    }
}
