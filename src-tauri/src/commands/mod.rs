//! Tauri commands: the thin `invoke`-able boundary between the React
//! frontend and the Rust backend. Commands should only parse arguments,
//! call a service function, and map errors to `String` — no SQL and no
//! business logic here (see development-plan.md section 86).

pub mod health;
pub mod task_categories;
pub mod task_recurrence;
pub mod tasks;
