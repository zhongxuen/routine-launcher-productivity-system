# Routine Launcher + Productivity Hub

A local-first Windows desktop app that combines a routine launcher, a daily task
manager, a focus timer, and a light progress layer — so that planning, starting,
working, completing, and tracking all live in one place.

Full specification: `md-files/development-plan.md`.
What is not built yet, and the prompt to build it: `remaining.md`.

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
| `npm run installer:build` | The same, then copy the `.exe` into `installers/` |
| `npm run installer:collect` | Copy an already-built `.exe` into `installers/` |
| `cargo check` (in `src-tauri/`) | Type-check the Rust backend |
| `npm run version:check` | Report the version in each of the five files that carry it |
| `npm run version:set -- 0.2.0` | Set that version everywhere |

---

## Project layout

```text
index.html              Main window entry
popup.html              Compact popup window entry (plan §25)
launcher.html           Quick launcher overlay entry (plan §28)
widget.html             Desktop widget entry (plan §26, §83)

src/                    React frontend
  main.tsx              Main window root: router + app shell
  popup.tsx             Popup window root: one component, no router
  launcher.tsx          Quick launcher root: one component, no router
  widget.tsx            Desktop widget root: one component, no router
  components/           Feature components (dashboard, tasks, routines, focus,
                        cleanup, progress, popup, launcher, widget,
                        notifications, onboarding, settings) + common shell
                        + ui/ (shadcn)
  pages/                One component per top-level route
  hooks/                Cross-component behaviour (task views, focus and window
                        sync, tray and launcher requests, list animation)
  services/             Typed wrappers over Tauri commands
  stores/               zustand stores
  types/                Shared domain types
  lib/                  Pure helpers shared across features — no React, no
                        Tauri; `utils.ts` is the cn() class-merge helper and
                        `crash-log.ts` is frontend crash reporting (plan §85)
  index.css             Tailwind entry + design tokens

src-tauri/              Rust backend
  src/commands/         #[tauri::command] entry points called from the frontend
  src/services/         Backend logic, kept free of Tauri specifics
  src/db/               SQLite connection + migration runner
  capabilities/         Tauri permission grants, one file per window

database/migrations/    Numbered .sql migrations, embedded at compile time

scripts/set-version.mjs Reads and writes the version in all five files that
                        carry it (`npm run version:check` / `version:set`)
scripts/collect-installer.mjs
                        Copies the built .exe into installers/

installers/             The current installer, downloadable from the repo
                        without building it

.github/workflows/      release.yml — tag-triggered build: installers,
                        signatures and the updater manifest (plan §85)
                        sync-installer.yml — commits the published release's
                        .exe back into installers/
```

Nothing in the repository is written to at runtime. Everything the installed
app owns lives in one folder:

```text
%APPDATA%/com.zhongxuen.routinelauncher/
  app.db                The SQLite database
  logs/                 Rotating crash and error log (plan §85)
```

The `@/` alias maps to `src/`.

### Windows

The app has four Tauri windows, and therefore four HTML entries —
`vite.config.ts` declares all four as build inputs. `main` is the full app;
`popup` is plan §25's compact window; `launcher` is plan §28's quick launcher,
the overlay the global shortcut summons; `widget` is plan §26 and §83's
optional desktop widget. The three small ones are built on demand by
`src-tauri/src/services/popup.rs`, `services/quick_launcher.rs` and
`services/widget.rs`, and hidden rather than destroyed when they are closed, so
the next summon is instant. Each window has its own capability file, and the
three small ones are deliberately narrower than the main window's — none is
granted the window permissions its own show/hide/move/resize would need,
because those are Rust commands.

The launcher differs from the popup in three ways, all of them consequences of
being a *launcher* rather than a glance: it has no decorations, it hides when
it loses focus (its only way out with a mouse), and its height follows its
contents — measured in the frontend, clamped in Rust.

The widget differs again, because it is meant to stay on screen while you work
on something else. It is off by default and only ever opened by the user. Every
one of §83's five controls is persisted to the `settings` table under
`widget.*`, so it reopens where and how it was left — including whether it was
open at all, which is what `services::widget::restore` reads at startup. Two of
the five are gestures rather than buttons: a pointer-down anywhere that is not
a control hands the window to the OS's own drag loop, and the corner grip sends
a size that Rust clamps. Position and size come back as a stream of `Moved` and
`Resized` events rather than as one answer, so they are written at most once
every 400ms while the window is still moving and flushed unthrottled when it is
hidden, blurred or destroyed. The window is *transparent* — the only one that
is — because Tauri has no cross-platform window alpha, so §83's opacity is
painted by the widget onto a pane of glass. That is what `macOSPrivateApi` in
`tauri.conf.json` is for.

Three places can put the widget on screen and they are all the same stored
value: the "Enable desktop widget" switch in Settings, "Show Widget" on the
tray menu, and the ✕ in the widget's own chrome that takes it off again. Every
write announces itself (`widget://settings-changed`) and the others re-read, so
the switch is never showing a widget that is not there. Settings also carries
the layout picker — the one widget control with no twin in its own chrome,
because a four-way choice does not fit in a 300px window.

**Creating a window has to happen off the main thread.** A synchronous Tauri
command runs on the main thread, and building a webview from there while the
event loop is running deadlocks the whole app — the builder waits for the loop,
the loop waits for the command. So the entry points that can build the widget
are `async` commands (`open_widget_window`, `toggle_widget_window`), and the
tray's menu handler — which is also on the main thread — hands the work to
`tauri::async_runtime::spawn`. Anything that only shows, hides or moves an
existing window is fine where it is.

A second window means a second webview, which means a **second copy of every
zustand store** reading the same SQLite file. Neither window can see the
other's state, so a window that writes announces it —
`src/lib/window-sync.ts` — and the others re-read. What travels is only the
fact that something changed, never the rows: the database stays the single
source of truth, and a re-read is how a window picks up the backend's derived
values rather than guessing at them.

The one thing that cannot cross that way is a *clock*. A running focus session
is state in a `focusStore`, not a row anybody else can write — and pausing it
is arithmetic against `Date.now()` that `focus_sessions` deliberately does not
record, so a window told only "something changed" would re-read a paused
session and start counting it again. Two windows answer that differently. The
widget shows the same timer, so it gets a channel that carries the live session
itself and has each window adopt what the other reports —
`src/lib/focus-sync.ts`, mounted through `src/hooks/useFocusSync.ts`. The quick
launcher has no timer of its own and is gone a moment later, so its
`⏱ Start Focus` asks the main window rather than starting one —
`src/lib/launcher-events.ts` out, `src/hooks/useLauncherRequests.ts` back.

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

**The colour tokens are contrast-constrained, not chosen by eye.** Every token
drawn as text clears 4.5:1 against the surfaces it appears on, in both themes;
`--ring` and `--input`, which identify a control rather than spell anything,
clear 3:1. The light theme is the binding one — a hue rich enough to read on a
near-black card is washed out on white — which is why the two themes' priority
and status values are not each other's lightened. `--border` is deliberately
left below 3:1: it draws dividers between things that are already identifiable
without it.

Two consequences worth knowing before adding a colour:

- **Do not fade a foreground token to make a quieter tier.** A colour at 70%
  over white cannot exceed 3.0:1 no matter what colour it is, because the white
  showing through sets the ceiling. That is what `--muted-subtle` exists for;
  reach for it rather than for `text-muted-foreground/70`. Faded greys below
  that are reserved for genuinely inactive things — a locked achievement, a
  future day, a disabled action — which the contrast rules exempt.
- **Do not fade the focus ring.** Same arithmetic, same reason. The shadcn
  primitives here paint `ring-ring` at full opacity rather than upstream's
  `ring-ring/50`.

---

## Motion and sound

Motion is CSS, and the durations and easing are tokens in `src/index.css`
(`--duration-quick|base|slow`, `--ease-soft`) so that a row leaving a list and
a dialog closing agree about how long "quick" is. `tw-animate-css` supplies
the `animate-in` / `fade-*` / `zoom-*` / `slide-*` utilities that the
`components/ui` primitives are written against; the app's own keyframes
(`page-enter`, `row-enter`, `row-leave`, `card-*`, `pop`) sit beside them.

Two things need JavaScript, and both live in `src/lib/motion.ts`:

- **Exit animations.** An element React has already unmounted is not on screen
  to fade, so `src/hooks/useAnimatedList.ts` holds a removed item mounted for
  exactly the length of its exit animation and then drops it. That duration
  exists in a stylesheet and in TypeScript; `assertMotionDurationsMatch` fails
  loudly in development if the two drift, because the symptom otherwise is
  rows vanishing a beat early with nothing to point at.
- **Whether to animate at all.** `motionStore` writes a `reduce-motion` class
  on `<html>` — the same mechanism as the theme's `dark` class, for the same
  reason: the in-app setting has to be able to disagree with Windows in both
  directions. `index.css` shortens every animation to 1ms (not `0s` — an
  `animationend` listener still has to fire), and JavaScript timers read the
  class through `reducedMotion()`.

Sound is off by default and only the exact stored string `on` turns it on, so
a missing key, an older build's value or a corrupt profile all stay silent.
The cues in `src/lib/sounds.ts` are synthesised with WebAudio rather than
shipped as audio files: nothing is added to the installer for a feature most
users leave off, nothing has to be fetched or decoded before it can play, and
there are no sample licences to track. Every failure path — no output device,
a blocked autoplay policy — is swallowed, because a cue is decoration over an
action that has already happened.

All three preferences (theme, motion, sound) work the same way and are shared
by all four windows: a `localStorage` key, an `init*` before the first render,
and a `refresh*` the popup, launcher and widget call when they are shown again,
since those windows are hidden rather than closed and would otherwise come back
holding whatever was set when they went away.

---

## Responsive layout

The window is resizable down to **680x560** (`tauri.conf.json`), which is not
an arbitrary floor: half of a 1366-wide laptop screen is 683px, so that is the
width at which Windows' own snap puts this app beside the thing being worked
on. The previous minimum of 900px forbade exactly that.

