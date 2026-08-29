//! Application services: the layer that owns actual SQL and business logic.
//!
//! Per the layering rule in development-plan.md section 86
//! (React UI -> Service -> Tauri Command -> Rust implementation -> SQLite),
//! Tauri commands (`src-tauri/src/commands/`) should stay thin — they parse
//! input, call into a service function here, and map the result to
//! `Result<T, String>` for the frontend. Feature services (tasks, routines,
//! focus, quests, xp, ...) are added here alongside their features.
//!
//! `error` holds the `ServiceError` every service returns, `settings` holds
//! typed access to the key/value `settings` table, `serde_util` holds
//! the serde helpers their payload structs share, and `validate` holds the
//! input checks (dates, times, blank text) more than one service needs.
//!
//! `reminders` is the one service that writes columns on a table another
//! service owns — the `reminder_*` columns on `tasks` — and says why in its
//! own module docs. `notifications` beside it holds the wording of what a
//! reminder, or a finished focus session, actually says; delivering it is
//! `commands/notification.rs`'s job, because talking to the OS needs the
//! Tauri runtime and services stay free of it.

pub mod error;
pub mod focus;
pub mod health;
pub mod notifications;
pub mod popup;
pub mod reminders;
pub mod routine_exec;
pub mod routines;
pub mod serde_util;
pub mod settings;
pub mod task_categories;
pub mod task_recurrence;
pub mod tasks;
pub mod validate;
