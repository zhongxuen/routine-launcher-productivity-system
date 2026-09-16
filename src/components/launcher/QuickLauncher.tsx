import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";

import ErrorState from "@/components/common/states/ErrorState";
import { Skeleton } from "@/components/ui/skeleton";
import { useWindowSync } from "@/hooks/useWindowSync";
import {
  requestFocusSession,
  requestReviewMyDay,
  requestStartMyDay,
} from "@/lib/launcher-events";
import { runCounts } from "@/lib/routine-utils";
import { todayKey } from "@/lib/task-utils";
import { cn } from "@/lib/utils";
import { focusMainWindow } from "@/services/popupService";
import {
  dismissQuickLauncher,
  holdQuickLauncher,
  onQuickLauncherShown,
  setQuickLauncherHeight,
} from "@/services/quickLauncherService";
import { useRoutineStore } from "@/stores/routineStore";
import { useTaskStore } from "@/stores/taskStore";
import { refreshMotion } from "@/stores/motionStore";
import { refreshSound } from "@/stores/soundStore";
import { refreshTheme } from "@/stores/themeStore";
import type { RoutineWithActions } from "@/types/routine";

import LauncherRow from "./LauncherRow";
import { filterLauncherItems, launcherItems, type LauncherItem } from "./launcher-items";

/**
 * The quick launcher of development-plan.md section 28:
 *
 * ```text
 * ┌──────────────────────────────┐
 * │ Search...                    │
 * ├──────────────────────────────┤
 * │ 🚀 Coding                    │
 * │ 📚 Study                     │
 * │ 💼 Work                      │
 * │ + Add Task                   │
 * │ ⏱ Start Focus                │
 * └──────────────────────────────┘
 * ```
 *
 * Summoned by `Ctrl+Alt+Space` — or whatever the user rebound it to in
 * Settings — from anywhere on the machine, which is why it is a third OS
 * window and not an overlay inside the main one. See
 * `src-tauri/src/services/quick_launcher.rs` for the window, and
 * `services/shortcuts.rs` for the binding.
 *
 * **The whole thing is one text field.** Focus never leaves the search box:
 * the rows are `role="option"`, not buttons, arrows move a drawn selection
 * rather than the focus ring, and Tab is swallowed. That is what section 28's
 * "should support keyboard navigation" actually asks for — a launcher you
 * have to Tab into a list to use is one where you have stopped being able to
 * type, which is the opposite of the point. The mouse is supported by making
 * hover move the same selection, so there is only ever one current row.
 *
 * **Every row finishes here except two.** Launching a routine is the same
 * `launch_routine` the dashboard and the popup call, recorded the same way;
 * adding a task is the same `create_task` with the same defaults the popup
 * uses. `⏱ Start Focus` is the exception and `src/lib/launcher-events.ts`
 * says why: a focus session is a clock, the clock lives in the main window,
 * and a row written from here would be a timer nobody is watching. Start My
 * Day is the other, for the same reason: its dialog, its launch panel and
 * its planning session all belong to the main window.
 *
 * **Two things it has to do that a web page would not.** It sizes its own
 * window — Rust clamps the number, the frontend measures it — because a
 * launcher showing two routines should not be a box with an empty half. And
 * it holds the window open across a launch: the applications a routine opens
 * take the foreground, and this window hides when it loses focus, so without
 * the hold a routine that half failed would report that to an empty screen.
 */
