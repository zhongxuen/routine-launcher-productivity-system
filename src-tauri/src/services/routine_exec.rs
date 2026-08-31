//! Running a routine: the native half of the Routine System.
//!
//! [`super::routines`] decides *what* a routine should do; this module does
//! it. It takes a [`RoutineLaunchPlan`] — a snapshot already read out of the
//! database — and works through the actions in order, so nothing here needs a
//! SQLite connection and the shared connection mutex is never held across an
//! `exec`/`ShellExecute` call.
//!
//! Three rules from the plan drive the design:
//!
//! * **One failure never stops the routine** (sections 32 and 87). Every
//!   action produces a [`ActionResult`] with a `success`/`failure`/`skipped`
//!   status and a message the UI can show; the loop always runs to the end.
//! * **Timers are a signal, not an effect.** A `timer` action reports the
//!   minutes it asked for and nothing else — the real timer arrives in Stage
//!   4, and `commands::routines` turns the signal into a Tauri event.
//! * **Commands are opt-in and echoed** (section 66). A `command` action is
//!   skipped unless the user turned the feature on, and the exact command line
//!   is recorded on the result (and logged) whether it runs or not.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use super::routines::{
    self, RoutineAction, RoutineActionType, RoutineLaunchPlan,
};

/// Windows creation flags. Declared here rather than pulled in from a crate
/// because these two constants are all we need from the Win32 API.
#[cfg(windows)]
mod win {
    /// Run without allocating a console — used for the `.cmd`/`.bat` shim so
    /// launching an app does not flash a black window.
    pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    /// Give the process its own console — used for `command` actions, where
    /// the user explicitly asked to run something and will want to see it.
    pub const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
}

/// Per-action outcome, per development-plan.md section 87.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionStatus {
    /// The action was handed to the OS without error. Note that "launched" is
    /// as far as we can honestly claim: a program that starts and then exits
    /// on its own is still a success from here.
    Success,
    /// The action could not be carried out. `message` says why.
    Failure,
    /// The action was deliberately not attempted — it is disabled, or it is a
    /// `command` action and command execution is turned off.
    Skipped,
}

/// What happened to one action, ready to render as a line of the section 32
/// checklist.
#[derive(Debug, Clone, Serialize)]
pub struct ActionResult {
    pub action_id: i64,
    #[serde(rename = "type")]
    pub action_type: RoutineActionType,
    pub target: String,
    /// Short display name for the checklist ("Code", "github.com", ...).
    pub label: String,
    pub status: ActionStatus,
    /// Why it failed, or why it was skipped. `None` on success.
    pub message: Option<String>,
    /// For `timer` actions: the focus length that was requested. The timer
    /// itself is Stage 4 — this is the signal that asks for it.
    pub timer_minutes: Option<i64>,
    /// For `command` actions: the exact command line, echoed back whether it
    /// ran or was skipped, so the UI can show the user what was (or would
    /// have been) executed (section 66).
    pub echoed_command: Option<String>,
}

impl ActionResult {
    fn new(action: &RoutineAction, status: ActionStatus, message: Option<String>) -> Self {
        Self {
            action_id: action.id,
            action_type: action.action_type,
            target: action.target.clone(),
            label: action.label.clone(),
            status,
            message,
            timer_minutes: None,
            echoed_command: None,
        }
    }
}

/// The structured result of one routine run — everything the launch panel in
/// section 32 needs to draw itself, including the sentence to show under the
/// checklist.
#[derive(Debug, Clone, Serialize)]
pub struct RoutineRunResult {
    pub routine_id: i64,
    pub routine_name: String,
    /// Launch stats as they stand after this run (unchanged by a retry).
    pub launch_count: i64,
    pub last_launched_at: Option<String>,
    /// Every action considered, in run order.
    pub actions: Vec<ActionResult>,
    pub total: usize,
    /// Actions actually tried — `total` minus the skipped ones. This is the
    /// denominator in "3 / 4 actions completed".
    pub attempted: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub skipped: usize,
    /// `"3 / 4 actions completed"`.
    pub completed_label: String,
    /// A full sentence for the panel: `"Ready."`, or the count plus what went
    /// wrong.
    pub summary: String,
    /// The first focus length any `timer` action asked for, hoisted so the
    /// caller does not have to scan the list. Stage 4 consumes this.
    pub timer_minutes: Option<i64>,
}

