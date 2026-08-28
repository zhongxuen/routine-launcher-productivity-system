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
src/                    React frontend
  components/           Feature components (dashboard, tasks, routines, focus,
                        cleanup, progress, widget) + common shell + ui/ (shadcn)
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
  capabilities/         Tauri permission grants

database/migrations/    Numbered .sql migrations, embedded at compile time
```

The `@/` alias maps to `src/`.

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
- Routine actions that execute commands must be explicitly configured by the
  user and shown verbatim before running (plan §66).

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

**Phase 2 — Task System** ⬅ current

- [ ] Task CRUD
- [ ] Today view
- [ ] Upcoming view
- [ ] Inbox view
- [ ] Completed view
- [ ] Priorities
- [ ] Due dates
- [ ] Categories
- [ ] Recurring tasks
- [ ] Task completion

**Phase 3 — Routine System**

- [ ] Routine CRUD
- [ ] Action CRUD
- [ ] Routine builder
- [ ] Application launching
- [ ] File launching
- [ ] Folder launching
- [ ] URL launching
- [ ] Action ordering

**Phase 4 — Task + Routine Integration**

- [ ] Assign a routine to a task
- [ ] "Start task" launches the assigned workspace
- [ ] Focus timer starts with the launched routine

**Phase 5 — Focus System**

- [ ] Pomodoro timer
- [ ] Custom timer
- [ ] Focus history
- [ ] Task association
- [ ] Routine association
- [ ] Completed / abandoned session tracking

**Phase 6 — Dashboard**

- [ ] Today's tasks
- [ ] Quick routine launcher
- [ ] Current focus
- [ ] Daily progress
- [ ] Upcoming tasks
- [ ] Basic statistics

**Phase 7 — Notifications + Popup**

- [ ] Task reminders
- [ ] Focus completion notification
- [ ] Compact popup window
- [ ] Quick task creation
- [ ] Quick routine launching

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
