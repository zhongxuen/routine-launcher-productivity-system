# Routine Launcher + Productivity Hub

A local-first Windows desktop app that combines a routine launcher, a daily task
manager, a focus timer, and a light progress layer — so that planning, starting,
working, completing, and tracking all live in one place.

Full specification: `md-files/development-plan.md`.

---

## Stack

| Layer | Choice |
| --- | --- |
| UI | React 19 + TypeScript + Vite 7 |
| Styling | Tailwind CSS v4 + shadcn/ui (new-york, zinc, Lucide icons) |
| Routing | react-router-dom (hash router — required for the Tauri webview) |
| State | zustand |
| Desktop shell | Tauri 2 (Rust) |
| Storage | SQLite via `rusqlite` (bundled — no external SQLite install needed) |

Local-first by design: no account, no backend, no cloud, no external API.

---

## Prerequisites

- **Node.js** 20+ (developed on 22.15)
- **Rust** stable (developed on 1.97)
- **Microsoft C++ Build Tools** — supplies the MSVC linker Rust needs on Windows
- **WebView2 Runtime** — preinstalled on Windows 11

No separate SQLite installation is required; `rusqlite`'s `bundled` feature
compiles SQLite into the binary.

---

## Getting started

```bash
npm install
npm run tauri dev
```

Other commands:

| Command | Does |
| --- | --- |
| `npm run dev` | Vite dev server only (browser; native commands unavailable) |
| `npm run build` | Type-check and build the frontend |
| `npm run tauri build` | Produce the Windows installer |
| `cargo check` (in `src-tauri/`) | Type-check the Rust backend |

---

## Project layout

```text
index.html              Main window entry
popup.html              Compact popup window entry (plan §25)

src/                    React frontend
  main.tsx              Main window root: router + app shell
  popup.tsx             Popup window root: one component, no router
  components/           Feature components (dashboard, tasks, routines, focus,
                        cleanup, progress, popup, widget) + common shell +
                        ui/ (shadcn)
  pages/                One component per top-level route
  services/             Typed wrappers over Tauri commands
  stores/               zustand stores
  types/                Shared domain types
  lib/utils.ts          cn() class-merge helper
  index.css             Tailwind entry + design tokens

src-tauri/              Rust backend
  src/commands/         #[tauri::command] entry points called from the frontend
  src/services/         Backend logic, kept free of Tauri specifics
  src/db/               SQLite connection + migration runner
  capabilities/         Tauri permission grants, one file per window

database/migrations/    Numbered .sql migrations, embedded at compile time
```

The `@/` alias maps to `src/`.

### Windows

The app has two Tauri windows, and therefore two HTML entries — `vite.config.ts`
declares both as build inputs. `main` is the full app; `popup` is plan §25's
compact window, built on demand by `src-tauri/src/services/popup.rs` and hidden
rather than destroyed when it is closed. Each has its own capability file, and
the popup's is deliberately the narrower of the two.

A second window means a second webview, which means a **second copy of every
zustand store** reading the same SQLite file. Neither window can see the
other's state, so a window that writes announces it —
`src/lib/window-sync.ts` — and the others re-read. What travels is only the
fact that something changed, never the rows: the database stays the single
source of truth, and a re-read is how a window picks up the backend's derived
values rather than guessing at them.

### Adding a database migration

1. Create the next numbered file in `database/migrations/` (e.g. `0002_....sql`).
2. Append a `Migration` entry in `src-tauri/src/db/migrations.rs`.

Migrations are embedded with `include_str!`, so they behave identically in
`tauri dev` and in a packaged installer. Applied versions are tracked in the
`_migrations` table.

---

## Theming

Design tokens live in `src/index.css` as CSS custom properties, with light and
dark values plus app-specific task priority and status colors. Dark mode is
driven by a `dark` class on `<html>`, managed by `src/stores/themeStore.ts` and
changeable from Settings. The preference currently persists to `localStorage`;
it moves to the `settings` table when that feature lands.

---

## Security posture