/// Runs every action in `plan`, in order, and reports on all of them.
///
/// Never returns `Err`: a routine that half-worked is a result to show, not a
/// failure to raise. Anything that went wrong is on the individual
/// [`ActionResult`]s and summarised in [`RoutineRunResult::summary`].
pub fn run(plan: RoutineLaunchPlan) -> RoutineRunResult {
    let mut results = Vec::with_capacity(plan.actions.len());

    for action in &plan.actions {
        results.push(run_action(action, plan.command_actions_enabled));
    }

    summarise(plan, results)
}

/// Carries out a single action. Split out from [`run`] so the per-action
/// error handling is visible in one place: every branch returns a result, and
/// none of them can propagate out and abort the loop.
fn run_action(action: &RoutineAction, command_actions_enabled: bool) -> ActionResult {
    if !action.enabled {
        return ActionResult::new(
            action,
            ActionStatus::Skipped,
            Some("This action is turned off.".to_owned()),
        );
    }

    match action.action_type {
        RoutineActionType::Timer => {
            let minutes = routines::timer_minutes(&action.target);
            let mut result = match minutes {
                Some(_) => ActionResult::new(action, ActionStatus::Success, None),
                None => ActionResult::new(
                    action,
                    ActionStatus::Failure,
                    Some(format!(
                        "{:?} is not a number of minutes, so no timer was started.",
                        action.target
                    )),
                ),
            };
            result.timer_minutes = minutes;
            result
        }
        RoutineActionType::Command => run_command_action(action, command_actions_enabled),
        RoutineActionType::Url => finish(action, open_url(&action.target)),
        RoutineActionType::Folder => finish(action, open_folder(&action.target)),
        RoutineActionType::File => finish(action, open_file(&action.target)),
        RoutineActionType::Application => {
            let arguments = parse_arguments(action.arguments.as_deref());
            finish(action, launch_application(&action.target, &arguments))
        }
    }
}

fn finish(action: &RoutineAction, outcome: Result<(), String>) -> ActionResult {
    match outcome {
        Ok(()) => ActionResult::new(action, ActionStatus::Success, None),
        Err(message) => ActionResult::new(action, ActionStatus::Failure, Some(message)),
    }
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

/// Opens a URL in the default browser.
fn open_url(target: &str) -> Result<(), String> {
    tauri_plugin_opener::open_url(target, None::<&str>)
        .map_err(|err| format!("{target} could not be opened in your browser: {err}"))
}

/// Opens a directory in the file explorer.
fn open_folder(target: &str) -> Result<(), String> {
    let path = Path::new(target);
    if !path.exists() {
        return Err(format!("The folder {target} does not exist."));
    }
    if !path.is_dir() {
        return Err(format!("{target} is a file, not a folder."));
    }

    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|err| format!("{target} could not be opened: {err}"))
}

/// Opens a file with whatever application the OS has registered for it.
fn open_file(target: &str) -> Result<(), String> {
    let path = Path::new(target);
    if !path.exists() {
        return Err(format!("The file {target} does not exist."));
    }
    if path.is_dir() {
        return Err(format!("{target} is a folder, not a file."));
    }

    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|err| format!("{target} could not be opened: {err}"))
}

