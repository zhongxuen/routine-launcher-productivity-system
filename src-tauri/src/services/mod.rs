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
//! typed access to the key/value `settings` table and section 52's Daily
//! Settings, which belong to no one feature, `serde_util` holds
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
//! `quests` is section 44's daily objectives: the pool, which of it a date
//! offers, and the day's counts against each quest, read straight from the
//! tables that record the work. It writes nothing and pays nothing. `xp`
//! consults it before paying for a quest, and the frontend draws the same
//! definitions and counts through `get_daily_quests`, so the checklist's tick
//! and the payout are one decision (section 88).
//!
//! `downloads` is Stage 10's Downloads Cleanup (sections 38-39) and the
//! one service that touches the user's own files rather than this app's
//! database. It has no `DbConnection` and stores nothing: a scan is read
//! once and shown, and the two functions that change anything take a list
//! of files the user ticked. Section 67's rule — scan, show, select,
//! confirm, act — is kept by that being the only shape they come in.
//!
//! `desktop` is Stage 10's other folder scanner (sections 38, 81) and
//! `downloads`' closest sibling — same shape, same order, same refusal to act
//! on anything it was not handed. It differs in what a desktop actually is:
//! shortcuts, which are reported at their own size and never followed to what
//! they point at; folders, which are counted and never descended into or acted
//! on; age rather than extension as the axis worth sorting by, bucketed
//! against `screenshots`' clock so "today" means one thing across the app; and
//! two desktops rather than one, because Windows composites the per-user and
//! the Public Desktop into the single surface the user sees. The public one is
//! read and labelled and never written to — that needs elevation this app does
//! not ask for — which is the one rule it has that no other service does.
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
//! `storage` is section 38's sixth utility and the one section 81 never
//! scheduled, which is why it arrives after the five that were. It is the
//! only tool under Cleanup with no destructive function in it at all: it
//! reports what is on each fixed drive and what the profile's folders come
//! to, and where its four neighbours would offer a Move or a Delete it offers
//! a link into `large_files` or `duplicates` with the folder filled in. So
//! section 67's scan/select/confirm/act is not implemented here — there is no
//! act to reach — and section 66 is kept by there being no dangerous
//! operation to restrict rather than by restricting one. What it does own is
//! the problem of taking tens of seconds without blocking: it sizes exactly
//! one folder per call so the view can draw each answer as it lands, and it
//! hands out a token the walk re-checks as it goes, which is what makes Stop
//! stop something already running. Like its neighbours it takes no
//! `DbConnection` and stores nothing.
//!
//! `cleanup_actions` is the one place the six utilities above leave a trace
//! in the database, and it records that something was done, not what it was
//! done to: which utility, which action, how many items, when, and never a
//! path. The move, delete, archive and organize commands write a row after
//! the files have been handled, and the cleanup quest and the Organized
//! achievement read the rows (sections 44, 47). Nothing reads them to decide
//! what to do to a file, which is how section 67 survives cleanup joining the
//! quest system. Like `tasks`, `focus` and `routines`, it hands its event to
//! `xp`, though only so achievements are judged. A cleanup action earns no XP
//! of its own (section 88).
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
//! `daily_plans` is sections 20 and 51's PLAN TODAY, and holds only the part
//! of it that is a choice: up to three of a day's tasks, in order, keyed by
//! the local date. The workload and the time left beside them are sums over
//! `tasks` and the Daily Settings, worked out when the panel is drawn, so
//! nothing here duplicates what those two already store.
//!
//! `end_of_day` decides when section 22's one end-of-day notification is
//! owed: switched on in the Daily Settings, at the day's end, once a day. It
//! opens nothing; the reminder scheduler in `commands/notification.rs` asks
//! it and shows the notification.
//!
//! `suggestions` is section 55's rule-based suggestions: "make it recurring?"
//! and "update the estimate?", read from the task history `tasks` already
//! keeps. Like `analytics` it owns no table and writes no task. It describes
//! a change, and the frontend makes it through the task commands on a click.
//! The one thing it stores is a declined suggestion, as a `settings` key per
//! title, so that suggestion does not come back.
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
//!
//! `installed_apps` is what a routine's `application` target is measured
//! against when it is not a path: it reads the three lists Windows keeps of
//! what is installed and answers "which program is called *Chrome*". Two
//! callers, at the two ends of the same feature — the builder's picker, so
//! the user never has to know a path, and `routine_exec`, so a target that
//! was typed rather than picked still opens the right thing. It owns no
//! table and holds no `DbConnection`; its state is a cache of the disk,
//! rebuilt on request.

pub mod analytics;
pub mod backup;
pub mod cleanup_actions;
pub mod daily_plans;
pub mod desktop;
pub mod downloads;
pub mod duplicates;
pub mod end_of_day;
pub mod error;
pub mod focus;
pub mod health;
pub mod installed_apps;
pub mod large_files;
pub mod logging;
pub mod notifications;
pub mod onboarding;
pub mod popup;
pub mod quests;
pub mod quick_launcher;
pub mod reminders;
pub mod routine_exec;
pub mod routines;
pub mod screenshots;
pub mod serde_util;
pub mod settings;
pub mod shortcuts;
pub mod startup;
pub mod storage;
pub mod suggestions;
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