- Filesystem access is **not** granted to the frontend. All native OS
  operations go through explicit Rust commands (plan §86).
- Routine `command` actions are off by default and stay off until the user
  turns them on (`routines.command_actions_enabled` in the `settings` table).
  While off, a command action is reported as *skipped* rather than run, and
  the switch is a global kill switch — turning it back off stops every command
  action without editing any routine. The exact command line is echoed on the
  launch result whether it ran or not, and a small blocklist rejects obviously
  destructive commands both on save and again before running (plan §66).

---

## Progress

Phase checklist mirroring `md-files/development-plan.md` §72–85 (build order in
§93). This is the live status of the build — it is updated as work lands.

**Phase 1 — Foundation** ✅ complete

- [x] Tauri 2 + React + TypeScript + Vite project
- [x] Routing and app shell (sidebar + per-section sub-nav)
- [x] UI framework: Tailwind v4 + shadcn/ui, design tokens, dark mode
- [x] SQLite connection managed in Tauri state (WAL, foreign keys on)
- [x] Migration runner + `0001_init.sql` covering the plan's §57–63 schemas
- [x] zustand state layer
- [x] Desktop plugins installed and permissioned: notification,
      global-shortcut, autostart, dialog, fs, opener; `tray-icon` enabled

Deferred to the phases that need them: the `app_usage` and
`file_scan_history` tables, and the tray/shortcut/notification runtime wiring
(the plugins are installed, but nothing registers handlers yet).

**Phase 2 — Task System** ✅ complete

- [x] Task CRUD
- [x] Today view
- [x] Upcoming view
- [x] Inbox view
- [x] Completed view
- [x] Priorities
- [x] Due dates
- [x] Categories
- [x] Recurring tasks
- [x] Task completion

**Phase 3 — Routine System** ✅ complete

- [x] Routine CRUD
- [x] Action CRUD
- [x] Routine builder
- [x] Application launching
- [x] File launching
- [x] Folder launching
- [x] URL launching
- [x] Action ordering

The native half is done: `routines`/`routine_actions` CRUD, the five action
executors, ordered execution with per-action success / failure / skipped
results (§87), and `launch_count` / `last_launched_at` tracking. `command`
actions are implemented but disabled by default — see Security posture below.
Timer actions emit `routine://timer-requested` and start nothing yet; the real
timer is Phase 5.

The UI half runs against that backend: `src/stores/routineStore.ts` calls
`src/services/routineService.ts`, which is a thin typed wrapper over the
commands, so the My Routines cards (§29), the builder with reorderable actions
(§31), the launch panel with its per-action ✓ / ✗ list and Retry / Continue
(§32) and the statistics block (§33) all read and write SQLite. Saving the
builder replaces a routine's whole action list in list order, so what is on
screen is the run order. The Templates tab (§64) ships three starter routines —
Coding Mode, Study Mode, Work Mode — which are pre-filled `create_routine`
payloads and nothing more: adding one produces an ordinary, editable routine,
and it opens in the builder so the guessed targets can be checked before the
first launch.

Of the five figures in §33, launches and last-used are real — the backend
stamps them inside `launch_routine`, and the store re-reads the list after
every run. Focus time, average session and tasks completed have no source yet
and are shown as a dash rather than a number, with the queries that will fill
them noted in `RoutineStatisticsDialog.tsx`. All three are now only a query
away — Phase 4 fills `tasks.routine_id`, and Phase 5 writes a `routine_id` on
every focus session `listRoutineFocusSessions` can already read back — but
each is still shown as a dash until that query is written, because a dash is
honest and a zero is not.

The command-action opt-in has a home in Settings — a switch that asks before
it is turned on and takes effect immediately when it is turned off.

**Phase 4 — Task + Routine Integration** ✅ complete

- [x] Assign a routine to a task
- [x] "Start task" launches the assigned workspace
- [x] Focus timer starts with the launched routine — the intent is emitted
      by the launch and turned into a running clock by Phase 5