/// Launches an application.
///
/// The target may be a full path to an executable, a bare name that lives on
/// `PATH` (`chrome`, `code`), or a Start-menu shortcut. Those need different
/// treatment on Windows, so the target is resolved against `PATH`/`PATHEXT`
/// first and then dispatched:
///
/// * a real executable is spawned directly, which is the only form that can
///   take arguments safely (no shell is involved, so nothing in the argument
///   string can be reinterpreted as a command);
/// * a `.cmd`/`.bat` script needs `cmd /C`, so its arguments are checked for
///   characters `cmd` would treat as syntax and refused if any are present;
/// * a `.lnk`/`.url` shortcut cannot be executed at all and is handed to the
///   shell to open;
/// * anything that does not resolve is passed to the OS as-is, so its own
///   lookup gets the last word before we report a failure.
fn launch_application(target: &str, arguments: &[String]) -> Result<(), String> {
    let resolved = resolve_executable(target);
    let path = resolved.as_deref().unwrap_or_else(|| Path::new(target));

    // A Store app, named by ID rather than by file — checked first because
    // every path-shaped test below would answer the wrong question about it.
    if let Some(target) = as_store_app(path) {
        return launch_store_app(target, arguments);
    }

    // Checked before anything is spawned, because the OS does not describe
    // this one usefully. `CreateProcess` on a directory fails with "Access is
    // denied" and on a trailing separator with "program path has no file
    // name" — two ways of saying "that is a folder" that read as a permission
    // problem and as a bug respectively. A user who picked the folder instead
    // of the program inside it gets the same sentence the Folder and File
    // actions already give them.
    if path.is_dir() {
        return Err(format!(
            "{target} is a folder, not a program. Point this action at the program inside it, \
             or use a Folder action to open the folder."
        ));
    }

    let extension = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    if matches!(extension.as_str(), "lnk" | "url") {
        if !arguments.is_empty() {
            return Err(format!(
                "{target} is a shortcut, which cannot be given arguments. Point this action at \
                 the program itself to pass arguments."
            ));
        }
        return tauri_plugin_opener::open_path(path, None::<&str>)
            .map_err(|err| format!("{target} could not be started: {err}"));
    }

    if cfg!(windows) && matches!(extension.as_str(), "cmd" | "bat") {
        return spawn_script(path, arguments, target);
    }

    let mut command = Command::new(path);
    command.args(arguments);
    spawn_detached(&mut command).map_err(|err| launch_failure_message(target, &err))
}

/// The `shell:AppsFolder\…` form of `target`, if that is what it is.
///
/// Taken back off the `Path` it was wrapped in rather than tested before
/// resolution, because a Store app can arrive either way: typed as an ID by
/// someone who knows the syntax, or — far more often — resolved from the name
/// the user picked out of the application list.
fn as_store_app(path: &Path) -> Option<&str> {
    let target = path.to_str()?;
    target
        .starts_with(crate::services::installed_apps::APPS_FOLDER)
        .then_some(target)
}

/// Starts a packaged app through the shell's applications folder.
///
/// `explorer.exe` is the launcher because a packaged app has no executable to
/// run: the shell resolves the ID, activates the package and starts whatever
/// is registered inside it. Nothing else in this process can do that without
/// COM.
fn launch_store_app(target: &str, arguments: &[String]) -> Result<(), String> {
    if !arguments.is_empty() {
        return Err(format!(
            "{target} is an app from the Microsoft Store, which cannot be given arguments. \
             Remove them, or point this action at a program's .exe instead."
        ));
    }

    let mut command = Command::new("explorer.exe");
    command.arg(target);

    // `explorer.exe` hands the request to the shell and exits — often with a
    // non-zero code even when the app is starting — so the spawn succeeding
    // is as much as can be known here, which is the same thing "success"
    // means for every other action on this page.
    spawn_detached(&mut command).map_err(|err| {
        format!("{target} could not be started: {err}. The app may have been uninstalled.")
    })
}

/// Runs a `command` action, or explains why it did not.
fn run_command_action(action: &RoutineAction, command_actions_enabled: bool) -> ActionResult {
    let command_line = action.target.clone();

    // Echo first, unconditionally: section 66 wants the exact command visible,
    // and that is most useful precisely when something went wrong with it.
    crate::log_info!("[routine] command action {}: {command_line}", action.id);

    let mut result = if !command_actions_enabled {
        ActionResult::new(
            action,
            ActionStatus::Skipped,
            Some(
                "Command actions are turned off. Turn them on in Settings to let this routine \
                 run shell commands."
                    .to_owned(),
            ),
        )
    } else if let Err(err) = routines::validate_command(&command_line) {
        // Re-checked here as well as on save, so a row edited outside the app
        // still cannot slip a blocked command past the guardrail.
        ActionResult::new(action, ActionStatus::Failure, Some(err.to_string()))
    } else {
        finish(action, spawn_shell_command(&command_line))
    };

    result.echoed_command = Some(command_line);
    result
}