function QuickLauncher() {
  const routines = useRoutineStore((state) => state.routines);
  const isLoading = useRoutineStore((state) => state.isLoading);
  const loadError = useRoutineStore((state) => state.error);
  const loadRoutines = useRoutineStore((state) => state.loadRoutines);

  /**
   * Searching, or typing the title of a new task.
   *
   * `+ Add Task` switches the box rather than creating from it. A launcher
   * that wrote a record on one keypress from a field you were *searching*
   * with is how a task called "cod" gets created by someone half way through
   * typing "coding"; the mode is the confirmation, and the query comes along
   * so nothing is retyped.
   */
  const [mode, setMode] = useState<"search" | "add-task">("search");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState<LauncherStatus | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useWindowSync();

  const items = useMemo(() => launcherItems(routines), [routines]);
  const matches = useMemo(() => visibleItems(items, query, mode), [items, query, mode]);

  // Clamped rather than corrected in an effect: the list can shrink under a
  // keystroke, and a render that drew nothing as selected — even for one
  // frame — would be a window where Enter did nothing.
  const index = matches.length === 0 ? -1 : Math.min(selected, matches.length - 1);
  const current = index === -1 ? null : matches[index];
  const isBusy = status?.kind === "launching" || isSaving;

  /* ---------------------------------------------------------------------- */
  /* Living in a window that is hidden rather than closed                    */
  /* ---------------------------------------------------------------------- */

  const reset = useCallback(() => {
    setMode("search");
    setQuery("");
    setSelected(0);
    setStatus(null);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    void loadRoutines();
  }, [loadRoutines]);

  // Shown again after being hidden. Everything about the last summon goes:
  // the webview was never torn down, so without this the launcher would open
  // on yesterday's query, yesterday's selection and a routine list that has
  // moved on. The theme comes with it, for a window that survives a change
  // made in Settings without ever re-running `initTheme`.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void onQuickLauncherShown(() => {
      refreshTheme();
      refreshMotion();
      refreshSound();
      reset();
      void loadRoutines();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((cause) => console.error("Could not listen for the launcher opening:", cause));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadRoutines, reset]);

  // The catch-all, and the one that matters on the very first summon: the
  // window is built already focused, but the input inside it is not.
  useEffect(() => {
    const focusInput = () => inputRef.current?.focus();

    focusInput();
    window.addEventListener("focus", focusInput);
    return () => window.removeEventListener("focus", focusInput);
  }, []);

  // The window is exactly as tall as what is in it. Measured rather than
  // calculated because the list is what changes height, and it changes on
  // every keystroke.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    let last = 0;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(frame.getBoundingClientRect().height);
      if (height === last || height === 0) return;
      last = height;
      void setQuickLauncherHeight(height).catch((cause) =>
        console.error("Could not resize the quick launcher:", cause),
      );
    });

    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // The hold is a fact about what is on screen, so it is derived from what is
  // on screen rather than set by hand at each of the places a launch can end.
  // A result the user has not read yet outranks the blur caused by the very
  // applications it is reporting on.
  useEffect(() => {
    const held = status?.kind === "launching" || status?.kind === "failed";
    void holdQuickLauncher(held).catch((cause) =>
      console.error("Could not hold the quick launcher open:", cause),
    );
  }, [status]);

  // A success notice outlives nothing: it is cleared, and the launcher goes
  // back to being a search box ready for the next thing.
  useEffect(() => {
    if (status?.kind !== "added") return;
    const timer = window.setTimeout(() => setStatus(null), 3_500);
    return () => window.clearTimeout(timer);
  }, [status]);

  // Keeps the selected row in the scroll area. `nearest` rather than
  // `center`, so holding an arrow key walks the list instead of jumping it.
  useEffect(() => {
    if (!current) return;
    listRef.current
      ?.querySelector(`#${optionId(current)}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current]);

  /* ---------------------------------------------------------------------- */
  /* Doing things                                                            */
  /* ---------------------------------------------------------------------- */

  async function launch(routine: RoutineWithActions) {
    setStatus({ kind: "launching", text: `Starting ${routine.name}…` });

    // The store keeps the last run around for the panel this window does not
    // draw; clearing it first means the result read back below is this
    // launch's and not the previous one's.
    useRoutineStore.getState().closeRun();

    // Never rejects — a routine that could not be launched at all is written
    // into the run as a failed action, which is what is read back below.
    await useRoutineStore.getState().launchRoutine(routine.id);

    const run = useRoutineStore.getState().run;
    if (run && run.status === "partial") {
      const { completed, attempted, failed } = runCounts(run.actions);
      // The launcher has no Retry — section 32's checklist is a full panel
      // and this is a search box — so the line's job is to survive long
      // enough to send the user to the app, where Retry lives.
      setStatus({
        kind: "failed",
        text: `${completed} / ${attempted} started · ${failed} failed — retry in the app`,
      });
      return;
    }

    // The workspace is open and the user is looking at it, not at this.
    setStatus(null);
    void dismissQuickLauncher();
  }

  async function addTask() {
    const title = query.trim();
    if (!title || isSaving) return;

    setIsSaving(true);
    try {
      // The same defaults the popup's quick-add uses (section 16's dialog
      // opens on them too), so the launcher is a shortcut through that form
      // rather than a third way of creating tasks.
      await useTaskStore.getState().createTask({
        title,
        priority: "normal",
        due_date: todayKey(),
      });

      // Kept open with the box cleared: adding tasks is the one thing people
      // do several of in a row, and the launcher closing between each would
      // be it being tidy at the user's expense. Escape is one key away.
      setMode("search");
      setQuery("");
      setSelected(0);
      setStatus({ kind: "added", text: `Added “${title}” to today` });
    } catch (cause) {
      setStatus({ kind: "failed", text: String(cause) });
    } finally {
      setIsSaving(false);
    }
  }

  function run(item: LauncherItem) {
    switch (item.kind) {
      case "routine":
        if (item.routine) void launch(item.routine);
        return;
      case "add-task":
        setMode("add-task");
        setStatus(null);
        return;
      case "start-focus":
        // The clock belongs to the main window; this asks for it, brings that
        // window out from behind the tray so there is something to watch it
        // on, and gets out of the way. See `src/lib/launcher-events.ts`.
        requestFocusSession();
        void focusMainWindow();
        void dismissQuickLauncher();
        return;
      case "start-my-day":
        // The same shape, for the same reason: the dialog, the launch panel
        // it hands over to and the planning session's clock all live in the
        // main window.
        requestStartMyDay();
        void focusMainWindow();
        void dismissQuickLauncher();
        return;
      case "review-my-day":
        requestReviewMyDay();
        void focusMainWindow();
        void dismissQuickLauncher();
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        // Escape backs out of the mode it is in before it backs out of the
        // window: a half-typed task title should cost one keypress to
        // abandon, not the whole launcher.
        if (mode === "add-task") {
          setMode("search");
          setSelected(0);
        } else {
          void dismissQuickLauncher();
        }
        return;

      case "ArrowDown":
      case "ArrowUp": {
        if (mode !== "search" || matches.length === 0) return;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        // Wrapping, because a list this short is faster to reach the bottom
        // of by going up.
        setSelected((matches.length + index + step) % matches.length);
        return;
      }

      case "Tab":
        // There is nowhere else to go. Focus staying in the box is what lets
        // the arrow keys mean what they mean.
        event.preventDefault();
        return;

      case "Enter":
        event.preventDefault();
        if (isBusy) return;
        if (mode === "add-task") void addTask();
        else if (current) run(current);
    }
  }

  const isAdding = mode === "add-task";

  return (
    <div ref={frameRef} className="flex flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-2.5 px-3.5 py-3">
        {isBusy ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}

        {/* The mode has to be visible or the box would silently mean two
            different things. A label beside the caret is cheaper than a
            second screen, and it doubles as the way back out. */}
        {isAdding && (
          <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[11px] font-medium text-accent-foreground">
            New task
          </span>
        )}

        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
            // Typing is the user moving on. A launch still in flight is not
            // theirs to clear, so it stays.
            setStatus((previous) => (previous?.kind === "launching" ? previous : null));
          }}
          onKeyDown={handleKeyDown}
          placeholder={isAdding ? "What needs doing today?" : "Search…"}
          aria-label={isAdding ? "Task title" : "Search routines and actions"}
          className={cn(
            "min-w-0 flex-1 bg-transparent text-base outline-none",
            "placeholder:text-muted-foreground",
          )}
          // A combobox over a listbox is what this is: one text field driving
          // a selection in a list that is never focused.
          role="combobox"
          aria-expanded={!isAdding}
          aria-controls={LIST_ID}
          aria-activedescendant={!isAdding && current ? optionId(current) : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {!isAdding && (
        <div className="border-t">
          {isLoading && routines.length === 0 ? (
            // The window is summoned by a global shortcut, so its very first
            // frame is often drawn before the read lands. Without this it
            // announced "No routines yet — build one in the app." to users
            // with a dozen of them, for as long as SQLite took to answer.
            <LoadingRows />
          ) : loadError && routines.length === 0 ? (
            <ErrorState
              className="gap-2 py-6"
              title="Could not read your routines."
              message={loadError}
              onRetry={() => void loadRoutines()}
            />
          ) : matches.length === 0 ? (
            <p className="px-3.5 py-3 text-sm text-muted-foreground">
              {routines.length === 0
                ? "No routines yet — build one in the app."
                : "Nothing matches that."}
            </p>
          ) : (
            <ul
              ref={listRef}
              id={LIST_ID}
              role="listbox"
              aria-label="Routines and quick actions"
              className="max-h-[19rem] overflow-y-auto p-1.5"
            >
              {matches.map((item, position) => (
                <LauncherRow
                  key={item.key}
                  id={optionId(item)}
                  item={item}
                  isSelected={position === index}
                  onSelect={() => run(item)}
                  onHover={() => setSelected(position)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {/* One line, always the same height: whatever just happened, or the
          keys that make the window work. The hints are not decoration — a
          launcher with no visible chrome has to say somewhere that the arrows
          and Enter do something. */}
      <footer
        className={cn(
          "flex items-center justify-between gap-3 border-t px-3.5 py-1.5 text-[11px]",
          status?.kind === "failed" ? "text-priority-urgent" : "text-muted-foreground",
        )}
      >
        {/* Announced, because this is where the window says whether anything
            happened — "Added ... to today", "3 / 5 started · 2 failed" — and
            focus never leaves the search box, so a screen reader has no reason
            to visit this line unless it is told to. `polite` so it waits for
            the keystroke that caused it to be read out first. */}
        <span className="min-w-0 truncate" role="status" aria-live="polite">
          {status?.text ?? (isAdding ? "Due today, normal priority" : "")}
        </span>
        <span className="shrink-0" aria-hidden>
          {isAdding ? "↵ add · esc back" : "↑↓ move · ↵ run · esc close"}
        </span>
      </footer>
    </div>
  );
}

/** What the launcher is doing, or what it has just done. */
type LauncherStatus =
  | { kind: "launching"; text: string }
  | { kind: "added"; text: string }
  | { kind: "failed"; text: string };

const LIST_ID = "launcher-results";

const optionId = (item: LauncherItem) => `launcher-option-${item.key}`;

/**
 * The rows to draw for `query`.
 *
 * One rule on top of the plain filter: a query that matches nothing still
 * offers `+ Add Task`. A search that has run out of routines is very often
 * someone typing a thing they need to do, and a launcher whose answer to
 * "buy milk" is an empty box would be one they have to close and reopen
 * somewhere else. Add Task is filtered normally the rest of the time — it
 * matches "add", "task", "new", "todo" — so this only ever adds a way out of
 * a dead end.
 */
function visibleItems(
  items: LauncherItem[],
  query: string,
  mode: "search" | "add-task",
): LauncherItem[] {
  if (mode === "add-task") return [];

  const matches = filterLauncherItems(items, query);
  if (matches.length > 0 || !query.trim()) return matches;

  const addTask = items.find((item) => item.kind === "add-task");
  return addTask ? [{ ...addTask, hint: `Adds “${query.trim()}” to today` }] : [];
}

/**
 * Three rows' worth of space while the routines are read.
 *
 * The window sizes itself to its content, so this also stops it opening at
 * one height and jumping to another the instant the list lands.
 */
function LoadingRows() {
  return (
    <div role="status" aria-busy className="flex flex-col gap-1.5 p-1.5">
      <span className="sr-only">Loading your routines</span>
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-2.5 px-2 py-2" aria-hidden>
          <Skeleton className="size-5 rounded" />
          <Skeleton className="h-4 flex-1 max-w-[14rem]" />
        </div>
      ))}
    </div>
  );
}

export default QuickLauncher;
