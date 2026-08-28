//! Application services: the layer that owns actual SQL and business logic.
//!
//! Per the layering rule in development-plan.md section 86
//! (React UI -> Service -> Tauri Command -> Rust implementation -> SQLite),
//! Tauri commands (`src-tauri/src/commands/`) should stay thin — they parse
//! input, call into a service function here, and map the result to
//! `Result<T, String>` for the frontend. Feature services (tasks, routines,
//! focus, quests, xp, ...) are added here alongside their features.
//!
//! `error` holds the `ServiceError` every service returns, `serde_util` holds
//! the serde helpers their payload structs share, and `validate` holds the
//! input checks (dates, times, blank text) more than one service needs.

pub mod error;
pub mod health;
pub mod serde_util;
pub mod task_categories;
pub mod task_recurrence;
pub mod tasks;
pub mod validate;