/// Hands a command line to the platform shell verbatim.
///
/// Verbatim is the point: the user typed this command and switched the feature
/// on, so it should behave exactly as it would in a terminal. On Windows the
/// text is appended to `cmd`'s command line unquoted via `raw_arg` — Rust's
/// normal argument quoting would change the meaning of a command containing
/// quotes or redirection.
fn spawn_shell_command(command_line: &str) -> Result<(), String> {
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;

        let mut command = Command::new("cmd");
        command.raw_arg("/C").raw_arg(command_line);
        // A command action is something the user asked for explicitly, so give
        // it a console rather than swallowing whatever it prints.
        command.creation_flags(win::CREATE_NEW_CONSOLE);
        command
    };

    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("sh");
        command.arg("-c").arg(command_line);
        command
    };

    spawn_detached(&mut command).map_err(|err| format!("The command could not be run: {err}"))
}

/// Characters `cmd.exe` reads as syntax rather than as text. Arguments to a
/// `.cmd`/`.bat` target are refused if they contain any, because `cmd`
/// re-parses its command line after Rust has quoted it and a stray `&` would
/// become a second command.
#[cfg(windows)]
const CMD_METACHARACTERS: [char; 8] = ['&', '|', '<', '>', '^', '"', '%', '\n'];

/// Runs a `.cmd`/`.bat` application target through `cmd /C`.
#[cfg(windows)]
fn spawn_script(path: &Path, arguments: &[String], target: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    if let Some(bad) = arguments
        .iter()
        .find(|argument| argument.contains(CMD_METACHARACTERS))
    {
        return Err(format!(
            "{target} is a script, which has to run through the command interpreter, so its \
             arguments cannot contain {:?}. Remove it, or point this action at an .exe instead.",
            CMD_METACHARACTERS
                .iter()
                .find(|c| bad.contains(**c))
                .copied()
                .unwrap_or('&')
        ));
    }

    let mut command = Command::new("cmd");
    command
        .arg("/C")
        .arg(path)
        .args(arguments)
        .creation_flags(win::CREATE_NO_WINDOW);

    spawn_detached(&mut command).map_err(|err| launch_failure_message(target, &err))
}

#[cfg(not(windows))]
fn spawn_script(path: &Path, arguments: &[String], target: &str) -> Result<(), String> {
    let mut command = Command::new(path);
    command.args(arguments);
    spawn_detached(&mut command).map_err(|err| launch_failure_message(target, &err))
}

/// Starts `command` and lets it outlive us.
///
/// The child's streams are detached from ours so a launched program can never
/// block on a pipe nobody is reading, and the [`std::process::Child`] handle
/// is dropped immediately — dropping it does not kill the process, which is
/// exactly what a launcher wants.
fn spawn_detached(command: &mut Command) -> std::io::Result<()> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(drop)
}

/// Windows error codes that mean something a user can act on, and that the
/// OS's own wording does not make clear.
///
/// Named here rather than matched on [`std::io::ErrorKind`] because the kinds
/// are not specific enough to tell these apart: elevation and a plain refusal
/// are both `PermissionDenied`, and a malformed path is `Uncategorized`.
#[cfg(windows)]
mod launch_error {
    /// `ERROR_ELEVATION_REQUIRED` — the program has a manifest asking for
    /// administrator rights.
    pub const ELEVATION_REQUIRED: i32 = 740;
    /// `ERROR_INVALID_NAME` — the path is not a path: a character Windows
    /// does not allow in one, or a malformed drive or share.
    pub const INVALID_NAME: i32 = 123;
    /// `ERROR_BAD_EXE_FORMAT` — the file is not a program at all.
    pub const BAD_EXE_FORMAT: i32 = 193;
}