It also made the responsive markup a fiction. Tailwind's breakpoints are
viewport widths, so with a 900px floor `sm:` (640) and `md:` (768) were
permanently on and every layout written below them was unreachable. The floor
is what decides which breakpoints exist at all, which is why lowering it and
doing the layout work are one change and not two.

The shell changes shape at **1024px** (`lg`), and everything below follows it
rather than picking its own width:

| At `lg` and above | Below `lg` |
| --- | --- |
| 224px sidebar, icons and labels | 56px icon rail, labels `sr-only` |
| `px-8 py-6` around the page | `px-4 py-5` |
| Two-column blocks (dashboard progress + quests, Progress statistics) | Stacked |

Three details are load-bearing:

- **The rail's labels are `sr-only`, not `hidden`.** `display: none` removes
  them from the accessibility tree, and an icon rail whose seven links have no
  accessible name is the usual way a responsive pass quietly undoes section
  84's other half. The text is always there and only stops being drawn, so the
  name comes from the same string in both layouts. `title` is what replaces it
  for a pointer. The same applies to the popup button's "open" dot: the state
  is said in the button's own name rather than hung off a decorative circle,
  because the circle moves between the two layouts and the name does not.
- **`SubNav` scrolls sideways rather than wrapping.** Five tabs fit at every
  width the window can reach, so this is a guard rather than a feature — but a
  row of navigation that grows a second line under a border drawn for one is
  worse than one that has to be swiped, and it changes the height of every
  page in the section when it does it. The scrollbar is hidden
  (`.no-scrollbar`) because a horizontal bar directly under a tab row reads as
  a second border.
- **The routine builder's action rows stack below `md`.** That row already
  gives a column to the reorder buttons and another to the delete button; a
  10rem type picker beside the path field leaves the path about 300px, and a
  path is the one value in the app that is routinely longer than the box it is
  typed into.

Checked by walking all seventeen routes at 680px and comparing
`documentElement.scrollWidth` against `clientWidth`: nothing overflows
horizontally, on any of them, in either theme.

---

## Packaging and release

`npm run tauri build` produces two Windows installers in
`src-tauri/target/release/bundle/`:

| Installer | Where | Notes |
| --- | --- | --- |
| NSIS | `nsis/Routine Launcher_<version>_x64-setup.exe` | The one to hand out |
| MSI | `msi/Routine Launcher_<version>_x64_en-US.msi` | For Group Policy / `msiexec` deployment |

`target/` is not in the repository, so the NSIS one is also copied to
`installers/` — `npm run installer:build` builds and copies, `npm run
installer:collect` copies a build that already happened. That is the file to
link somebody who wants to install the app without cloning and building it,
and it is why one binary per version is worth carrying: the alternative is
telling people to install Rust first. It costs ~4 MB of clone size per release
**permanently**, because git keeps every blob that was ever committed and
replacing the file next version does not remove the last one. At a few
releases a year that is noise; if it ever stops being noise, drop the folder
and point people at the GitHub Release instead.

The two are not the same thing. `installers/` is a convenience copy on `main`;
the GitHub Release is what the updater reads, and only that carries the signed
`latest.json`. Neither the tag nor the release is created by copying the file
here.

Releases keep the copy current by themselves:
`.github/workflows/sync-installer.yml` fires when a release is **published**,
downloads its `-setup.exe` and commits it to `main`. Published and not tagged,
because `release.yml` publishes a draft and a draft is a release nobody has
looked at yet — syncing on the tag would put a binary in front of anyone
browsing the repository before the check the draft exists to allow, and would
strand an installer on `main` for a version that was never released if the
draft is deleted instead. The file is downloaded from the release rather than
rebuilt, so it is byte-for-byte the one the release serves and the updater
installs; a rebuild could differ, and then two different binaries would carry
the same version number. `npm run installer:build` remains the path for a
build that is not going to be released.

Both installers are configured in `src-tauri/tauri.conf.json > bundle`:

- **Per-user install** (`nsis.installMode: "currentUser"`). The app writes only
  to its own `AppData` directory and its startup entry is under `HKCU`, so
  there is nothing it needs Administrator for — and asking for elevation the
  app cannot justify is how a small utility gets refused.
- **A frozen MSI `upgradeCode`.** Windows uses it to decide that a new MSI
  replaces the installed one instead of sitting beside it. It is a UUIDv5 of
  the bundle identifier, and it **must never change** — a new upgrade code
  turns every future release into a second copy of the app.
- **`allowDowngrades: false`.** An interactive install of an older build over
  a newer one is refused, because the database only migrates forwards. It does
  **not** cover a silent (`/S`) install &mdash; NSIS makes the comparison in
  the reinstall page's pre-function and `/S` skips pages &mdash; so the app
  refuses a database from a later build itself, in `db::init_db`. See *Release
  testing* below.
- **WebView2 by download bootstrapper**, silently, and skipped when the
  runtime is already there — which on Windows 11 it always is.

The icons in `src-tauri/icons/` are the standard Tauri set and all of them are
wired up: the `bundle.icon` array carries the three PNGs, the 512px `icon.png`
and both platform bundles (`icon.ico`, `icon.icns`). The `.ico` holds 16, 32,
128 and 256px layers, which is what lets one file serve the title bar, the
taskbar, Alt-Tab and the installer. It is also the tray icon — `services/tray.rs`
takes `default_window_icon()` rather than loading a second file, so the icon in
the notification area can never drift from the one on the window.

### Versioning

Semver, `major.minor.patch`, no pre-release or build metadata — the MSI version
field has nowhere to put them, so `npm run version:set` refuses a version the
app could not ship.

- **patch** — fixes and polish; no new database migration.
- **minor** — new features, new migrations. Upgrading is install-over-the-top
  and `db::init_db` runs whatever migrations are new.
- **major** — reserved for a release that cannot read an older database.

Below 1.0.0 the app is pre-release and minor is the working bump.

