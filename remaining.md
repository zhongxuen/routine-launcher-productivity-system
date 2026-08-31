# Remaining Work

What is specified in `md-files/development-plan.md` and is **not** in the build,
with a ready-to-run prompt for each one.

Derived from three places, in this order: the phase checklists in `README.md`
(the live status of the build), the `Build:` list of each phase section in the
plan (§72–85), and the plan's own priority tiers (§92). An item is listed here
only if the code was checked and it is genuinely absent — not if it was merely
described somewhere else in the plan.

Three tiers, and they mean different things:

- **Tier A** — named in a phase's `Build:` list. These are the only items that
  make a phase incomplete, and the only ones the README shows as `- [ ]`.
- **Tier B** — in the plan, but in no phase's `Build:` list. Nothing is behind
  schedule because of them; they were never scheduled.
- **Tier C** — §92's Tier 5, which the plan itself puts beyond this build.

Prompts follow the format of `md-files/*.txt`: one prompt is one session's work,
it names the plan sections it implements, and it states the rules that are not
negotiable rather than leaving them to be re-derived.

---

## Checklist

- [ ] A1 — Dashboard: upcoming tasks (§7, §77)
- [ ] A2 — Dashboard: basic statistics (§7, §36, §77)
- [ ] A3 — Desktop scanner (§38, §81)
- [ ] B1 — Storage overview (§38)
- [ ] B2 — Optional productivity pet (§49)
- [ ] C — Tier 5 (§92): out of scope for this build, listed for completeness

Tick an item here in the same commit that implements it, and tick its line in
the README's phase checklist at the same time — the README is the status of the
build and this file is the backlog, so they must not disagree. When Tier A is
empty, every phase in the README reads ✅ complete.

---

# Tier A — outstanding phase work

Three items. Two are Phase 6, one is Phase 10.

---

## A1 — Dashboard: upcoming tasks

**Plan** §7 (dashboard), §77 (Phase 6 `Build:` list, "upcoming tasks").