/// Turns a spawn failure into the sentence the launch panel shows.
///
/// Section 87 asks each action to say why it failed, and "why" has to be a
/// reason the user can do something about. The raw `io::Error` is not:
/// `os error 740` is the whole difference between "this is broken" and "this
/// one needs to be started as an administrator", and nothing in the OS text
/// says which of the two is worth a retry.
fn launch_failure_message(target: &str, err: &std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::NotFound {
        // A bare name and a path fail the same way and are wrong in different
        // ways: one is a name no installed program answers to, the other is a
        // path to nothing. Sending a user who typed "Chrome" off to check
        // their path would be advice about a path they never wrote.
        return if target.contains(['\\', '/']) {
            format!("{target} could not be found. Check the path — the file is not there any more.")
        } else {
            format!(
                "No installed program is called {target}. Pick it from the Application list when \
                 editing this routine, or use the full path to its .exe."
            )
        };
    }

    #[cfg(windows)]
    match err.raw_os_error() {
        Some(launch_error::ELEVATION_REQUIRED) => {
            return format!(
                "{target} needs administrator rights to start, which a routine cannot give it. \
                 Start it yourself, or run Routine Launcher as an administrator."
            )
        }
        Some(launch_error::INVALID_NAME) => {
            return format!(
                "{target} is not a valid path. Check it for characters Windows does not allow \
                 in one, such as < > : \" | ? *."
            )
        }
        Some(launch_error::BAD_EXE_FORMAT) => {
            return format!("{target} is not a program Windows can run.")
        }
        _ => {}
    }

    format!("{target} could not be started: {err}")
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/// Finds the file an application target names, or `None` if nothing matches.
///
/// A target containing a separator is looked up where it points; a bare name
/// is searched for on `PATH`. On Windows both forms are also tried with each
/// `PATHEXT` suffix, which is how `code` finds `code.cmd` — the OS process
/// APIs only ever append `.exe` themselves.
///
/// A bare name that is on neither gets one last lookup, in
/// [`services::installed_apps`](crate::services::installed_apps): `Chrome`,
/// `Spotify` and `Opera` are the names on the icons the user clicks, and none
/// of the three is on `PATH`. That lookup goes last on purpose — a name that
/// Windows itself can resolve resolves to the same thing it always did, and
/// only a target that was about to fail can be changed by it.
fn resolve_executable(target: &str) -> Option<PathBuf> {
    let path = Path::new(target);

    if target.contains(['\\', '/']) || path.is_absolute() {
        return with_extensions(path).into_iter().find(|c| c.is_file());
    }

    let on_path = std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .flat_map(|dir| with_extensions(&dir.join(target)))
                .find(|candidate| candidate.is_file())
        })
        .unwrap_or_default();

    on_path.or_else(|| crate::services::installed_apps::resolve(target))
}

/// `base` itself, plus — on Windows, and only when `base` has no extension
/// already — `base` with each `PATHEXT` suffix appended.
fn with_extensions(base: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![base.to_path_buf()];

    #[cfg(windows)]
    if base.extension().is_none() {
        let pathext = std::env::var_os("PATHEXT")
            .unwrap_or_else(|| std::ffi::OsString::from(".COM;.EXE;.BAT;.CMD"));
        for extension in pathext.to_string_lossy().split(';') {
            let extension = extension.trim().trim_start_matches('.');
            if !extension.is_empty() {
                candidates.push(base.with_extension(extension.to_ascii_lowercase()));
            }
        }
    }

    candidates
}