The number lives in five places (`package.json`, `package-lock.json`,
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`).
`npm run version:set -- <version>` writes all five and `npm run version:check`
proves they agree; commit them together, so no build is ever ambiguous about
what it is. The installer's number comes from `tauri.conf.json`, and that is
also what `get_app_version` reports to the About card in Settings — so what the
app says about itself and what Apps &amp; features lists cannot disagree.

Two rules the Windows installers impose: the version must only ever go **up**,
and a version must never be reused for two different builds. Windows compares
versions to decide what an upgrade is, so a rebuilt 0.2.0 will simply refuse to
replace the 0.2.0 already installed.

Tauri can read the version out of `package.json` instead (`"version":
"../package.json"`), but it resolves that path against the working directory
rather than against the config file — so whether it works depends on where the
build was launched from. An explicit number plus a script is the version of
that which cannot be run from the wrong folder.

### Start-up

Settings &rsaquo; Start-up registers the app under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, via
`tauri-plugin-autostart`. Three things about it are deliberate:

- **The registry is the state.** Nothing is mirrored into the `settings`
  table, so the switch agrees with Task Manager's Startup tab even when the
  user has been turning the app off from there. The backend re-reads the
  registry after writing it, so a `Run` key managed by policy leaves the
  switch where it really is rather than where it was clicked.
- **It goes through a command, not the plugin's JS API.** The `autostart`
  permission is in no capability. A registry write is a native OS operation,
  so it takes plan §86's route — `appService` &rarr; `commands/app_info.rs`
  &rarr; `services/startup.rs`.
- **A start-up launch stays in the tray.** The registry entry carries
  `--autostart`, and a run that sees it on its command line leaves the main
  window hidden. That is why the main window is configured `"visible": false`
  and `services::startup::present_main_window` is what shows it — starting
  visible and hiding in `setup` would still put a window on screen for a
  frame. The one thing that overrules it is a tray that failed to build:
  hidden behind an icon that does not exist is an app with no way in.

### Updates

The app updates itself, through `tauri-plugin-updater`. On launch it asks

    https://github.com/zhongxuen/routine-launcher-productivity-system/releases/latest/download/latest.json

for the newest release, and Settings &rsaquo; Updates is where the answer is
shown and where the installing is pressed. A found update is downloaded, its
minisign signature verified against the public key baked into
`tauri.conf.json`, and the NSIS package run &mdash; which is the same
install-over-the-top the user would perform by double-clicking the next
`-setup.exe`, so it keeps the database for exactly the reason a manual upgrade
does: nothing in the process touches `%APPDATA%`.

**The check and the install are separate, and only the check is automatic.**
There is no "install automatically" setting because there is no such mode: the
one switch decides whether the app *looks*. It defaults on &mdash; an updater
nobody switched on is a build that quietly rots, and this is the sort of
program that sits in a tray for months between the times its owner thinks
about it &mdash; and it costs one request per launch.

**Nothing is sent.** The check is a `GET` for a static JSON file and the
download is a `GET` for a static installer; neither carries a request body, an
identifier, or anything read out of the database. Section 68's promise is
about the user's data, and the user's data does not leave. It is worth stating
precisely rather than loosely now that the process can open a socket at all,
which is why Settings says in words what the check consists of and why the
About card no longer claims the app never contacts anything.

Two things happen through this app's own commands rather than through the
plugin's JavaScript API, which is granted to no window (`updater:default` is in
no capability, exactly as `autostart:default` is not):

- **The running focus session is closed first.** `Update::install` ends with
  `std::process::exit(0)` on Windows, so no window receives a close event and
  the `CloseRequested` handler in `lib.rs` &mdash; the thing that normally
  records an interrupted session &mdash; never runs. The next launch would
  catch the stale row, but it would blame "the last run" for something the
  user did on purpose.
- **Nothing downloads without a press.** A JS route to "download and execute
  an installer" is worth not having in a window that renders text the user did
  not write.

#### Signing keys

Updates are only accepted if they are signed by the key whose public half is
`plugins.updater.pubkey` in `tauri.conf.json`. The private half lives **outside
this repository**, at `~/.tauri/routine-launcher.key`, and `.gitignore` blocks
`*.key` as a second line of defence.

Two rules, and both are one-way doors:

- **Losing the private key means shipped builds can never be updated again.**
  Every installed copy verifies against the public key it was built with, so
  there is no way to re-sign your way out of it &mdash; the fix is asking every
  user to install by hand.
- **Rotating the key strands everyone on the old one.** Changing the `pubkey`
  is safe only while no build carrying the old one is installed anywhere. It
  is free right now, before the first public release; it is not free after.

The key as generated has **no password**, which is worth fixing before the
first release for the same reason &mdash; it is free now and expensive later:

    npx tauri signer generate -p "<password>" -w ~/.tauri/routine-launcher.key -f

then copy the new `.key.pub` contents into `plugins.updater.pubkey`.

#### Releasing

`.github/workflows/release.yml` runs on a `v*.*.*` tag: it checks the five
version files agree (`npm run version:check`), builds, signs, and publishes the
installers together with `latest.json` as a **draft** release. A draft is
invisible to `releases/latest`, so nothing is offered to anybody until the
artifacts have been looked at and Publish pressed. The workflow needs two
repository secrets, `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; without them the build still succeeds and
produces no signature, and the updater refuses an unsigned manifest &mdash;
which is a failure mode worth recognising, because it looks like "the update
never appears" rather than like an error.

---

### Release testing

Section 85's checklist is run against the built installers rather than against
`tauri dev`, because most of what it asks about only exists once there is an
installer: an upgrade code, a `Run` key, an `%APPDATA%` that belongs to an
installed app rather than to a dev session.

| Checked | How |
| --- | --- |
| Fresh installation | NSIS `/S` onto a profile with no `%APPDATA%` folder and no uninstall registration |
| Upgrade | The previous version installed and used, then the next one installed over it |
| Uninstall | `uninstall.exe /S`, then the install directory, registration, shortcuts and user data |
| Reinstall | Installing again onto the data the uninstall left |
| Database migration | Every shipped schema version seeded into `app.db`, then the installed app run against it |
| Missing applications / files / broken paths | `services::routine_exec` tests, against the real filesystem |
| Permissions | An unopenable `app.db`, and the launch-failure codes Windows returns for one |
| The section 94 loop | `services/mvp_loop_tests.rs`, end to end through the services that implement it |

Five of those found something.

- **Migrations were not atomic.** Each one's SQL and its `_migrations` row
  were separate autocommits, so an upgrade interrupted between them left the
  schema changed and the bookkeeping saying it was not. The next launch
  re-ran the migration &mdash; and `0003` and `0004` are `ALTER TABLE ... ADD
  COLUMN`, which fails with "duplicate column name" the second time, and
  `init_db` treats a migration that will not apply as fatal. The app would
  have refused to start, on every launch, with no way back. Each migration is
  now one savepoint (a savepoint and not a transaction, because
  `db::rebuild` calls the runner from inside one the caller opened).
- **A start-up that could not finish said nothing at all.** See the section
  below.
- **A broken application target blamed the wrong thing.** Pointing an
  Application action at a folder reported "Access is denied", which is what
  Windows says and reads as a permission problem; with a trailing separator
  it reported "program path has no file name", which reads as a bug. Both now
  say the target is a folder, the way the Folder and File actions already do.
  Elevation, invalid path characters and "not a program Windows can run" get
  sentences of their own for the same reason: §87 puts the message next to a
  Retry button, and a user who cannot tell "the drive is not mounted" from
  "you picked the folder" has no way to know whether retrying is worth
  anything.
- **`allowDowngrades: false` does not cover a silent install.** NSIS computes
  the installed-versus-installer comparison in the *reinstall page's*
  pre-function, and `/S` skips pages &mdash; so the guard in the template's
  `EarlyChecks` section reads a variable nothing has set, and an older package
  replaces a newer one without complaint. Verified: 0.1.0 installed silently
  over 0.1.2 and the registration went backwards. Interactive installs are
  unaffected. The app now refuses the situation itself: `init_db` compares the
  schema recorded in `app.db` against the newest migration the running build
  carries, and a database from the future is reported and left untouched
  rather than read and written by a build that does not understand it.
- **Completing a task did not update the progress beside it.** `progressStore`
  re-read on mount, so the dashboard picked up XP when the user *arrived*
  rather than when they earned it &mdash; ticking a task off in Today's Tasks
  left the Progress card next to it showing the old level, streak and total
  until the user navigated away and back. That is section 94's last arrow
  failing in the one screen where the whole loop is visible at once. The three
  stores whose writes earn XP now announce it (`src/lib/progress-events.ts`)
  and `useProgressSync` re-reads.

### Crash and error logging

Everything that goes wrong is written to
`%APPDATA%\com.zhongxuen.routinelauncher\logs\routine-launcher.log`, and
nowhere else. Settings &rsaquo; Diagnostics shows the path and opens the folder.

**It is never transmitted.** Section 68's promise is that the data stays on the
machine, and a crash reporter is the feature most likely to break that by
accident, so `services::logging` has no network code and no dependency that
could acquire any. There is no "send report" button, and the frontend cannot
read the file back either &mdash; it is given the path and a button that opens
Explorer, which is all a user needs and the least the app can hand out.

Four things end up in the one file, in the order they happened:

- **Rust panics.** `logging::install_panic_hook` is armed at the top of `run()`,
  before the Tauri builder exists, and records the payload, the thread, the
  location and a backtrace. It chains to the previous hook, so `tauri dev`
  still prints panics to the terminal. Anything recorded before `setup` has
  resolved the app data directory is held in memory and written the moment the
  file opens &mdash; which is how a panic during plugin setup, the one crash
  that happens before there is anywhere to put it, still gets recorded.
- **Handled backend failures.** The `log_error!` / `log_warn!` / `log_info!`
  macros replaced every bare `eprintln!` in the backend, so a tray that would
  not build or a shortcut Windows refused is now in the file rather than on a
  console nobody was watching. They still print to stderr as well.
- **Frontend crashes.** `AppErrorBoundary` wraps all four windows and reports
  through `log_frontend_error`, as do the `error` and `unhandledrejection`
  listeners `installCrashLogging` adds &mdash; the latter two matter more,
  because an error boundary only sees exceptions thrown while rendering and
  most of this app's failures are awaited calls inside event handlers.
- **Command actions.** §66's audit echo of the exact command line a routine
  ran is now a log line rather than a bare `eprintln!`, so it survives the
  session it was launched in.

The frontend logs *through Rust* rather than into a file of its own, so a crash
in a webview and the panic in the process hosting it can be read against each
other &mdash; usually the only way to tell which one caused the other.

Rotation is three files of 512 KB: `routine-launcher.log` is the active one,
and when a write would take it over the limit it becomes `.1.log`, `.1` becomes
`.2`, and `.2` is deleted. The folder never exceeds 1.5 MB. Nothing is
buffered, because a `BufWriter` loses the last line before a hard crash and the
last line is the one the file exists for.

Timestamps are UTC, unlike every other date in the backend &mdash; the first
thing worth logging is the database failing to open, and a panic that is
already unwinding is the worst moment to be taking the lock on a connection to
ask what the local offset is. Every line is stamped `Z` so it cannot be
misread.

#### A start-up that cannot finish

Two steps in `setup` have no recovery &mdash; resolving the app data directory
and opening the database &mdash; and both used to `expect`. In `tauri dev` that
is a readable panic on the console; in the shipped app it was nothing at all.
`main.rs` builds with `windows_subsystem = "windows"`, so there is no console
for a panic to print to, and the main window is created hidden, so there is no
window either. The app could be double-clicked all morning and simply not
appear: the process started, wrote to a log the user had no way of knowing
about, and vanished. Every realistic cause is a `%APPDATA%` the user could
have fixed &mdash; a roaming profile that did not sync, antivirus holding the
file, a folder they have no rights to &mdash; if anything had told them which
one it was.

So `logging::fatal` writes the failure to the log, puts it on screen with the
log's path, and exits 1. Two details are load-bearing:

- **It is `MessageBoxW`, not `tauri-plugin-dialog`.** The plugin's
  `blocking_show` dispatches through `run_on_main_thread` and then waits for
  the answer, and `setup` *is* the main thread &mdash; it would deadlock rather
  than report anything. Its own documentation says not to.
- **The box is shown from a thread of its own.** A modal dialog pumps its
  thread's message queue while it is up, so calling it on the main thread
  dispatches the app's own window messages straight back into Tauri &mdash;
  whose handlers then ask for the database connection that `setup` never got
  as far as managing. `state()` panics inside an FFI callback that cannot
  unwind, which aborts the process: the dialog appeared and was torn off the
  screen a fraction of a second later, which is worse than not showing one.
  A thread that owns no windows pumps only its own empty queue, so the main
  thread sits still until the user clicks OK.

The same reasoning is why every `state::<DbConnection>()` reachable from a
window event or a tray menu item is now `try_state`: those are all callbacks
that cannot unwind, so a database that is not there yet has to be a logged
warning and not an abort.

The third way a start-up can fail is the Tauri runtime itself refusing to
build, which in practice means WebView2 is missing or damaged. That is
reported the same way, and says so, because the fix is a reinstall of the
runtime rather than of this app.

When a window's React tree does throw, `CrashFallback` stands where it was:
what happened, the log's path, a button that opens the folder, and *Try again*
before *Reload the window* &mdash; most render crashes are one bad value and
survive a remount, while a reload throws away whatever was half-typed. The path
it shows is read at startup and held in memory, because a screen that only
appears when the app has broken cannot be the one that depends on a call
succeeding.

---

## Security posture

- Filesystem access is **not** granted to the frontend. All native OS
  operations go through explicit Rust commands (plan §86).
- Launch-at-startup writes the `HKCU` `Run` key through this app's own
  command; the `autostart` plugin permission is granted to no window, so a
  script in the main webview has no second route to it (plan §85, §86).
- The updater is the only part of the app that opens a socket, and it is
  granted to no window either: `updater:default` is in no capability, so the
  check and the install go through `commands/updates.rs`. Both requests are
  bodyless `GET`s for static files — a manifest and an installer — and the
  manifest is rejected unless its minisign signature matches the public key
  the running build was compiled with. The launch check can only ever report;
  downloading and running an installer is always a press in Settings
  (plan §68, §85, §86).
- The crash log is local-only and write-only from the frontend's side: the
  three diagnostics commands write an entry, report the path and open the
  folder. None of them reads the file back, and nothing in the app can send
  it anywhere (plan §68, §85).
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

All fourteen phases have been built, and every phase's `Build:` list is now
checked. `md-files/remaining.md` carries what is left: the plan describes it,
but no phase ever scheduled it.

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

Settings opens on **Daily**, §52's nine Daily Settings, saved together with
one Save button because they are checked together: the start and end of the
day, the default focus length, task priority and reminder, the start- and
end-of-day routines, the daily quest count and the day the week starts on.
They live in the `settings` table under `daily.*` keys
(`get_daily_settings` / `set_daily_settings`, `services/settings.rs`), and a
key that was never written reads as its default (09:00, 18:00, 50 minutes,
Normal, no reminder, no routines, 3 quests, Monday), so there is no migration.
Rust validates every field and the card shows its refusal as it is. Eight
have consumers: the Custom timer starts at the default focus length, + Add
Task opens on the default priority, the edit dialog suggests the default
reminder when a task is given its first due time (the Add task form has no due
time for "minutes before" to count back from), the dashboard shows 2 or 3
objectives, Statistics counts This Week from Monday or Sunday, Start My Day
opens the start-of-day routine (see Phase 6), and Plan Today measures the
time left against the day's start and end (below). The end-of-day routine is
only stored so far, for End My Day, and the card says so.

Categories are managed in Settings &rsaquo; Task categories: rename in place,
recolour from a palette, add, and delete. The seven seeded ones (§13) are
ordinary rows and change like any other. Deleting a category keeps its tasks —
`tasks.category_id` is `ON DELETE SET NULL` — and the confirmation says how
many tasks that is before it happens. The task forms' category select ends in
"New category…", which creates the category and selects it in one step.

Tasks &rsaquo; Today pages through days with §53's `< Today >` (previous day,
next day, back to today). It is not a calendar. The day is kept in the URL
(`/tasks/today?date=2026-09-16`), so a reload or Back keeps it, and with no
date the view is today with its carry-over, as before. Another day lists only
what was due on it. On a past day the header says that ticking a task off
records it as completed now, since nothing is backdated. On a future day the
repeating tasks it will get are shown as a read-only Repeats group. They are
still created only on their own day.

