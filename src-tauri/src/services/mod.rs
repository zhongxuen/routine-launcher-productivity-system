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
//! `quick_launcher` and `shortcuts` are section 28's pair: the overlay window
//! and the global accelerator that summons it. `quick_launcher` is a sibling
//! of `popup` — both own a second OS window, and both live here rather than in
//! `commands/` so the shortcut handler and Stage 8's tray can call them
//! without going out through IPC and back.
//!
//! `xp` is section 43-47's progression — the XP ledger, the level curve, the
//! streak and the achievements. It is the one service the others *call*
//! rather than sit beside: `tasks`, `focus` and `routines` each hand it their
//! completion event so XP is earned from real work instead of from a command
//! the frontend could invoke. It never calls back into them, so the
//! dependency only ever points one way.
//!
//! `downloads` is Stage 10's Downloads Cleanup (sections 38-39) and the
//! one service that touches the user's own files rather than this app's
//! database. It has no `DbConnection` and stores nothing: a scan is read
//! once and shown, and the two functions that change anything take a list
//! of files the user ticked. Section 67's rule — scan, show, select,
//! confirm, act — is kept by that being the only shape they come in.
//!
//! `duplicates` is section 40's finder, and the one Stage 10 tool whose scan
//! *opens* files rather than only listing them — it decides two files are the
//! same by hashing them, which is the only comparison that can prove it. Like
//! its neighbours it holds no `DbConnection` and stores nothing between runs.
//! Its reading and its deleting are separate functions taking separate
//! arguments, so a scan result cannot become a deletion without the caller
//! handing back the exact paths; see its own module docs for how section 67's
//! scan/select/confirm/act order ends up expressed in the shape of the code.
//!
//! `large_files` is section 41's finder, and the third of Stage 10's tools to
//! read the user's own disk rather than this app's database. Its scan is
//! read-only and takes no `DbConnection` at all — a walk of a large tree runs
//! for seconds, and holding the shared connection mutex that long would stop
//! the tray, the reminder scheduler and every other window with it. Its five
//! actions each take one path and do one thing to it; there is no batch
//! entry point, which is how section 67's "user selects, then confirms" stays
//! the only way a file can move. See its module docs for what it refuses to
//! touch, and why deleting means the Recycle Bin.
//!
//! `screenshots` is section 42's organizer, and the fourth of Stage 10's
//! tools. It is the only one whose subject is a *kind* of file rather than a
//! folder, so most of it is the question "is this a screenshot" answered two
//! ways — by the folder a file sits in and by the name a capture tool gave
//! it. It borrows the connection once per call, for the local UTC offset, and
//! then does every date decision (today's midnight, a month's folder name) as
//! arithmetic, which is what lets the whole file be tested without a clock or
//! a timezone. Moving is a separate function from scanning and re-checks
//! every path it is given, so section 67's order is not merely the order the
//! UI happens to call things in.
//!
//! `analytics` is Stage 11's — sections 33, 36 and 82. It is the one service
//! that owns no table: every figure in it is read across the tables its
//! neighbours own, and nothing in it writes. It therefore sits *downstream*
//! of all of them, which is why it is the only service that borrows another's
//! SQL (`tasks::owed_by_predicate`) rather than re-deriving it — the
//! denominator of "6 / 8" and the population of the Today view have to be the
//! same population, and sharing the predicate is how that is guaranteed
//! rather than merely intended.
//!
//! `widget` is Stage 12's — sections 26 and 83. The fourth OS window, and the
//! third to be built on demand and hidden rather than destroyed. What sets it
//! apart from `popup` and `quick_launcher` is that everything about its window
//! is a *setting*: section 83 asks for resize, move, hide, pin and opacity,
//! and a widget that forgot any of them between runs would not be furniture.
//! So it is the one window service that holds a `DbConnection`, and the one
//! whose window is built out of the `settings` table rather than out of
//! constants.
//!
//! `onboarding` is section 84's first-run walkthrough, and the smallest
//! service here: one key in the `settings` table and the two functions over
//! it. Everything the walkthrough asks the user to do — a first task, a first
//! routine, the link between them — is done through `tasks` and `routines`,
//! so the only thing it owns is whether it has been seen.
//!
//! `startup` is section 85's launch-at-Windows-startup, and the only service
//! whose state lives outside this app entirely — in the `Run` key of the
//! registry rather than in the `settings` table, so the switch in Settings
//! agrees with Task Manager's Startup tab even when the user has been editing
//! it there. It owns the other half of that setting too: a run started by the
//! startup entry says so on its command line, and the main window is left
//! hidden behind `tray`'s icon rather than thrown on screen at boot.
//!
//! `updates` is section 85's other half of that same subject: `startup`
//! decides whether this build is running, and `updates` decides whether it
//! goes on being this build. It is the only service in the app that opens a
//! socket, which is why what it is allowed to say — a `GET` for a static
//! manifest, a `GET` for a static installer, no body and no identifier — is
//! written down in its module docs rather than left to be inferred from the
//! plugin it sits on. Like `startup` it keeps one flag in the `settings`
//! table and nothing else; the release it finds is not cached, because a
//! cached one is a claim about the world that goes stale the moment it is
//! written.
//!
//! `backup` is section 69's export, import and reset, and the only service
//! whose subject is the database *as a whole* rather than one table in it. It
//! is therefore the one that names no columns: it asks SQLite what the
//! columns are and copies whatever it finds, which is what keeps a backup
//! lossless across a migration that nobody remembered to tell it about. It is
//! also the only service that hands the connection back to `crate::db` — an
//! import and a reset both put the schema back the way a first launch leaves
//! it, and re-running the migrations is the only definition of "fresh" that
//! cannot drift from the real one. See its module docs for why an import is a
//! replacement rather than a merge, and why its foreign keys are deferred
//! rather than switched off.
//!
//! `logging` is section 85's other half: the crash and error log, and the
//! only service every other one can call. It is a service rather than a
//! command because the things worth recording happen where the Tauri runtime
//! is not — a panic in a background thread, a database that would not open —
//! and because the frontend's errors are written through it too, so a crash
//! in a webview and the panic in the process hosting it end up in one file in
//! the order they happened. It owns no table and holds no `DbConnection` on
//! purpose: the first failure worth a line is the database failing to open.
//! Nothing in it can transmit anything, which is how section 68's promise
//! survives having a crash reporter at all.
//!
//! `reminders` is the one service that writes columns on a table another
//! service owns — the `reminder_*` columns on `tasks` — and says why in its
//! own module docs. `notifications` beside it holds the wording of what a
//! reminder, or a finished focus session, actually says; delivering it is
//! `commands/notification.rs`'s job, because talking to the OS needs the
//! Tauri runtime and services stay free of it.

pub mod analytics;
pub mod backup;
pub mod downloads;
pub mod duplicates;
pub mod error;
pub mod focus;
pub mod health;
pub mod large_files;
pub mod logging;
pub mod notifications;
pub mod onboarding;
pub mod popup;
pub mod quick_launcher;
pub mod reminders;
pub mod routine_exec;
pub mod routines;
pub mod screenshots;
pub mod serde_util;
pub mod settings;
pub mod shortcuts;
pub mod startup;
pub mod task_categories;
pub mod task_recurrence;
pub mod tasks;
pub mod tray;
pub mod updates;
pub mod validate;
pub mod widget;
pub mod xp;

/// Development-plan.md section 94's loop, run through the services that
/// implement it. Test-only: it is a check on the product rather than a part
/// of it. See the module for why it is one test and not eight.
#[cfg(test)]
mod mvp_loop_tests;