/// Splits an `arguments` string into argv entries, honouring double quotes so
/// a path with spaces survives as one argument.
///
/// This is deliberately a *splitter*, not a shell: it does no globbing, no
/// variable expansion and no operator handling, so nothing in the string can
/// turn into an extra command.
pub fn parse_arguments(arguments: Option<&str>) -> Vec<String> {
    let Some(arguments) = arguments else {
        return Vec::new();
    };

    let mut parsed = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_content = false;

    for character in arguments.chars() {
        match character {
            '"' => {
                in_quotes = !in_quotes;
                // An empty pair of quotes is a real (empty) argument, so
                // remember that this token existed even with nothing in it.
                has_content = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_content {
                    parsed.push(std::mem::take(&mut current));
                    has_content = false;
                }
            }
            c => {
                current.push(c);
                has_content = true;
            }
        }
    }

    if has_content {
        parsed.push(current);
    }

    parsed
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/// Turns the per-action results into the counts and sentences the launch panel
/// shows (section 32).
fn summarise(plan: RoutineLaunchPlan, actions: Vec<ActionResult>) -> RoutineRunResult {
    let total = actions.len();
    let succeeded = actions.iter().filter(|a| a.status == ActionStatus::Success).count();
    let failed = actions.iter().filter(|a| a.status == ActionStatus::Failure).count();
    let skipped = actions.iter().filter(|a| a.status == ActionStatus::Skipped).count();
    let attempted = total - skipped;

    let completed_label = format!(
        "{succeeded} / {attempted} action{} completed",
        if attempted == 1 { "" } else { "s" }
    );

    let failed_labels: Vec<&str> = actions
        .iter()
        .filter(|a| a.status == ActionStatus::Failure)
        .map(|a| a.label.as_str())
        .collect();

    let mut summary = if failed == 0 {
        // Section 32's happy path ends on "Ready.", not on a score line.
        "Ready.".to_owned()
    } else {
        format!(
            "{completed_label}. {} could not be opened.",
            join_labels(&failed_labels)
        )
    };

    if skipped > 0 {
        summary.push_str(&format!(
            " {skipped} action{} skipped.",
            if skipped == 1 { "" } else { "s" }
        ));
    }

    let timer_minutes = actions
        .iter()
        .filter(|a| a.status == ActionStatus::Success)
        .find_map(|a| a.timer_minutes);

    RoutineRunResult {
        routine_id: plan.routine_id,
        routine_name: plan.routine_name,
        launch_count: plan.launch_count,
        last_launched_at: plan.last_launched_at,
        actions,
        total,
        attempted,
        succeeded,
        failed,
        skipped,
        completed_label,
        summary,
        timer_minutes,
    }
}

/// `"GitHub"`, `"GitHub and Chrome"`, `"GitHub, Chrome and Terminal"`.
fn join_labels(labels: &[&str]) -> String {
    match labels {
        [] => String::new(),
        [only] => (*only).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;
    use crate::services::routines::{NewRoutine, NewRoutineAction};

    fn action(action_type: RoutineActionType, target: &str, enabled: bool) -> NewRoutineAction {
        NewRoutineAction {
            action_type,
            target: target.to_owned(),
            arguments: None,
            sort_order: None,
            enabled: Some(enabled),
        }
    }

    /// A plan built through the real service, so the actions carry the ids,
    /// labels and normalised targets the executor will actually see.
    fn plan_for(actions: Vec<NewRoutineAction>, command_actions_enabled: bool) -> RoutineLaunchPlan {
        let conn = init_memory_db().unwrap();
        if command_actions_enabled {
            routines::set_command_actions_enabled(&conn, true).unwrap();
        }
        let routine = routines::create(
            &conn,
            NewRoutine {
                name: "Coding Mode".to_owned(),
                description: None,
                icon: None,
                actions,
            },
        )
        .unwrap();

        routines::prepare_launch(&conn, routine.id).unwrap()
    }

    #[test]
    fn splits_arguments_on_whitespace_and_respects_quotes() {
        assert!(parse_arguments(None).is_empty());
        assert!(parse_arguments(Some("   ")).is_empty());
        assert_eq!(
            parse_arguments(Some("--new-window   --profile Work")),
            vec!["--new-window", "--profile", "Work"]
        );
        assert_eq!(
            parse_arguments(Some(r#"--dir "C:\My Projects\app" --wait"#)),
            vec!["--dir", r"C:\My Projects\app", "--wait"]
        );
        assert_eq!(parse_arguments(Some(r#"--flag="""#)), vec!["--flag="]);
    }

    #[test]
    fn a_failing_action_does_not_stop_the_ones_after_it() {
        // Two folders that cannot exist, with a timer between them: the timer
        // and the last action still run (sections 32 and 87).
        let plan = plan_for(
            vec![
                action(RoutineActionType::Folder, "Z:\\nope\\one", true),
                action(RoutineActionType::Timer, "50", true),
                action(RoutineActionType::Folder, "Z:\\nope\\two", true),
            ],
            false,
        );

        let result = run(plan);

        assert_eq!(result.total, 3);
        assert_eq!(result.attempted, 3);
        assert_eq!(result.succeeded, 1);
        assert_eq!(result.failed, 2);
        assert_eq!(result.completed_label, "1 / 3 actions completed");
        assert_eq!(
            result.summary,
            "1 / 3 actions completed. one and two could not be opened."
        );
        assert_eq!(result.timer_minutes, Some(50));

        let statuses: Vec<ActionStatus> = result.actions.iter().map(|a| a.status).collect();
        assert_eq!(
            statuses,
            vec![
                ActionStatus::Failure,
                ActionStatus::Success,
                ActionStatus::Failure
            ]
        );
        assert!(result.actions[0].message.is_some(), "a failure explains itself");
        assert!(result.actions[1].message.is_none(), "a success does not");
    }

    #[test]
    fn disabled_actions_are_skipped_rather_than_run_or_dropped() {
        let plan = plan_for(
            vec![
                action(RoutineActionType::Timer, "25", true),
                action(RoutineActionType::Folder, "Z:\\nope", false),
            ],
            false,
        );

        let result = run(plan);

        assert_eq!(result.total, 2);
        assert_eq!(result.attempted, 1, "a skipped action is not attempted");
        assert_eq!(result.succeeded, 1);
        assert_eq!(result.failed, 0);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.completed_label, "1 / 1 action completed");
        assert_eq!(result.summary, "Ready. 1 action skipped.");
        assert_eq!(result.actions[1].status, ActionStatus::Skipped);
    }

    #[test]
    fn command_actions_are_skipped_but_still_echoed_while_the_feature_is_off() {
        let plan = plan_for(
            vec![action(RoutineActionType::Command, "npm run dev", true)],
            false,
        );

        let result = run(plan);

        assert_eq!(result.skipped, 1);
        assert_eq!(result.failed, 0);
        assert_eq!(result.actions[0].status, ActionStatus::Skipped);
        assert_eq!(
            result.actions[0].echoed_command.as_deref(),
            Some("npm run dev"),
            "the exact command is shown even when it is not run"
        );
        assert!(result.actions[0]
            .message
            .as_deref()
            .unwrap()
            .contains("turned off"));
    }

    #[test]
    fn a_timer_action_reports_minutes_without_starting_anything() {
        let plan = plan_for(vec![action(RoutineActionType::Timer, "50", true)], false);
        let result = run(plan);

        assert_eq!(result.succeeded, 1);
        assert_eq!(result.actions[0].timer_minutes, Some(50));
        assert_eq!(result.actions[0].label, "50-minute timer");
        assert_eq!(result.timer_minutes, Some(50));
        assert_eq!(result.summary, "Ready.");
    }

    #[test]
    fn a_missing_folder_and_a_file_used_as_a_folder_both_report_why() {
        let temp = std::env::temp_dir();
        let plan = plan_for(
            vec![
                action(RoutineActionType::Folder, "Z:\\definitely\\not\\here", true),
                action(
                    RoutineActionType::File,
                    &temp.join("routine-launcher-missing.txt").to_string_lossy(),
                    true,
                ),
            ],
            false,
        );

        let result = run(plan);

        assert_eq!(result.failed, 2);
        assert!(result.actions[0].message.as_deref().unwrap().contains("does not exist"));
        assert!(result.actions[1].message.as_deref().unwrap().contains("does not exist"));
    }

    #[test]
    fn resolves_an_executable_that_lives_on_path() {
        // Every supported platform has a shell on PATH under one of these
        // names; resolution must find it without being given a path.
        let name = if cfg!(windows) { "cmd" } else { "sh" };
        let resolved = resolve_executable(name);

        assert!(resolved.is_some(), "{name} should resolve from PATH");
        assert!(resolved.unwrap().is_file());
        assert!(
            resolve_executable("this-program-does-not-exist-9c1f").is_none(),
            "a name that is not on PATH resolves to nothing"
        );
    }

    /// The broken targets from development-plan.md section 85's test list, run
    /// through the real executor against the real filesystem.
    ///
    /// Every one has to fail with a sentence that names what is wrong, because
    /// the launch panel shows it verbatim next to a Retry button and a user
    /// who cannot tell "the drive is not mounted" from "you picked the folder"
    /// has no way to decide whether retrying is worth anything.
    #[test]
    fn a_broken_application_target_says_which_kind_of_broken() {
        // A folder. Windows answers `CreateProcess` on one with "Access is
        // denied", which reads as a permission problem and is not one.
        let windows = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned());
        let error = launch_application(&windows, &[]).unwrap_err();
        assert!(
            error.contains("is a folder, not a program"),
            "a folder should be named as one: {error}"
        );
        assert!(!error.contains("os error"), "and should not quote the OS: {error}");

        // The same folder with a trailing separator, which std rejects before
        // the OS ever sees it ("program path has no file name").
        let error = launch_application(&format!("{windows}\\"), &[]).unwrap_err();
        assert!(error.contains("is a folder, not a program"), "{error}");

        // A path that is not a path.
        let error = launch_application("C:\\bad|name\\app.exe", &[]).unwrap_err();
        assert!(
            error.contains("not a valid path"),
            "invalid characters should be named: {error}"
        );

        // A drive that is not mounted: a path to something that is not there.
        let error = launch_application("Z:\\nope\\app.exe", &[]).unwrap_err();
        assert!(error.contains("could not be found"), "{error}");

        // A bare name that is on neither PATH nor the installed-programs
        // list. Same OS error, different mistake — there is no path here to
        // send the user off to check, so the message points at the picker
        // that would have got the name right.
        let error = launch_application("definitely-not-a-program-9c1f", &[]).unwrap_err();
        assert!(
            error.contains("No installed program is called"),
            "a name should be named as one: {error}"
        );
        assert!(error.contains("Application list"), "{error}");
    }

    /// A Store app is started by ID through the shell, which takes no
    /// argument list. Saying so is the whole of this test: the alternative is
    /// arguments that are silently dropped, and a routine that looks like it
    /// opens a workspace and opens an empty window instead.
    #[test]
    fn a_store_app_refuses_arguments_rather_than_dropping_them() {
        let target = format!(
            "{}SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify",
            crate::services::installed_apps::APPS_FOLDER
        );

        let error = launch_application(&target, &["--minimized".to_owned()]).unwrap_err();
        assert!(error.contains("cannot be given arguments"), "{error}");
        assert!(error.contains(&target), "and names the target: {error}");
    }

    /// `launch_failure_message` is what turns an `io::Error` into that
    /// sentence, and the codes it special-cases cannot be produced on demand —
    /// nothing on a test machine reliably needs elevation — so they are
    /// checked here directly.
    #[test]
    #[cfg(windows)]
    fn a_target_that_needs_elevation_says_so_rather_than_quoting_the_error() {
        let elevation = std::io::Error::from_raw_os_error(launch_error::ELEVATION_REQUIRED);
        let message = launch_failure_message("C:\\Tools\\setup.exe", &elevation);
        assert!(
            message.contains("administrator rights"),
            "elevation is the actionable part: {message}"
        );
        assert!(message.contains("C:\\Tools\\setup.exe"), "and names the target: {message}");
        assert!(!message.contains("os error"), "{message}");

        let bad_format = std::io::Error::from_raw_os_error(launch_error::BAD_EXE_FORMAT);
        assert!(launch_failure_message("notes.txt", &bad_format).contains("not a program"));

        // Anything without a sentence of its own still reports, rather than
        // being swallowed or mislabelled as one of the cases above.
        let other = std::io::Error::from_raw_os_error(1);
        let message = launch_failure_message("app.exe", &other);
        assert!(message.starts_with("app.exe could not be started:"), "{message}");
    }

    /// A folder action and a file action pointed at a path that is not mounted,
    /// and at each other's kind of thing. These are the section 85 cases that
    /// do not involve spawning anything.
    #[test]
    fn a_broken_folder_or_file_target_says_which_kind_of_broken() {
        let windows = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned());
        let a_real_file = Path::new(&windows).join("explorer.exe");
        assert!(a_real_file.is_file(), "the test needs a file that exists");

        let error = open_folder(&a_real_file.to_string_lossy()).unwrap_err();
        assert!(error.contains("is a file, not a folder"), "{error}");

        let error = open_file(&windows).unwrap_err();
        assert!(error.contains("is a folder, not a file"), "{error}");

        assert!(open_folder("Z:\\nope").unwrap_err().contains("does not exist"));
        assert!(open_file("Z:\\nope\\notes.txt").unwrap_err().contains("does not exist"));
    }

    #[test]
    fn joins_failure_labels_readably() {
        assert_eq!(join_labels(&[]), "");
        assert_eq!(join_labels(&["GitHub"]), "GitHub");
        assert_eq!(join_labels(&["GitHub", "Chrome"]), "GitHub and Chrome");
        assert_eq!(
            join_labels(&["GitHub", "Chrome", "Terminal"]),
            "GitHub, Chrome and Terminal"
        );
    }
}
