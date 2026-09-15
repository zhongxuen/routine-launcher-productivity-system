//! Tauri commands: the thin `invoke`-able boundary between the React
//! frontend and the Rust backend. Commands should only parse arguments,
//! call a service function, and map errors to `String` — no SQL and no
//! business logic here (see development-plan.md section 86).

pub mod analytics;
pub mod app_info;
pub mod backup;
pub mod cleanup_actions;
pub mod daily_plans;
pub mod desktop;
pub mod diagnostics;
pub mod downloads;
pub mod duplicates;
pub mod focus;
pub mod health;
pub mod installed_apps;
pub mod large_files;
pub mod notification;
pub mod onboarding;
pub mod popup;
pub mod quick_launcher;
pub mod routines;
pub mod screenshots;
pub mod settings;
pub mod storage;
pub mod task_categories;
pub mod task_recurrence;
pub mod tasks;
pub mod tray;
pub mod updates;
pub mod widget;
pub mod xp;