Today's page opens with **Plan Today** (§20, §51), a collapsible panel above
the list (`src/components/tasks/PlanToday.tsx`) rather than a page of its own,
since §54 does not want a project-management tool. It shows the date, the
day's **top priorities** (up to three of today's tasks, starred from the
**other tasks** beside them and put in order with up / down), the
**estimated workload** (`estimated_minutes` over today's open tasks, the same
sum as Start My Day's, with any task that has no estimate named rather than
counted as zero) and the **available focus time** (from now, or from the
day's start if it has not come yet, to the day's end in Settings &rsaquo;
Daily). When the workload is bigger it says so in one quiet line ("About 1h
20m more than the time left today"), and nothing is blocked or rescheduled.
Focus already done today is not taken off the time left: it happened before
now, so it is already outside that window. **Start My Day** opens Phase 6's
dialog on the dashboard. The priorities are the only stored part, one row per
pick in `daily_plans` (`database/migrations/0008_daily_plans.sql`) keyed by
the local date, with `ON DELETE CASCADE` from `tasks`. `get_daily_plan` /
`set_daily_plan` (`services/daily_plans.rs`) save the whole ordered list and
refuse a fourth pick, a repeat or a task that does not exist. Picked tasks
get a quiet "★ #1 today" in the list, and backups carry the table. The
dashboard's Today's Tasks card links to the panel with **Plan today**.

**Phase 3 — Routine System** ✅ complete

- [x] Routine CRUD
- [x] Action CRUD
- [x] Routine builder
- [x] Application launching
- [x] Application picker (installed programs, by name)
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
screen is the run order. The Templates tab (§64) ships four starter routines —
Coding Mode, Study Mode, Work Mode and Start My Day — which are pre-filled
`create_routine` payloads and nothing more: adding one produces an ordinary,
editable routine, and it opens in the builder so the guessed targets can be
checked before the first launch. Start My Day (§21) is calendar and email
URLs and a 10-minute timer; its "open the task dashboard" needs no action,
because the dashboard is where it is started from.

Of the five figures in §33, launches and last-used are real — the backend
stamps them inside `launch_routine`, and the store re-reads the list after
every run. Focus time, average session and tasks completed have no source yet
and are shown as a dash rather than a number, with the queries that will fill
them noted in `RoutineStatisticsDialog.tsx`. All three are now only a query
away — Phase 4 fills `tasks.routine_id`, and Phase 5 writes a `routine_id` on
every focus session `listRoutineFocusSessions` can already read back — but
each is still shown as a dash until that query is written, because a dash is
honest and a zero is not.

An `application` action does not need a path. `services::installed_apps`
reads what this computer has on it from the three places Windows keeps that
— the Start Menu (`.lnk` files, parsed for the program behind them), the
`App Paths` registry key behind Win+R, and the shell's applications folder,
which is the only one that lists Store apps — and merges them into one
catalogue of name-to-program. The builder's target field for an application
is a picker over that list (`ApplicationPicker.tsx`): type to filter, click
to choose, Browse for anything the scan missed, and a line underneath saying
which program the row will actually open. Typing is still allowed and still
stored verbatim, so nothing that worked before stops working.

The same catalogue is the last thing `routine_exec` tries when it resolves a
target, after the path and after `PATH`. That is what makes a routine saved
as `Chrome` — including one saved before the picker existed — launch Google
Chrome rather than failing: no path is on `PATH` for it, and `Chrome` is the
name on the icon. Store apps are launched by ID through the shell and cannot
take arguments, which the builder shows by hiding the arguments field for
them rather than letting the launch be the thing that refuses.

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
- [x] Custom timer — any length from 1 minute to 12 hours, plus Stopwatch.
      It starts at the default focus length from Settings &rsaquo; Daily
      (50 minutes unless changed) and follows that setting until the length
      is edited
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
- [x] Timed breaks (§34) — a completed 25/5, 50/10 or 90/15 session offers
      "Start N-minute break"; the break counts down in `focusStore`, shows in
      every window (the widget draws `Break · 4:12` in its own colour), and
      ends with a native notification, the break sound if sound is on, and
      "Start another session" with the same preset, task and routine. Skip
      and End early are always there. Custom can carry an optional break,
      set beside its length. A break is never written anywhere

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

The break after a session is the same kind of clock with none of the record.
It is held in `focusStore` only — no row, no XP, nothing in statistics,
history or streaks (§35, §36, §88) — so closing the app during one simply
loses it. The other windows learn of it through `src/lib/focus-sync.ts` on a
`focus://break` event of its own, since there is nothing in the database for
them to re-read. Every window counts it down and reaches the end, so the
"break over" notification goes through `announce_break_over` in
`commands/notification.rs`, which shows it for the first window to ask per
break and tells the rest they were not first — which is also how the sound
plays once rather than once per window.

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

**Phase 6 — Dashboard** ✅ complete

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
      both put gamification behind the productivity UI. The widget takes no
      data props, which is what let Phase 9 point `progressStore` at
      `xpService` without reopening the component — that swap has since
      happened, and §44's objectives now sit beside it
- [x] Upcoming tasks — the next few days under TODAY
      (`src/components/dashboard/UpcomingTasks.tsx`): the backend's `upcoming`
      view grouped by day, capped at five rows across all of them with the rest
      behind a link to `/tasks/upcoming`, because the dashboard is a starting
      point and not a second task page. It owns its read rather than going
      through `useTaskView`: `taskStore` holds one view at a time and
      `TodaysTasks` already owns it as `today`, so a second `useTaskView` on the
      same page would have the two widgets overwriting each other's view. It
      re-reads whenever the store's tasks change identity — every mutation ends
      in a `refresh()` — which is what keeps it in step with a box ticked in the
      block above it. Rows are the same `DashboardTaskRow` Today draws, so
      ticking one off here is the same real mutation it is there
- [x] Basic statistics — §36's TODAY panel as one row
      (`src/components/dashboard/BasicStatistics.tsx`): focus, tasks, routines
      and completion in §36's own order, with everything else — the week, the
      week's day-by-day focus, four weeks of streak history — behind a link to
      `/progress/statistics`, because the dashboard is a starting point and not
      a second analytics page. It reads the same `get_productivity_stats` that
      page reads rather than a lighter dashboard-only command: §36 is measured
      against one local `todayDate`, and a second command is how the two views
      would start disagreeing about which day it is across midnight. It
      re-reads when the task, focus or routine stores change, so a box ticked
      in the block above moves `6 / 8` here. Every figure with nothing behind
      it is a dash rather than a zero — a zero is a claim and a dash is not
      (§88) — which is stricter than the statistics page, where a caption, a
      week panel and seven bars say what a zero is relative to
- [x] Start My Day — §21's morning flow, and §89's `[ START MY DAY ]` as the
      first thing under the greeting. The button opens a dialog
      (`src/components/dashboard/StartMyDayDialog.tsx`) with §21's summary:
      tasks today, open High + Urgent tasks, and the estimated work left
      (`estimated_minutes` over today's open tasks, with the ones that have no
      estimate counted separately rather than as zero), read from the same
      `today` view as the list below it. Under that is the start-of-day routine
      from Settings &rsaquo; Daily as a checklist, ending in the 10-minute
      planning session. **START MY DAY** does not launch anything itself. It
      hands the routine to `routineStore.launchRoutine`, so what comes up is
      the ordinary §32 launch panel with its per-action results, Retry and
      Continue. Once the actions are done, the launch asks for a 10-minute
      session labelled *Planning* through `requestFocus`, the same way START
      TASK asks for a task's. The session is attached to the routine; the
      label shows on the clock, the dashboard and the widget but is not
      stored, so History shows it as the routine's session. The only XP is the
      launch's own once-a-day reward. The planning session is an ordinary
      focus session and earns what any completed session earns, so nothing
      new pays (§88). With no start-of-day routine set, the summary still
      shows, and the launch is replaced by **Choose a routine** (Settings
      &rsaquo; Daily) and **Create from template**, which adds the Start My Day
      template, makes it the start-of-day routine and opens it in the builder
      so its guessed targets can be checked. The button is hidden once today's
      start-of-day routine has been launched from anywhere, which is read off
      the routine's own `last_launched_at` rather than a flag of its own. The
      tray menu and the quick launcher both have a Start My Day item, which
      brings the main window forward and opens the same dialog on the dashboard

**Phase 7 — Notifications + Popup** ✅ complete

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
      than firing a backlog at whoever opens the laptop. Set from the Reminder
      field on the Add task form and in the edit dialog
      (`src/components/tasks/TaskReminderField.tsx`): None, 5–60 minutes
      before (which needs a due time), or at a time on the due date. The task
      row shows it ("Reminder 10 minutes before"), marked when snoozed
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
      the ones that dialog opens on unless Settings &rsaquo; Daily changes its
      priority. It stays open between adds
- [x] Quick routine launching — the mockup's `🚀 Start Coding`
      (`src/components/popup/PopupRoutineLaunch.tsx`): the most-used routine
      as a one-click button, ranked by the same `quickStartRoutines` the
      dashboard's QUICK START row uses, with the rest behind a chevron. It
      runs the same `launchRoutine`, but reports as one line rather than
      mounting §32's checklist panel — a partial run says so and points at the
      app, where Retry lives

**Phase 8 — System Tray + Global Shortcut** ✅ complete

- [x] System tray icon + menu — §27's menu, built in Rust
      (`src-tauri/src/services/tray.rs`) because its contents are database
      facts: today's `3 / 7 completed` is `tasks::list` on the `today` view,
      the same query the dashboard and the popup run, and the routines are
      `routines::top_by_use`, the same most-used ranking `quickStartRoutines`
      applies on the dashboard. The menu is rebuilt rather than patched,
      on the `app://data-changed` broadcast every write already sends and
      again when the pointer reaches the icon — which is what catches the
      things a broadcast cannot, like the date rolling over. Left-clicking
      the icon summons the §25 popup; right-clicking opens the menu
- [x] Tray quick actions — none of them are re-implemented in Rust. A menu
      item shows the main window and emits one `tray://action`, and
      `src/hooks/useTrayActions.ts` turns it into the same call the button
      for it makes: `launchRoutine` (with §32's checklist panel),
      `startFocusFor`, `openQuickAdd`, Start My Day's dialog, or a
      navigation. Only Exit is handled in Rust, because quitting is the one
      thing no window can do for itself
- [x] Close to tray — closing the main window hides it instead of quitting,
      so the tray has an app to be the "fastest access point" to. The focus
      session keeps running and the popup is kept, because neither is ending;
      Exit on the menu is the way out, and it records the session and tears
      the popup down by hand since `exit` is not a window close. A one-off
      notification says so the first time, and Settings > System tray turns
      the whole behaviour off for anyone who wants ✕ to mean quit
- [x] Configurable global keyboard shortcut — §28's `Ctrl + Alt + Space`,
      registered in Rust at startup (`src-tauri/src/services/shortcuts.rs`)
      rather than by a window, because the point of a global shortcut is that
      it works before anything is open. Rebound from Settings > Quick launcher
      by pressing the combination: a hotkey without Ctrl, Alt or Win is
      refused on both sides, since it would take an ordinary keystroke away
      from every program on the machine. A binding the OS turns down — another
      program already holding it is the usual reason — leaves the previous one
      registered and stores nothing, so a failed rebind costs nothing
- [x] Quick launcher — §28's overlay, and a third Tauri window
      (`src-tauri/src/services/quick_launcher.rs`) for the same reason as the
      popup: it has to appear over whatever the user is doing, with the app
      minimised to the tray or never opened. Undecorated, sized to its own
      contents, and gone the moment it loses focus. The search box filters
      routines *and* the quick actions; the whole window is one text field
      — arrows move a drawn selection, Enter runs it, Escape backs out of the
      add-task mode and then out of the window — because a launcher you have
      to Tab into is one you have stopped being able to type in. Routines
      launch through the same `launch_routine` and tasks are added through the
      same `create_task`; only `⏱ Start Focus` and Start My Day are handed to
      the main window, because a focus session is a clock and the clock lives
      there (and so do Start My Day's dialog and launch panel)

**Phase 9 — Simple Gamification** ✅ complete

- [x] XP — §63's `xp_transactions` ledger, not a running total
      (`src-tauri/src/services/xp.rs`): every grant is a row saying what earned
      it, so the number on screen can be explained by pointing at the rows
      behind it. The award rules are §43's, with §88's anti-farming built into
      the ledger rather than bolted beside it — the same query that asks "has
      this task already paid out?" asks "has a routine launch paid out
      *today*?", so the first launch of the day is +10 and the next twenty are
      nothing. A task pays once however often its checkbox is re-ticked, and a
      focus session has to have run to its target and lasted five minutes,
      since a stopwatch started and stopped is the button-clicking §88 is
      written about. Nothing is earnable from the frontend: the grants are
      hooked inside `tasks::update`, `focus::end` and `routines::prepare_launch`
      — the single write path of each completion — so there is no command a bug
      could call to mint XP. A failed grant is logged and dropped rather than
      rolled back, because §50 means the task stays completed even when its
      footnote cannot be written
- [x] Levels — §45's curve, exposed as `{level, xpIntoLevel, xpForNextLevel}`.
      Level *n* costs 200n XP, which makes level 4 cost 800 and reproduces the
      §45 mockup's `620 / 800` exactly. Both figures are measured from the
      start of the level, so a bar is `xpIntoLevel / xpForNextLevel` and no
      caller has to know the curve
- [x] Streaks — §46's three ways to make a day count, derived from the
      completions themselves rather than incremented by anything running at
      midnight: an app that was closed overnight has nothing that did, and a
      derivation is correct whenever it is asked. Launch days come from the
      ledger, since `routines` records only the last one and §88's rule
      conveniently writes exactly one row per day a routine was launched. A run
      ending *yesterday* is still current — today is not over — and the
      `streaks` row keeps the longest at its best-ever value, so a record
      survives the user deleting the old tasks that proved it
- [x] Achievements — the six seeded rows evaluated on every rewardable event,
      so the tenth focus session unlocks Focused as it ends rather than the next
      time someone opens the Progress page. Unlocks are guarded by the
      `UNIQUE` on `user_achievements`, so two windows racing cannot pay twice.
      Each carries how far along it is in the unit that reads best for it —
      whole hours for Deep Work, because "7 / 10" is a sentence and
      "25200 / 36000" is not — and the two with nothing to count carry none,
      since a bar reading "0 / 1" beside "Complete your first task" says
      nothing the empty tile did not. Organized counts distinct days with a
      cleanup action in one of the cleanup utilities (see "Cleanup in the
      quest system" under Phase 10), and ten of them unlock it
- [x] Daily quests — §44's TODAY'S OBJECTIVES
      (`src/components/dashboard/DailyQuests.tsx`,
      `src-tauri/src/services/quests.rs`): three a day, one each from a
      tasks / focus / routines track, or two when Settings &rsaquo; Daily says
      so (the routines track is the one dropped), and generated as a pure
      function of the date rather than rolled — so every window agrees about
      today without a table having to, and the list cannot change under the
      user mid-morning. The pool, the day's pick and the counting live in
      Rust, and `get_daily_quests` sends the day's quests with their counts
      already in them; `src/lib/quests.ts` only draws them. Progress is
      counted from work Stages 1, 2 and 4 already record, so a tick means the
      work is really done: "Complete a 25-minute focus session" needs a
      finished session of 25 minutes, and routines are counted once each from
      `routine_launches`. The routine track's harder quest pairs a launch with
      a finished session of at least the five minutes a session needs to earn
      XP, which is §88's own answer to a quest that would otherwise pay for
      pressing START twice. The boxes are icons, not checkboxes: there is no
      way to tick one by hand, so it does not invite a click it cannot honour.
      Every third day a cleanup quest takes the last slot (see Phase 10)
- [x] Progress page — §§45-47 under `/progress`
      (`src/components/progress/`): the level bar sits above the sub-nav
      because the level belongs to the section rather than to one of its three
      tabs; Streak states §46's rule under the flame rather than leaving the
      user to discover it by losing it; and the achievements grid shows the
      locked five as well as the unlocked, since a grid that hid them could
      only ever report what had already happened
- [x] Dashboard Progress widget wired to the store — the one integration point
      Stage 6 left open. `progressStore` no longer holds invented numbers: it
      reads `src/services/xpService.ts` like every other store reads its
      service, so the widget and the Progress page can never disagree
- [x] Real numbers behind the UI — `src/services/xpService.ts` reads the real
      commands, and the swap was the one file 9.2 predicted: no store,
      component or type was reopened to make it. Quest completions are the one
      thing the frontend asks for rather than reads: the checklist calls
      `complete_quest` with a quest's id when it sees the quest done, and Rust
      decides (§88). It refuses an id the pool does not know, a quest the day
      does not offer, and one whose requirement it re-counts from the database
      and finds unmet, with a sentence saying what is still outstanding. The
      quest itself is still not stored — it is a pure function of the date —
      so the row behind a completion is created at the moment it is first
      paid, keyed by the generator's own id and the day
      (`database/migrations/0006_quest_keys.sql`). That key is what makes the
      grant idempotent per quest per day: the checklist re-counts the day on
      every load, in every window, so the guard has to be somewhere both
      windows can see

**Phase 10 — Desktop Utilities** ✅ complete

§81's `Build:` list names five, and all five are below. The sixth entry is
§38's remaining utility, built after the phase closed and marked there as an
addition rather than as part of what the phase was measured against.

- [x] Downloads scanner — §§38-39 under `/cleanup/downloads`
      (`src-tauri/src/services/downloads.rs`, `src/components/cleanup/`): a
      scan of the top level of the Downloads folder, bucketed into §39's five
      categories with counts, sizes and the largest file, and a "Review
      Downloads" list behind it. The whole feature is shaped by §67's order —
      scan, show, select, confirm, act — and that order is kept by the API
      surface rather than by convention: `scan_downloads` only reads, the two
      commands that change a file take an explicit list of paths and refuse an
      empty one, and there is no "clean up everything" entry point for a quest
      or a schedule to call. The summary states what is there and offers no
      action at all; the review opens with nothing ticked, every time. Rust
      re-checks every path it is handed before touching it, so a stale list or
      a bug in a component cannot reach a folder, a symlink, or anything
      outside Downloads — §66 applied to filesystem calls. Move is offered
      beside Delete because it is the recoverable one, and a move never
      overwrites what is already in the destination
- [x] Desktop scanner — §§38, 81 under `/cleanup/desktop`
      (`src-tauri/src/services/desktop.rs`, `src/components/cleanup/`): the
      Downloads scanner's sibling — same shape, same §67 order kept the same
      way, by the API surface rather than by convention. `scan_desktop` only
      reads; the two commands that change something take an explicit list of
      paths and refuse an empty one; there is no "clean up the desktop" entry
      point for a quest, a schedule or a tray item to call. The summary states
      what is there and offers no action; the review opens with nothing ticked,
      every time. What differs is what a desktop actually is. Shortcuts are
      reported at their own size, never their target's, and nothing follows one
      to act on what it points at. Folders are listed with a count of what is
      directly inside them, never descended into to bucket their contents, and
      never offered for deletion as if they were files. Age rather than
      extension is the axis worth sorting a desktop by, so everything is
      bucketed Today / This week / This month / Older against the same clock
      the screenshot organizer uses. Both desktops are read — the per-user one
      and the Public / All Users one Windows composites into the same screen —
      each labelled, and the public one is refused for every action, because
      writing there needs elevation this app does not ask for. Rust re-validates
      every path before touching it: inside a desktop, not a symlink, not a
      reparse point, not a name Windows would refuse, still the kind of thing
      the command was asked for — §66 applied to filesystem calls. Move is
      offered beside Delete because it is the recoverable one, and a move never
      overwrites what is already in the destination
- [x] Duplicate finder — §§38, 40 under `/cleanup/duplicates`
      (`src-tauri/src/services/duplicates.rs`, `src/components/cleanup/`): a
      scan of folders the user chooses — Downloads and Desktop to start with,
      read from the OS rather than guessed — that groups files by §40's
      deterministic comparison and nothing else. The passes run cheapest
      first: a size only one file has ends the question, files that share one
      are hashed over their first 64 KiB, and only what survives both is read
      in full. That last hash is what an `Identical` group means; filename
      similarity is applied to the leftovers and reported as a separate,
      weaker `Same name` kind, because those files are known to *differ* and
      the UI must not let the two claims look alike. §67's order is kept by
      the API surface as it is for Downloads: `scan_duplicates` only reads,
      the two commands that change a file take an explicit path list and
      refuse an empty one, and nothing is pre-ticked — the oldest copy is
      marked as a suggestion behind a "Select the copies" button, not
      selected. The confirmation lists every path and names any group where
      every copy is ticked, since that is the one selection that leaves
      nothing behind. Rust re-checks each path before touching it (still
      there, a file not a folder, not a symlink), and a move never overwrites
- [x] Large file finder — §§38, 41 under `/cleanup/large-files`
      (`src-tauri/src/services/large_files.rs`, `src/components/cleanup/`): a
      walk of a folder tree the user picks from the OS folder picker,
      reporting every file over a chosen threshold largest-first with §41's
      five actions — Open, Move, Archive, Delete, Ignore — on each row. §67's
      order is kept by the API surface as it is for the three tools beside it:
      `scan_large_files` only reads, and each of the three commands that moves
      a file takes exactly one path, so there is no batch entry point a quest
      or a schedule could call and ten files means ten confirmations. Two
      things are specific to this tool. A size-ranked scan of `C:\` surfaces
      `pagefile.sys` and installed programs *first*, so every result carries a
      `protected` flag — the page and hibernation files, `%SystemRoot%`,
      `%ProgramFiles%`, `%ProgramData%`, `$Recycle.Bin`, read from the
      environment rather than assuming `C:` — and the three destructive
      actions are greyed out on those rows and refused by Rust regardless
      (§66). And Delete means the Recycle Bin, not `remove_file`, so the
      confirmation can promise the file is recoverable and be telling the
      truth. Archive is Move's one-click sibling: it files into
      `Documents\Routine Launcher Archive\YYYY-MM` by the month the file was
      last changed, with the exact destination computed in the frontend and
      shown in the dialog before anything happens. Ignore is the only one of
      the five with no confirmation — nothing on disk changes, every scan says
      how many results it hid, and the Ignored panel undoes it in one click.
      The walk never follows symlinks or junctions, skips and reports folders
      it cannot open rather than failing, and stops itself on a tree too large
      to finish, saying so instead of implying the tree was small. The scan
      takes no database connection at all and runs on a blocking thread, so a
      forty-second walk cannot hold the shared SQLite mutex or the main thread
- [x] Screenshot organizer — §42 under `/cleanup/screenshots`
      (`src-tauri/src/services/screenshots.rs`, `src/components/cleanup/`): the
      folders screenshots actually land in — `Pictures\Screenshots`, the copy
      OneDrive keeps, the Xbox Game Bar's `Videos\Captures`, Desktop, Pictures
      and Downloads — walked into §42's `Today / This week / This month`
      counts, with a Review list behind them. What counts as a screenshot is
      decided two ways, because either alone is wrong: every image inside a
      folder that exists only for screenshots, and only capture-tool filenames
      (Windows, macOS both wordings, GNOME, Spectacle, Flameshot, ShareX,
      Greenshot, Lightshot, CleanShot, Snip & Sketch) in folders that hold
      other things too — a bare timestamp is a ShareX capture in one and a
      phone photo in the other. The windows roll back from local midnight
      rather than following the calendar so each count contains the one above
      it, which is what makes the panel's three descending numbers readable on
      the 1st of a month; the UI prints the definition rather than leaving it
      to be inferred. §67's order is kept by the API surface: `scan_screenshots`
      only reads, `organize_screenshots` takes an explicit list of paths and a
      destination the user picked from the OS folder picker, and there is no
      entry point that finds files and files them. Organising means moving into
      one folder or into dated `YYYY-MM` subfolders of it — never deleting,
      never overwriting (a taken name gets a number), and across volumes the
      copy is undone if the source cannot be removed, so a file is never left
      in two places. Rust re-tests every path against the same folders the scan
      used, so a stale list or a stray `invoke` cannot move something no scan
      produced. Dates are done without a date crate: the local UTC offset is
      read once from SQLite and the rest is arithmetic, which is what lets the
      matching, the buckets and the month folders be unit-tested against a
      fixed offset
- [x] Storage overview — §§38, 66, 67 under `/cleanup/storage`
      (`src-tauri/src/services/storage.rs`,
      `src/components/cleanup/CleanupStorage.tsx`). **An addition to §81's
      five, not one of them:** §38 lists six utilities and Phase 10's `Build:`
      list schedules five, so this is the sixth, built after the phase was
      complete and leaving that list as it stands. It reports and does nothing
      else: total and free space per fixed drive, then the top-level folders of
      the user's profile with their sizes, largest first. There is no move, no
      delete, no confirmation dialog and no selection anywhere in the feature —
      not in the component, not in the store, not in the service, not in the
      three commands — so §67's scan → select → confirm → act has nothing here
      to reach past, and §66's "restrict dangerous operations" is kept by there
      being no dangerous operation to restrict. What makes a read-only page
      belong under Cleanup is where it points: every measured folder offers
      "Find large files here" and "Find duplicates here", each of which fills
      that folder into the target tool's own scan field and navigates there, so
      the acting happens under that tool's confirmations rather than this one's.
      Sizing a profile takes tens of seconds, nearly all of it `AppData`, so it
      is never done in one call: `size_profile_folder` measures exactly one
      top-level folder and the view calls it once per folder, drawing each
      figure as it lands and re-ordering the list as a row learns its own size.
      Stop is real rather than cosmetic — the overview hands out a token that
      the walk re-checks as it goes, so cancelling stops the walk already
      running and not merely the ones not yet started. A folder Windows will
      not open is counted in that row's caption and skipped, because a locked
      `AppData` subfolder is normal on every machine and not an error worth a
      red panel; a walk that hits its own entry or time limit reports "at least
      41.0 GB" with the reason beside it rather than a total it cannot stand
      behind. Junctions and symlinks are never followed, so the legacy
      `My Documents`-style reparse points in a profile cannot count the same
      bytes twice. Drive space comes from four `kernel32` calls declared in the
      service — the same approach `services::logging` takes to `MessageBoxW`,
      and free space is the figure Explorer prints so the two agree — and the
      whole feature takes no database connection and stores nothing, since a
      remembered folder size is a claim about a disk that changes every minute
- [x] Cleanup in the quest system — §§43, 44, 47, 67
      (`database/migrations/0009_cleanup_actions.sql`,
      `src-tauri/src/services/cleanup_actions.rs`). The move, delete, archive
      and organize commands of the five utilities that act on files write one
      `cleanup_actions` row after the files are handled, and only when at
      least one succeeded. The row records the utility, the action, the item
      count and the time, and never a path or a file name. Storage has no
      file actions, so it writes none. Every third day, by date, one of three
      cleanup quests ("Organize Downloads", "Tidy your Desktop", "File your
      screenshots") takes the day's last quest slot, so the day still holds 2
      or 3. It is done by one action in its own utility that day, links to that
      utility's page, and does nothing else. §67 holds because of which way the
      data flows: actions write rows, the quest and Organized read them, and
      nothing reads them to decide what to do to a file. The quest pays its
      usual +25 once a day through `complete_quest`, and the action itself
      earns nothing (§88). Organized counts days with a cleanup action, so a
      burst of deletes in one sitting is one day, not the achievement. The
      table is carried by export and import

**Phase 11 — Productivity Analytics** ✅ complete

Under `/progress/statistics` (`src-tauri/src/services/analytics.rs`,
`src/components/progress/ProgressStatistics.tsx`). One command returns the
whole tab, so every panel is measured against the same local day — split
across calls, a load that straddled midnight could leave Today and This Week
disagreeing about the date. Nothing is stored: every figure is read across
`tasks`, `focus_sessions`, `routine_launches` and `routines` at read time, so
a deleted task or an ended session simply changes what the next read says,
with no cache to keep honest.

- [x] Daily focus time — §36's `Focus: 2h 15m`, summed from sessions that ran
      to their target. Interrupted ones are excluded: they record real
      seconds, but so does a session the app was killed during, and a total a
      crash can inflate is not a total. These are the same hours §47's Deep
      Work achievement counts, so the tab and the tile cannot disagree
- [x] Weekly focus time — the same sum over the seven days of the current
      week, which starts on Monday or on Sunday as Settings &rsaquo; Daily
      says. The week is derived in SQLite (`'-6 days'`, then `'weekday 1'` or
      `'weekday 0'`) so it contains today rather than starting from it, and
      the range under THIS WEEK names its first and last weekday. Every timestamp is
      converted with `'localtime'` first — a session finished at 11pm Friday
      counts for the Friday the user was living in
- [x] Task completion rate — §36's `Tasks: 6 / 8` and `Completion: 75%`. The
      denominator is the work that was *owed*, not every task that exists:
      completed inside the window, plus still-open and due by the end of it,
      carried-over included. That is the population the Today view lists, and
      it is guaranteed rather than intended — the predicate is
      `tasks::owed_by_predicate`, shared with the views, so a superseded
      recurring instance is left out of both by one rule. A window that asked
      nothing shows a dash, not `0%`: telling someone with an empty calendar
      they are at zero percent would be a verdict on a day that never asked
      anything of them
- [x] Routine usage — §36's `Routines: 4` and §82's most-used routine, counted
      from `routine_launches` (`database/migrations/0007_routine_launches.sql`).
      A dated row per launch, because neither of the two counters that existed
      could answer "how many today": `routines.launch_count` is a lifetime
      total, and the `routine_launch` XP rows are capped at one a day by §88.
      `launch_count` stays where it is rather than being derived from the log,
      since it predates it; `prepare_launch` writes both in one transaction so
      they cannot drift. The migration seeds one row per routine from
      `last_launched_at` — the single launch whose moment is on record, not a
      back-fill of the other forty-one, which would be inventing history
- [x] Completed tasks — per day, per week, and per routine
- [x] Streak history — §82's, as four weeks of days filled where the day
      counted. The condition is §46's own — one task, one completed focus
      session, or one routine launch — so the grid is a picture of the streak
      rather than a second opinion about it. `xp::productive_days` now reads
      the launch log too, which also fixes a day that a failed (logged,
      non-fatal) XP grant used to lose
- [x] Productivity trends — the week's focus day by day, drawn against the
      week's own busiest day rather than a target: there is no correct number
      of focused hours in a day, and a fixed ceiling would invent one. Days
      still to come are dimmed rather than dropped, so the row keeps its shape
      from the week's first morning
- [x] Stage 2's deferred routine statistics — §33's five figures are all
      measured now (`list_routine_statistics`). Focus time, average session
      and tasks completed had no source when the panel was built, because
      nothing wrote `focus_sessions` and nothing set `tasks.routine_id`; Stage
      3 and Stage 4 closed both. The dash-and-footnote is gone, so a zero
      there is a measured zero — the one figure still nullable is the average,
      since no sessions is not a session of no length. Read as one grouped
      join for the whole list rather than once per card, and the two
      aggregates are joined as sub-selects so a routine's sessions cannot
      multiply its tasks. The cards show focus time and tasks completed under
      the launch line, omitted while both are zero rather than shown as a
      verdict on a routine just built

Application usage (§37) is deliberately **not** built. The plan lists it as a
"potential future feature", it needs the `app_usage` table `0001_init.sql`
deferred, and §37 is explicit that time an application is open is not
productive time. Shipping it here would have meant a panel arguing with the
page around it; if it is built later it belongs under its own heading,
labelled usage time. Left for a Tier 5 pass.

**Phase 12 — Desktop Widget** ✅ complete

- [x] Always-on-top widget window — §83's, and a real fourth Tauri window
      (`widget.html`, `src/widget.tsx`, `services/widget.rs`). Frameless, out
      of the taskbar, 300 x 260 by default, and opened at the bottom-right of
      the primary monitor's *work area* so it clears the taskbar and does not
      land on top of §25's popup. Off on a fresh install and only ever opened
      by the user, per §83's "completely optional"; a stored position that no
      longer lands on any monitor is discarded rather than restored, so
      unplugging a second screen cannot leave a window that is invisible,
      un-alt-tabbable and impossible to drag back
- [x] Task / Focus / Routine / Combined modes — §26's four layouts, under
      `src/components/widget/`, each reading the real `taskStore`,
      `routineStore` and `focusStore` rather than a widget-shaped copy: the
      checkbox is `toggleTaskCompletion`, the launch button is
      `launchRoutine`, and Pause / Finish are the Stage 4 timer. Every list
      truncates instead of growing the window — `useFittedRows` measures the
      box and counts what it dropped in one line, because a scrollbar in a
      300px window is a control you have to aim at. Staying in sync with the
      main window is two mechanisms rather than one: tasks and routines
      announce a change and each window re-reads (`window-sync.ts`), but the
      running clock has to carry its *state* (`focus-sync.ts`), because
      pausing is arithmetic in the store rather than a column in
      `focus_sessions` and a window that only re-read would resume a paused
      session
- [x] Resize, move, hide, pin, opacity — all five, all persisted under
      `widget.*` in the `settings` table, so the widget reopens where and how
      it was left. Move is the OS's own drag loop (a pointer-down anywhere
      that is not a control), resize is the corner grip, and neither is a
      window permission granted to the webview: both are Rust commands that
      clamp what they are asked for. Opacity is a five-stop control rather
      than a slider — there is nowhere to put a slider in a 300px window —
      and is painted by the widget onto a transparent window, because Tauri
      has no cross-platform window alpha. Geometry is written at most once
      every 400ms while a drag is running and flushed when it stops
- [x] Optional, and wired into the app — §83's "completely optional" made
      true rather than claimed. Settings has an "Enable desktop widget" switch
      that is off on a fresh install, the layout picker, and pin and opacity
      mirroring the widget's own two controls (the same five stops, imported
      rather than repeated); the tray menu has a Show/Hide Widget entry beside
      Open Dashboard. The switch, the tray entry and the widget's own ✕ are
      three handles on one stored value, so none of them can disagree, and
      that value is the only thing that can put the widget back after a
      restart. Hiding it hides a window and nothing else: the widget owns no
      state, so a focus session keeps running and keeps counting in the main
      window while it comes and goes

**Phase 13 — Polish** ✅ complete

- [x] Animations and transitions — one motion scale (`--duration-*`,
      `--ease-soft`) in `index.css`, with the app's own keyframes beside the
      `tw-animate-css` utilities that every `components/ui` primitive is
      written against. That package was missing until this stage, so the
      `animate-in` / `fade-in-0` / `zoom-in-95` classes on every dialog,
      popover, tooltip, dropdown, sheet and select were inert class names
      producing no CSS at all. Routed pages fade and lift in
      (`PageTransition`, keyed on the pathname so a `revealTask` does not
      remount the list it is pointing into); list items enter and leave
      (`useAnimatedList`, which holds a removed item mounted for exactly the
      length of its exit animation — the reason a task ticked off Today now
      collapses out instead of vanishing between frames); routine actions pop
      their ✓ or ✗ as each one resolves; the XP bar slides to its new value.
      Motion is a three-way setting (Full / Reduced / System, defaulting to
      System) that writes a `reduce-motion` class on `<html>`, so the in-app
      choice can disagree with Windows in both directions
- [x] Themes — light and dark, driven by a `dark` class on `<html>` from
      Settings → Appearance, shared by all four windows, and crossfaded
      rather than switched (`withThemeTransition`, skipped under reduced
      motion). Gamification stays where §50 and §88 put it: a level-up is the
      level number swelling once and nothing else — no modal, no overlay, no
      confetti, nothing to dismiss — because levelling up happens precisely
      when the user has just finished something and is about to start the
      next thing
- [x] Sound effects — off by default, and silent until explicitly enabled;
      only the exact stored string `on` counts, so a missing key, an older
      build's value or a corrupt profile all stay quiet. Five short cues
      synthesised with WebAudio rather than shipped as audio files, so
      nothing is added to §85's installer for a feature most users will leave
      off and no cue has to be fetched or decoded before it can play.
      Settings → Motion & sound, with a preview
- [x] Keyboard navigation — tab order is the DOM order everywhere (there is
      not a positive `tabIndex` in the app), with a "Skip to content" link as
      the shell's first focusable element so the eight-item sidebar can be
      stepped over rather than through. Escape now backs out of all four kinds
      of surface: dialogs and menus (Radix), the quick launcher, the compact
      popup — which previously had no keyboard way out at all, having no title
      bar of its own — and one level at a time where surfaces are stacked, so
      a half-typed quick-add costs one press to abandon and a second to close
      the window. `Ctrl+N` and the global `Ctrl+Alt+Space` were re-audited
      against everything added since Stage 8: they cannot collide with each
      other (`Alt` rules the chord out, and the launcher is a separate webview
      where the Tasks page is never mounted), but `Ctrl+N` did reach over open
      dialogs and into text fields, and now stands down for both. It also
      matches on `event.code`, so it stays under the `Ctrl+N` printed on the
      button on a non-US layout
- [x] Accessibility — every icon-only control carries an accessible name, and
      every decorative icon is hidden from assistive technology (lucide does
      the latter by default; the audit confirmed no icon leaks through). The
      sidebar and each section's tabs are named landmarks. The one piece of
      information that was mouse-only — the padlock explaining why a protected
      file cannot be deleted — is now a focusable, named button rather than a
      tooltip pinned to an `<svg>`. Colour was measured rather than eyeballed,
      in both themes: the light theme's priority and status accents, its
      `--muted-foreground`, and the focus ring all failed WCAG AA and were
      re-derived to clear 4.5:1 (text) or 3:1 (indicators) while keeping their
      hue. Two failures were structural rather than a matter of tuning — a
      focus ring at 50% alpha and a `text-muted-foreground/70` hint tier can
      never reach their target over a white surface, whatever colour is faded
      — so the ring is painted at full opacity and the hint tier became a
      token of its own, `--muted-subtle`
- [x] Onboarding — a five-step first-run walkthrough of §90's loop
      (TASK → ROUTINE → FOCUS → PROGRESS), scripted from §89's worked day and
      raised by the app shell rather than by a page. The two middle steps ask
      for the two things the loop cannot be demonstrated without: a task, and
      a routine picked from the existing starter templates — and the second is
      attached to the first, because a task that knows its routine is the
      whole product rather than a to-do list next to a launcher. Both create
      through the ordinary `taskStore` / `routineStore` actions, so what comes
      out is an ordinary task and an ordinary routine with no memory of the
      tour. Skippable four ways on every step (Skip tour, ✕, Escape, and a
      primary button that reads *Skip for now* until the step has been done);
      a click on the overlay deliberately is not one, being the only dismissal
      that can happen by accident. All exits are equally "seen": the gate is
      one key, `onboarding.seen`, in the `settings` table — in the database
      rather than `localStorage`, because the tour's own output lives there —
      and Settings → Getting started is the way back to a flow that is
      otherwise spent after one launch
- [x] Empty, loading and error states — one kit, in
      `src/components/common/states`, that every screen from Stages 1–12 now
      routes through: `EmptyState`, `ErrorState`, `InlineError`,
      `StaleNotice`, `ListSkeleton`, `Spinner`, and `AsyncBody`, which fixes
      their precedence in one place (loading beats error beats empty, so a
      failed read can never flash "nothing here yet" and tell the user their
      data is gone when it is only unreachable). Each has one job: a block
      state stands *instead of* content that never arrived, `InlineError`
      stands *next to* content when only the write failed, and `StaleNotice`
      stands *under* content that is real but one read out of date — which is
      why a dashboard card whose background refresh fails keeps its numbers
      instead of blanking to a skeleton. Every skeleton and spinner is a
      named `role="status"` region, so a wait is announced rather than
      silent. Four screens shipped with a first-load failure that was not
      reachable at all and showed a permanent skeleton — the Progress widget,
      the Progress page's level and streak, and a routine's statistics panel,
      whose figures are a second query that failed silently and now carries
      its own error and retry; two more, the quick launcher and the day's
      objectives, answered a failed read with their empty state. Retry is on
      the failure itself everywhere it can help, including the three windows
      that have no navigation and no toaster to fall back on
- [x] Error handling — §87's contract (say which step failed, offer to run it
      again) extended down to everything smaller than a routine run: a failed
      save, a failed tick, a failed reminder action and a failed scan each
      report next to what was being changed rather than replacing it, and are
      dismissible where the user may simply want them gone. Cleanup's five
      tools distinguish "we could not look" from "there is nothing there" —
      never the same answer — and a rescan that fails after one that worked
      keeps the older results on screen under a line saying exactly that,
      because everything the user ticks next is ticked against them
- [x] Responsive layouts — the window minimum came down from 900x640 to
      680x560, which is what makes the rest of this line mean anything: with
      a 900px floor every `sm:` and `md:` variant in the app was permanently
      on and every layout below them unreachable. 680 is half a 1366-wide
      laptop screen, so the app can be snapped beside the thing being worked
      on. The shell changes shape once, at `lg`: the sidebar becomes a 56px
      icon rail whose labels are `sr-only` rather than `hidden` — an icon
      rail with seven unnamed links is how a responsive pass undoes the
      accessibility one — and the page's gutter halves. `SubNav` scrolls
      sideways rather than wrapping onto a second line, and the routine
      builder's action rows stack below `md` rather than leaving a path field
      300px wide. Verified by walking all seventeen routes at 680px:
      `scrollWidth` equals `clientWidth` on every one

**Phase 14 — Packaging** ✅ complete

- [x] Windows installer — NSIS and MSI, per-user, with a frozen MSI upgrade
      code so a new release replaces the installed app instead of sitting
      beside it, and downgrades refused because the database only migrates
      forwards
- [x] Application icon — the full Tauri set wired into `bundle.icon`,
      including the 512px PNG and both platform bundles; the same `.ico`
      serves the window, the installer and the tray, because the tray takes
      `default_window_icon()` rather than loading a second file
- [x] Auto-start option — Settings &rsaquo; Start-up, read from and written to
      the `HKCU` `Run` key so it agrees with Task Manager rather than with a
      cached preference, and behind this app's own command rather than the
      plugin's JS API. A run that began at boot recognises itself from the
      `--autostart` on its command line and stays in the tray
- [x] Versioning — semver across the five files that carry the number, with
      `npm run version:set` to write them and `npm run version:check` to prove
      they agree; shown in Settings &rsaquo; About from the bundle, so the app
      and Apps &amp; features cannot disagree
- [x] Update strategy — `tauri-plugin-updater` against `latest.json` on
      the repository's GitHub Releases, verified by minisign against the
      public key in `tauri.conf.json`, installed by running the NSIS package
      over the top so the database is kept for the same reason a manual
      upgrade keeps it. The check and the install are separate and only the
      check is automatic: there is no "install automatically" setting because
      there is no such mode, and the one switch — on by default, one request
      per launch — decides whether the app looks. Nothing is sent; both
      requests are bodyless `GET`s for static files. It goes through this
      app's commands rather than the plugin's JS API (`updater:default` is in
      no capability, as `autostart:default` is not), which is what lets the
      running focus session be recorded before `Update::install` calls
      `exit(0)` and no window ever sees a close event.
      `.github/workflows/release.yml` builds, signs and publishes a *draft*
      release on a `v*.*.*` tag — a draft is invisible to `releases/latest`,
      so nothing is offered until a human presses Publish
- [x] Backup / import — §69's Export, Import and Reset under Settings &rsaquo;
      Data, as one `routine-launcher-backup.json` carrying every table: tasks,
      routines, focus sessions, XP, achievements, quests, streaks and
      settings. The rows are read by asking SQLite what the columns are rather
      than by naming them, which is what keeps the round trip lossless across
      the columns migrations 0003, 0004 and 0006 added and across the ones the
      next migration will. Import is a replacement, not a merge — ids are kept
      so a focus session still points at the task it was worked on — and it is
      two steps, because a confirmation built from a file that has actually
      been read is the difference between agreeing to *that backup* and
      agreeing to a filename. The whole restore is one transaction over a
      schema dropped and rebuilt from the migrations, so a file that turns out
      to be inconsistent leaves the existing data untouched; Reset is the same
      rebuild without the insert, behind a typed confirmation, because it is
      the one destructive action in the app that cannot show the user what it
      is about to take
- [x] Local crash and error logging — one rotating file under the app's
      data directory, written to by Rust panics, by every handled backend
      failure (the `eprintln!`s became `log_error!`), and by all four
      React windows through their error boundary and their `error` /
      `unhandledrejection` listeners. Never transmitted, and not readable
      from the frontend either. A window whose tree throws shows what went
      wrong and where the log is instead of going blank; Settings &rsaquo;
      Diagnostics shows the same path and opens the folder
- [x] Install / upgrade / uninstall / reinstall testing — the NSIS package
      driven through the whole lifecycle on a profile emptied first: a fresh
      install onto no `%APPDATA%` and no registration, an upgrade over the
      previous version with a task, a routine and a focus session already in
      it, an uninstall, and a reinstall onto the data the uninstall left.
      Checked at every step: one registration and not two, the version Apps
      &amp; features shows against the version on the executable, the Start
      Menu and desktop shortcuts, and that the app still starts and shows its
      window. Uninstalling deliberately keeps the user's data
      (`deleteAppDataOnUninstall` is off), which is what makes the reinstall
      find it. The one thing that did not hold was the downgrade guard: `/S`
      installed 0.1.0 over 0.1.2 without complaint, because NSIS decides that
      question on a page a silent install never shows — so `db::init_db` now
      refuses a database written by a later build than the one reading it,
      and says so rather than quietly working on a schema it does not know
- [x] Migration and broken-path testing — every schema version that has ever
      shipped seeded into a real `app.db` and the installed app run against
      it, seven times, checking each one arrives at the current schema with
      the user's rows intact, the newer columns defaulted onto them, the
      seeds that post-date the database applied once, and a clean log. The
      migration runner itself gained the tests it never had, including the
      one that matters most: a migration that fails halfway leaves nothing
      behind. It could not, before — the SQL and the `_migrations` row were
      separate autocommits, and an upgrade interrupted between them would
      re-run an `ALTER TABLE ... ADD COLUMN` that cannot run twice, leaving
      an app that refused to start on every launch afterwards. Broken paths
      are covered against the real filesystem: a missing drive, a name that
      is not on `PATH`, a folder given to an application action, a file given
      to a folder action, characters Windows does not allow in a path, and
      the two Windows error codes worth their own sentence (elevation
      required, and not a program at all)

---

## Documentation convention

Every Markdown file in this repository except `md-files/development-plan.md`
carries a checklist of its own scope, and those checklists are updated as part
of the work they describe — not afterwards as a separate pass.

- [x] `README.md` — phase checklist above
- [x] `remaining.md` — its own checklist of what is not built
- [ ] Future docs — add a checklist when the file is created