**Status.** Absent. `src/pages/Dashboard.tsx` mounts five widgets —
`TodaysTasks`, `QuickStart`, `FocusWidget`, `ProgressWidget`, `DailyQuests` —
and there is no upcoming block among them. The query itself exists and is
already used elsewhere: `listUpcomingTasks` in `src/services/taskService.ts`
(the backend's `upcoming` view), drawn today by `/tasks/upcoming`.

**Why it is not there.** §7's mockup does not draw it. The dashboard was built
to that mockup, and "upcoming tasks" appears only in §77's build list, so what
is missing is a block the plan asks for in one place and does not illustrate in
the other.

**The constraint that decides the implementation.** `useTaskView` is not usable
here. `src/stores/taskStore.ts` holds a *single* `view` at a time (`view:
TaskView`, set by `loadView`), which is exactly right for the five routes under
`/tasks` where one view is on screen at a time — and wrong for a page that
wants two at once. `TodaysTasks` already calls `useTaskView("today")`; a second
widget calling `useTaskView("upcoming")` would have the two of them overwriting
each other's `view` on every render pass, and the visible symptom would be
today's list flickering into upcoming tasks and back. The upcoming widget must
own its own state and call `listUpcomingTasks` directly.

```text
--- Prompt A1 — Dashboard Upcoming Tasks ---
Add the upcoming-tasks block to the dashboard (development-plan.md sections 7
and 77). New component src/components/dashboard/UpcomingTasks.tsx, mounted by
src/pages/Dashboard.tsx below TodaysTasks and above QuickStart — section 7 puts
today first and the whole page is ordered by section 7's stated priority, so
upcoming sits under today, not beside it.

Read listUpcomingTasks from src/services/taskService.ts into the component's own
state. Do NOT use useTaskView: src/stores/taskStore.ts holds one view at a time,
TodaysTasks already owns it as "today", and a second useTaskView on the same
page would make the two widgets fight over it. The component owns its read, its
loading state and its error state, like every other widget on that page —
Dashboard.tsx is composition only and must stay that way.

Group by day using formatDayHeading from src/lib/task-utils.ts so the headings
match the ones /tasks/upcoming already draws. Cap the list the way TodaysTasks
caps its own, with the remainder behind a link to /tasks/upcoming rather than a
longer list — the dashboard is a starting point, not a second task page. Reuse
DashboardTaskRow so a row behaves identically in both blocks, ticking included.
Empty state: the shared kit in src/components/common/states/, saying there
is nothing scheduled — not an empty card.

Update the README's Phase 6 checklist and remaining.md's checklist in the same
commit.
```

---

## A2 — Dashboard: basic statistics

**Plan** §7 (dashboard), §36 (the figures), §77 (Phase 6 `Build:` list, "basic
statistics").

**Status.** The numbers exist; the dashboard block does not. Phase 11 built the
whole of §36 — `src-tauri/src/services/analytics.rs` behind one command,
`getProductivityStats` in `src/services/analyticsService.ts`, drawn by
`src/components/progress/ProgressStatistics.tsx` under `/progress/statistics`.
What is missing is a dashboard-sized summary of them.

**Why it is not there.** Same reason as A1: §7's mockup draws Tasks, Quick
Start, Focus and Progress and no statistics block. Phase 11 satisfied §36 by
building the statistics *page*, which is where the figures belong in full, and
left §77's dashboard summary unbuilt.

**What to watch.** `get_productivity_stats` returns the whole tab in one call so
that every panel is measured against the same local day. Calling it from the
dashboard is therefore cheap and correct — one call, one day. Do not add a
second, dashboard-only command that measures the day again; two commands is how
the dashboard and the statistics page start disagreeing about what "today"
means across midnight.

```text
--- Prompt A2 — Dashboard Basic Statistics ---
Add the basic-statistics block to the dashboard (development-plan.md sections 7,
36 and 77). New component src/components/dashboard/BasicStatistics.tsx, mounted
by src/pages/Dashboard.tsx above the progress row — sections 7 and 50 keep
gamification at the foot of the page, so statistics go above ProgressWidget and
DailyQuests, never below them.

Read getProductivityStats from src/services/analyticsService.ts. That single
command already returns the whole of section 36 measured against one local day;
use it as-is and add no new command, so the dashboard and /progress/statistics
cannot disagree about what today is.

Show a summary, not the tab: section 36's four headline figures — today's focus
time, tasks completed over tasks due, completion rate, routines launched — as
one compact row of labelled numbers, with a link to /progress/statistics for
everything else. Reuse the formatting helpers in src/lib/analytics-utils.ts so
a duration or a percentage is written the same way in both places.

A figure with no data is a dash, not a zero — the same rule the routine
statistics dialog follows, and for the same reason: a zero is a claim and a dash
is not. Loading and error states from the shared kit in
src/components/common/states/.

Update the README's Phase 6 checklist and remaining.md's checklist in the same
commit.
```

---

## A3 — Desktop scanner

**Plan** §38 ("Desktop Cleanup", in the utilities list), §81 (Phase 10 `Build:`
list, "Desktop scanner").

**Status.** Routed and reachable, and empty behind it.
`src/routes.tsx` maps `/cleanup/desktop` to
`src/components/cleanup/CleanupDesktop.tsx`, which is seven lines returning
`PlaceholderView`. It is the only `PlaceholderView` left in `src/`. There is no
Rust service and no command.

**Why it is not there.** It is the one Stage 10 utility that was never prompted:
`md-files/12-stage-10-desktop-cleanup-utilities.txt` contains prompts 10.1–10.4
for Downloads, Duplicates, Large Files and Screenshots, and nothing for Desktop.
It is also the only one of the five with no section of its own — §39, §40, §41
and §42 each carry a mockup, Desktop Cleanup is a line in §38's list. So the
prompt below has to state the shape of the feature, because the plan does not
draw it.

**What it should copy.** `src-tauri/src/services/downloads.rs` is the closest
analogue and the model to follow: a top-level scan of one well-known folder,
bucketed with counts and sizes, a review list behind the summary, and Rust
re-checking every path it is handed. The differences are what make a desktop
different from a downloads folder — shortcuts, and the fact that people arrange
their desktop on purpose.

```text
--- Prompt A3 — Desktop Cleanup / Desktop Scanner ---
Implement the Desktop scanner (development-plan.md sections 38, 66, 67, 81) —
the fifth Stage 10 utility and the one never built. Replace the PlaceholderView
in src/components/cleanup/CleanupDesktop.tsx; add
src-tauri/src/services/desktop.rs and src-tauri/src/commands/desktop.rs,
registered in the two mod.rs files and in lib.rs's invoke handler.

Model it on the Downloads utility (services/downloads.rs, components/cleanup/
CleanupDownloads.tsx + DownloadsSummary/DownloadsReview/DownloadsFileRow/
DownloadsConfirmDialog/DownloadsActionReport). Same shape, same file layout,
same typed service wrapper under src/services/ and store under src/stores/.

Scan the top level of the user's Desktop folder, read from the OS rather than
guessed, and report counts, total size and the largest item, bucketed by kind.
Two buckets exist here that Downloads does not have and they must be handled,
not lumped in with files:
  - Shortcuts (.lnk, .url). Report the shortcut's own size, never the target's,
    and never follow one to act on what it points at.
  - Folders. Report them as folders with an item count; do not recurse into
    them to bucket their contents, and do not offer to delete one as if it were
    a file.
Age is the useful axis on a desktop, so bucket files by last-modified into
Today / This week / This month / Older, the way the screenshot organizer does.

Section 67's order is the API surface, not a UI convention, exactly as it is in
downloads.rs: scan_desktop only reads; the commands that move or delete take an
explicit list of paths and refuse an empty one; there is no "clean up the
desktop" entry point for a quest, a schedule or a tray item to call. The summary
states what is there and offers no action. The review opens with nothing ticked,
every time.

Section 66 applied to the filesystem: Rust re-validates every path it is handed
before touching it — inside the Desktop folder, not a symlink, not a reparse
point, still the kind of thing the command was asked for — so a stale list or a
bug in a component cannot reach anything else. Offer Move beside Delete because
Move is the recoverable one, and a move never overwrites what is already in the
destination.

Both desktops are one desktop to the user: read the per-user Desktop and the
Public/All Users Desktop, label which is which, and refuse to act on the public
one, because writing there needs elevation this app does not ask for.

Cover the scanner with Rust unit tests against a temp tree the way
services/downloads.rs and services/screenshots.rs are covered: a shortcut, a
folder, a file of each age bucket, a name Windows does not allow, and a path
outside Desktop handed to an action command.

Update the README's Phase 10 checklist and remaining.md's checklist in the same
commit; Phase 10 becomes ✅ complete when this lands.
```

---

# Tier B — in the plan, never scheduled

Neither of these is in any phase's `Build:` list, so no phase is waiting on
them. Both are listed by the plan as optional.

---

## B1 — Storage overview

**Plan** §38 (last of the six "potential utilities"), §92 Tier 3.

**Status.** Not built, and not named in §81. Of §38's six utilities, §81
schedules five; Storage Overview is the one it leaves out, and unlike Desktop
Cleanup it has no mockup section either.

**Consideration before building it.** It is the only utility of the six that
does not end in an action on a file. `/cleanup` is otherwise a set of
scan → select → act flows, and a page that only reports would sit oddly among
them unless it leads somewhere — most naturally into the large-file finder and
the duplicate finder, which are the two things a person does after seeing where
their disk went.

```text
--- Prompt B1 — Storage Overview ---
Implement the Storage Overview utility (development-plan.md sections 38, 66,
67), the sixth utility in section 38's list and the one section 81 does not
schedule. New route /cleanup/storage in src/routes.tsx with a sub-nav entry
beside the other five, src/components/cleanup/CleanupStorage.tsx,
src-tauri/src/services/storage.rs and a command registered the usual way.

Report only, and say so: total and free space per fixed drive, then the largest
top-level folders of the user's profile with their sizes, largest first. This
utility performs no file action at all — it has no move, no delete and no
confirm dialog, and therefore nothing to guard beyond the read itself.

Where it would offer an action it links instead: a large folder offers "Find
large files here" into /cleanup/large-files with that folder pre-filled, and
"Find duplicates here" into /cleanup/duplicates the same way. That is what
makes a read-only page belong under Cleanup.

Sizing a profile tree is slow and must never block: report per top-level folder
as each one finishes rather than after all of them, keep the scan cancellable,
and skip what cannot be read rather than failing the whole scan — a locked
AppData subfolder is normal, not an error worth a red panel.

Update remaining.md's checklist in the same commit, and add the utility to the
README's Phase 10 section marked as an addition to section 81's five.
```

---

## B2 — Optional productivity pet

**Plan** §49, §92 Tier 4 ("optional pet"), and §50's rule that gamification
stays visually secondary.

**Status.** Not built. It is not in §80's Phase 9 `Build:` list and not in
`md-files/11-stage-9-gamification.txt`, which prompts XP, levels, streaks,
achievements and quests and no pet. The plan flags a complex pet system as an
explicit non-goal (`✗ Complex pet system`), so anything built here is cosmetic
by definition.

```text
--- Prompt B2 — Optional Productivity Pet ---
Implement the optional productivity pet (development-plan.md sections 49 and
50). Cosmetic only: it is a face over data that already exists and it stores no
new state beyond the one setting that switches it on.

Mood is derived, never accumulated: read today's completed tasks, today's
finished focus sessions and today's quest completions from the existing
progress and quest stores, and map them to a mood bar. Nothing decays, nothing
is persisted, nothing is lost by not opening the app — section 49 says keep it
simple and section 49's closing line says it must not become a separate game,
which rules out hunger, health, currency and anything that can die.

Off by default, behind one switch in Settings > Appearance, and drawn inside
ProgressWidget's existing footprint on the dashboard — sections 7 and 50 put
gamification below the productivity system, so the pet must not gain the page a
row it did not have. Section 49's layout: the pet, a mood bar, and today's three
activity lines.

An emoji, as the mockup draws it. No sprite sheet, no animation loop, no asset
pipeline; if it moves at all it uses the existing motion scale in index.css and
respects the reduced-motion setting the rest of the app respects.

Update remaining.md's checklist in the same commit.
```

---

# Tier C — Tier 5, out of scope

§92's Tier 5 is the plan's own "Future" list. Nothing here is a gap in the
build; each is recorded so that a later reader does not mistake absence for
oversight.

| Item | Plan | Note |
| --- | --- | --- |
| Application usage tracking | §37, §92 | Deliberately not built. §37 is explicit that time an application is open is not productive time, and Phase 11 measured productive time. If built later it belongs under its own heading, labelled usage time, and it needs the `app_usage` table. |
| Rule-based productivity suggestions | §92 | Needs usage tracking first to have anything to reason over. |
| Shared routine templates | §92 | The built-in templates (§64) are three hard-coded payloads; sharing means a transport, and the app has none by design. |
| Cloud synchronization | §92 | Contradicts the local-first posture stated at the top of the README: no account, no backend, no cloud, no external API. A deliberate change of product, not a feature. |
| Cross-device synchronization | §92 | Same as above. |
| Calendar integration | §92 | First external API the app would talk to. |
| Mobile companion application | §92 | Second platform. The Tauri shell and every command in `src-tauri/` are written for Windows. |

## Schema not created

Two of §57's fifteen tables were never created, and both belong to work above:

- `app_usage` — Tier C, application usage tracking.
- `file_scan_history` — would let the cleanup utilities remember a previous
  scan. None of the four built utilities needs it: each scan reads the
  filesystem fresh, which is why a file deleted outside the app cannot leave a
  stale row behind.

Both are additive, so whichever migration eventually creates one is an ordinary
forward migration and no existing database has to be rebuilt for it.

---

## How to work through this file

One prompt per session. Each prompt is self-contained and names the plan
sections it implements, so it can be run without this file's prose in context.

A1 and A2 touch the same page and can be run in either order, but not in
parallel — both edit `src/pages/Dashboard.tsx`. A3 touches no file either of
them touches and is independent of both.

Tick the checklist at the top of this file and the matching line in the README's
phase checklist in the same commit as the work, per the documentation
convention at the foot of the README: checklists are updated as part of the work
they describe, not afterwards as a separate pass.