A task can now name the workspace it is done in. `tasks.routine_id` became
settable on both `create_task` and `update_task` — three-state on update, so
omitting it leaves the assignment alone and `null` unassigns without touching
the routine — and a routine that does not exist is refused by name rather than
by a foreign key that cannot tell a missing routine from a missing category.
Deleting a routine still leaves its tasks behind, minus the link, and a
repeating task carries its routine into every instance the series produces.

In the UI the field is optional on both task forms (`TaskRoutineField`), the
row names the routine it was given, and rows with one gain **START TASK**
(§18). Pressing it launches the routine through the same store and the same
panel the routine cards use — one launch path, not two — with the task's title
and its focus length added to the checklist, which is exactly §18's combined
feedback.

The focus length is the task's `estimated_minutes`, falling back to whatever
timer the routine already carries: the task is the more specific answer, so a
workspace that always opens a 50-minute timer does not overrule a task the
user said would take 15. It is *shown*, not started — §88 — and labelled as
the session that will begin rather than one that has.

**The seam into Phase 5** is `src/lib/focus-intent.ts`. Once a task's routine
has finished launching, `routineStore` emits one `FocusIntent` (task, routine,
minutes) through `requestFocus`; `useFocusLifecycle` subscribes and starts the
session. Routing it through a function rather than having the row reach into
the timer is what keeps every caller — the row, and later the dashboard, the
tray popup and the widget — saying the same thing without knowing how a session
is started.

**Phase 5 — Focus System** ✅ complete

- [x] Pomodoro timer — 25/5, 50/10 and 90/15 run on screen and are written to
      `focus_sessions`
- [x] Custom timer — any length from 1 minute to 12 hours, plus Stopwatch
- [x] Focus history — Focus > History reads `list_focus_sessions` back
      newest-first, ended sessions only
- [x] Task association — sessions store, label and are titled by their
      `task_id`, and tasks are what start them (§19)
- [x] Routine association — likewise, from the launch a session follows
- [x] Completed / abandoned session tracking — a session that reaches its
      target completes, and one that is stopped, closed or crashed on is
      recorded as interrupted
- [x] Task ↔ focus integration (§19) — Start Focus on a task, actual focus
      time recorded back onto it, and START TASK's routine handing over to a
      running clock

The session backend is in (§34–35, §61). `focus_sessions` records what
actually happened; the clock that produces it runs in the frontend, because a
Rust process ticking once a second would be machinery for something the UI has
to render anyway. `start_focus_session` writes `started_at` the moment Start is
pressed, so elapsed time is always recoverable from the row — reload the window
mid-session and `get_active_focus_session` hands it back with
`elapsed_seconds` already counted, rather than the session disappearing with
the JavaScript that was holding it.

Only one session can be open at a time: starting a second closes the first as
interrupted, which is also what cleans up a session a crash left running. That
makes §35's two outcomes honest — `completed` for a session that reached its
target, `interrupted` for one that was abandoned, and neither while it is still
going.

Duration is the *measured* focus, not the wall clock: `end_focus_session` takes
the seconds the timer counted, so a session paused for ten minutes records the
work rather than the gap. A figure larger than the time the session was open
for is clamped down to it — the record can be shorter than the session, never
longer.

Two columns sit alongside §61's schema. `preset` and `planned_seconds` store
what a session was *for*, which the stored fields cannot reconstruct: a
25-minute row that stopped at 24:58 could equally be a finished Custom timer or
an abandoned 25/5, and a stopwatch has no target at all. Breaks — the 5, 10 and
15 of §34 — are deliberately not stored: a break is not focused work, so it is
a countdown for the UI and never a row the statistics of §36 would add up.

`src/services/focusService.ts` is the typed wrapper layer over the six
commands, and `src/types/focus.ts` is the wire contract both sides share —
preset ids (`"25-5"`, `"50-10"`, `"90-15"`, `"custom"`, `"stopwatch"`) are the
same strings in the picker, in `invoke`, and in the `preset` column.

**The Focus page** is the other half (§34, §64). Timer is one card in three
states — a preset waiting to be started, a clock running against it, and what
the session ended as — because they are the same question at different points:
how long, how long left, how long it was. The picker offers §34's five
presets and is drawn only while the choice is live; starting a session locks
the length the clock is already counting against. Finish is offered while
running and while paused, and a paused countdown says out loud that finishing
now records an interrupted session, because finding that out afterwards is a
bad way to learn it. The completion card leads with the measured time and
states the outcome next to it: a session stopped early is *interrupted* and
still keeps the minutes it earned (§88 — hiding a short session loses real
focus time, calling it complete inflates it). History is a reverse-
chronological list of what has ended, each line carrying its length, its task
or routine, and its outcome.

None of it is timed by a component. `focusStore` owns the session and measures
elapsed time against `Date.now()` from a `started_at` stamped at Start, so the
interval only decides how often the display refreshes — never what it says.
That is what makes the clock survive being navigated away from (the Focus
header keeps a running pill visible on the History tab, counting on a page
that has never rendered a clock), a throttled background window, and the
machine sleeping. Paused milliseconds are subtracted rather than counted, and
a countdown that overshoots while the window was asleep records the session it
was, not the time the machine was away for.

**The two halves are now joined** (Prompt 4.3). `focusStore` writes the row
before it starts the clock, so a session exists in SQLite from its first
second and `started_at` is the instant Start was pressed rather than something
reconstructed afterwards; Finish ends that row with the seconds the store
measured, pauses excluded; and History is `list_focus_sessions` with
`only_ended`, read fresh on every mount rather than trusted from the store,
because sessions also end by ways that page never saw. A start the backend
refuses — a task that has since been deleted — leaves no clock running and
says why, since a timer counting against a session nothing accepted would be
counting for nothing.

**A session nobody finished is still recorded**, which is the other half of
§35's outcomes. Two things close one:

1. *Finish, or the countdown running out.* The store knows how much of the
   session was paused, so the row gets the focused time and the honest
   outcome — reaching the target completes, stopping short interrupts.
2. *The window closing, a crash, or a kill.* `close_abandoned` closes whatever
   is still running as interrupted, and `lib.rs` calls it from both ends: an
   `on_window_event` handler as a window goes, and once in `setup` for
   anything the last run never got to say goodbye for.

The second lives in Rust rather than in the frontend on purpose. JS's
`onCloseRequested` closes the window by calling `destroy()`, which
`core:window:default` does not grant — a close handler that needed a
permission the app does not have would be a window that could not be closed,
which is a far worse bug than the arithmetic it buys. What it costs is the
pause: `close_abandoned` works from the wall clock, and paused milliseconds
only ever exist in the store. So the recorded time is capped at the length the
session was *for* — twelve hours for a stopwatch, which has none of its own —
and clamped to the wall clock on top. An app closed on a Friday and reopened
on a Monday records at most one session, never a weekend of focus.

That startup sweep is also what makes resuming safe. Because it runs before
any window can ask, every session `get_active_focus_session` reports afterwards
is one *this* run started — so a reloaded window rebuilds the clock from
`started_at` and `elapsed_seconds` and picks up mid-session, rather than
resurrecting a timer nobody has watched since Tuesday. That read is
`useFocusLifecycle`, mounted from `AppLayout` rather than from the Focus page
for the same reason the clock lives in a store: a session started from a task
runs while the user is anywhere in the app, and the reloaded window can land
on any of those pages.

**Tasks and the timer are now one chain** (§19: Task → Focus Session →
Completion). Every unfinished task carries a quiet **Start Focus** button that
puts its `estimated_minutes` on the clock and attaches the session to it; a
task with a routine still gets **START TASK**, which opens the workspace and
*then* starts the same kind of session, linked to both the routine and the task
(§18's "Launching Coding Mode… / Focus timer: 50:00 / Task: …", with the launch
panel switching from the length it will run for to the clock actually counting).
Only one clock can run at a time, so a row whose session is live says
*Focusing* and links to it instead of offering a second, and every other row's
button is disabled rather than silently refusing.

Coming back the other way, a task's **actual focus time** (§17) is
`tasks.focus_seconds` — summed by the backend from the ended sessions that name
the task, never stored on the task itself, so it cannot drift from the sessions
it is made of and a running session is not counted until it ends. It reads back
on the row ("Focus 43 min" once completed, "Focused 30 min" while still open)
and in the edit dialog next to the estimate it answers. `src/lib/focus-events.ts`
is what makes it appear without a reload: `focusStore` announces a session
*after* the row is written, and `useFocusLifecycle` re-reads the task list —
so neither store has to know the other exists. The completion card closes the
loop with the last step of §89's day, offering to tick the task off; that stays
an offer, because a finished 50 minutes is not the same claim as a finished
task.

**Phase 6 — Dashboard** ⬅ current

- [x] The page itself (`src/pages/Dashboard.tsx`): §7's greeting and TODAY
      header over the four widgets below, in §7's stated priority order —
      today's tasks, quick routine launching, focus, progress — with progress
      last and narrow, because §§7 and 50 both put gamification behind the
      productivity system. Composition only: every widget owns its own reads,
      its own error states and the dialogs it raises, so the page makes no
      query of its own
- [x] Today's tasks — §7's TASKS block
      (`src/components/dashboard/TodaysTasks.tsx`): the backend's `today` view
      through the same `useTaskView` the daily view uses, so the dashboard and
      `/tasks/today` cannot disagree and §14's carry-forward comes along;
      unfinished tasks only, capped at five with the rest behind a link, the
      completed half of the day being the mockup's `█████████░░ 70%` meter
      beside the heading; ticking a box is the real mutation, and "+ Add Task"
      raises the §16 quick-add dialog the widget mounts itself
- [x] Quick routine launcher — §7's QUICK START row
      (`src/components/dashboard/QuickStart.tsx`): the most-launched routines as
      icon + name + START tiles, ranked by `launch_count` because §59 stores no
      pinned flag, with the §32 launch panel mounted alongside so a dashboard
      START shows the same checklist a Routines START does
- [x] Current focus — §7's FOCUS block
      (`src/components/dashboard/FocusWidget.tsx`): today's total focused time
      summed from the same history the Focus > History list reads, plus the
      §34 "Start Focus" button, which starts a session on the current preset
      and hands the user to the timer page that owns the clock
- [x] Daily progress — §7's PROGRESS block
      (`src/components/dashboard/ProgressWidget.tsx`): level, XP bar and §46's
      streak flame, kept to three lines of small muted type because §§7 and 50
      both put gamification behind the productivity UI. The numbers are still
      the mock ones in `src/stores/progressStore.ts` — the XP backend is Phase
      9 — but the widget takes no data props, so Phase 9 swaps that store's
      body for `xpService` without reopening the component
- [ ] Upcoming tasks
- [ ] Basic statistics

**Phase 7 — Notifications + Popup**

- [x] Task reminders — §24's two forms ("10 minutes before", "At 5:00 PM") as
      five `reminder_*` columns on `tasks`
      (`database/migrations/0004_task_reminders.sql`), split into what the user
      configured and how far its delivery has got. `services/reminders.rs`
      stores the rule and works the moment out on every poll rather than
      scheduling one ahead, which is what lets a task be re-dated, snoozed or
      dismissed without anything having to go and reset a queue: Snooze and
      Dismiss are two writes of the same two columns, and neither touches the
      task. A background thread in Rust
      (`commands/notification.rs::start_scheduler`) checks every 30 seconds,
      so a reminder arrives with the window closed — the point of §24 — and a
      reminder whose moment passed more than an hour ago stays quiet rather
      than firing a backlog at whoever opens the laptop
- [x] Focus completion notification — hung off the end of the *session* rather
      than the end of the countdown (`commands/focus.rs`), so it fires wherever
      the timer was being watched from, and only for a session that reached
      its target: an interrupted one was stopped by somebody who was already
      looking at it. Says what was focused on and suggests the preset's break
      (§34's 25/5, 50/10, 90/15)
- [x] Notification actions and the fallback — §24 asks for Start Task / Snooze
      / Dismiss *on* the notification, and no desktop platform can draw them
      with `tauri-plugin-notification` (its desktop builder drops
      `action_type_id`, and the `Action` models are mobile-only with no public
      constructor). So the toast says where the buttons are and the same
      payload is emitted as `notification://reminder-fired` for the app to
      raise them from — `onReminderFired` in
      `src/services/notificationService.ts`, with `snoozeTaskReminder` and
      `dismissTaskReminder` behind whichever buttons end up drawing it
- [x] Compact popup window — §25's window, and a real second Tauri one
      (`popup.html` -> `src/popup.tsx` -> `src/components/popup/`), because
      Phase 8's tray and shortcut have to be able to summon it when the main
      window is closed. Rust owns its life
      (`src-tauri/src/services/popup.rs`): built on first use, positioned
      top-right, always on top, out of the taskbar, and *hidden* rather than
      destroyed when closed, so re-opening is instant — except when the main
      window goes, which takes it with it rather than leaving a process alive
      behind a window nobody can see. Its list is the backend's `today` view,
      the same query the dashboard and `/tasks/today` run; ticked tasks sink
      below the open ones instead of vanishing, which is what makes the
      `2 / 7 completed` line above them mean anything
- [x] Quick task creation — the mockup's `[ + Add Task ]`
      (`src/components/popup/PopupQuickAdd.tsx`), reduced to a title and
      Enter. §16's full dialog does not fit 340px, and a popup that made
      adding a task slower than opening the app would defeat the one thing
      §25 asks for; the defaults it fills in (due today, normal priority) are
      the ones that dialog opens on anyway. It stays open between adds
- [x] Quick routine launching — the mockup's `🚀 Start Coding`
      (`src/components/popup/PopupRoutineLaunch.tsx`): the most-used routine
      as a one-click button, ranked by the same `quickStartRoutines` the
      dashboard's QUICK START row uses, with the rest behind a chevron. It
      runs the same `launchRoutine`, but reports as one line rather than
      mounting §32's checklist panel — a partial run says so and points at the
      app, where Retry lives

**Phase 8 — System Tray + Global Shortcut**

- [ ] System tray icon + menu
- [ ] Tray quick actions
- [ ] Configurable global keyboard shortcut
- [ ] Quick launcher

**Phase 9 — Simple Gamification**

- [ ] XP
- [ ] Levels
- [ ] Streaks
- [ ] Achievements

**Phase 10 — Desktop Utilities**

- [ ] Downloads scanner
- [ ] Desktop scanner
- [ ] Duplicate finder
- [ ] Large file finder
- [ ] Screenshot organizer

**Phase 11 — Productivity Analytics**

- [ ] Daily focus time
- [ ] Weekly focus time
- [ ] Task completion rate
- [ ] Routine usage
- [ ] Completed tasks
- [ ] Streak history
- [ ] Productivity trends

**Phase 12 — Desktop Widget**

- [ ] Always-on-top widget window
- [ ] Task / Focus / Routine / Combined modes
- [ ] Resize, move, hide, pin, opacity

**Phase 13 — Polish**

- [ ] Animations and transitions
- [ ] Themes
- [ ] Keyboard navigation
- [ ] Accessibility
- [ ] Onboarding
- [ ] Error handling
- [ ] Empty states
- [ ] Loading states
- [ ] Responsive layouts

**Phase 14 — Packaging**

- [ ] Windows installer
- [ ] Application icon
- [ ] Auto-start option
- [ ] Versioning + update strategy
- [ ] Backup / import
- [ ] Local crash and error logging
- [ ] Install / upgrade / uninstall / reinstall testing
- [ ] Migration and broken-path testing

---

## Documentation convention

Every Markdown file in this repository except `md-files/development-plan.md`
carries a checklist of its own scope, and those checklists are updated as part
of the work they describe — not afterwards as a separate pass.

- [x] `README.md` — phase checklist above
- [ ] Future docs — add a checklist when the file is created
