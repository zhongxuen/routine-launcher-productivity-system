/**
 * Typed wrappers around the desktop widget's Tauri commands
 * (development-plan.md sections 26, 83).
 *
 * The "Service" layer of React UI -> Service -> Tauri Command -> Rust
 * (section 86): components import from here and never call `invoke`
 * themselves. Every command rejects with a plain, user-presentable string.
 *
 * All five of section 83's controls are here, and all five are Rust's rather
 * than the webview's — moving, resizing, pinning, hiding and remembering are
 * things done to an OS window, and the widget's capability grants it no window
 * permissions at all. What the frontend contributes is the *gesture*: where
 * the pointer went, which corner it grabbed. What comes back is what was
 * actually stored, already clamped, which is what the widget should draw
 * itself at — following the answer rather than the request is what keeps a
 * drag from running past the limits.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Emitted to the widget when a window that was only hidden is shown again. */
const WIDGET_SHOWN_EVENT = "widget://shown";

/** Broadcast to every window when a stored widget setting changes. */
const WIDGET_SETTINGS_EVENT = "widget://settings-changed";

/**
 * Which of section 26's four layouts the widget draws.
 *
 * Declared by hand to match `WidgetMode` in `src-tauri/src/services/widget.rs`
 * — the two are checked against each other by a test there, because a
 * mismatch would be a picker that changed nothing.
 */
export type WidgetMode = "task" | "focus" | "routine" | "combined";

/** The four modes in the order Settings offers them, section 26's own. */
export const WIDGET_MODES: readonly WidgetMode[] = ["task", "focus", "routine", "combined"];

/** Everything persisted about the widget — the shape `get_widget_settings` returns. */
export interface WidgetSettings {
  /** Whether the widget was on screen. What survives a restart. */
  visible: boolean;
  /** Logical pixels, or null while the widget has never been placed. */
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  /** Always-on-top. Section 83's "Pin". */
  pinned: boolean;
  /** Which of section 26's four layouts is on screen. */
  mode: WidgetMode;
  /** 0.3 - 1.0. Painted by the widget, not by the OS. */
  opacity: number;
}

/** The size a resize settled on, after Rust clamped it. */
export interface WidgetSize {
  width: number;
  height: number;
}

/* -------------------------------------------------------------------------- */
/* The window                                                                 */
/* -------------------------------------------------------------------------- */

/** Shows the widget, building it the first time. Takes focus. */
export async function openWidgetWindow(): Promise<void> {
  return invoke<void>("open_widget_window");
}

/**
 * Section 83's "Hide": the widget goes away and the app carries on. This is
 * what the widget's own close button calls.
 */
export async function dismissWidgetWindow(): Promise<void> {
  return invoke<void>("dismiss_widget_window");
}

/** Flips the widget between shown and hidden, answering with whether it is now visible. */
export async function toggleWidgetWindow(): Promise<boolean> {
  return invoke<boolean>("toggle_widget_window");
}

/** Whether the widget is on screen right now. */
export async function isWidgetWindowOpen(): Promise<boolean> {
  return invoke<boolean>("is_widget_window_open");
}

/* -------------------------------------------------------------------------- */
/* The five controls                                                          */
/* -------------------------------------------------------------------------- */

/** Everything stored about the widget, in one read. */
export async function getWidgetSettings(): Promise<WidgetSettings> {
  return invoke<WidgetSettings>("get_widget_settings");
}

/** Section 83's "Pin". Answers with what was stored. */
export async function setWidgetPinned(pinned: boolean): Promise<boolean> {
  return invoke<boolean>("set_widget_pinned", { pinned });
}

/**
 * Section 83's "Opacity". Answers with the value after clamping — a request
 * below the floor comes back as the floor rather than as a widget nobody can
 * see, so the caller should render the answer and not the request.
 */
export async function setWidgetOpacity(opacity: number): Promise<number> {
  return invoke<number>("set_widget_opacity", { opacity });
}

/**
 * Section 26's four layouts. Answers with the mode that was stored.
 *
 * The one widget control with no twin in the widget's own chrome: a four-way
 * picker does not fit in a 300px window, and choosing a layout is not
 * something you do while working. Both windows re-read on the broadcast this
 * causes, so the widget changes shape as the picker is used.
 */
export async function setWidgetMode(mode: WidgetMode): Promise<WidgetMode> {
  return invoke<WidgetMode>("set_widget_mode", { mode });
}

/**
 * Section 83's "Resize", in logical pixels. Answers with the size the window
 * was actually given, which is what the drag should follow.
 */
export async function setWidgetSize(width: number, height: number): Promise<WidgetSize> {
  return invoke<WidgetSize>("set_widget_size", { width, height });
}

/**
 * Section 83's "Move": hands the window to the OS's own drag loop until the
 * pointer is released.
 *
 * Nothing more is sent while the drag runs — no coordinates, no frames. The
 * window manager moves the window and Rust hears about it, which is what makes
 * dragging feel native and is why snapping and multi-monitor are not this
 * file's problem.
 */
export async function startWidgetDrag(): Promise<void> {
  return invoke<void>("start_widget_drag");
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Subscribes to the widget being shown again after being hidden.
 *
 * A hidden window's webview is never torn down, so nothing else would make it
 * re-read a database — or a theme — that has moved on since. Returns the
 * unsubscribe function.
 */
export async function onWidgetShown(handler: () => void): Promise<UnlistenFn> {
  return listen<void>(WIDGET_SHOWN_EVENT, () => handler());
}

/**
 * Subscribes to a stored widget setting changing anywhere.
 *
 * Pin and opacity are reachable from the widget's own chrome and from the
 * Settings page, which are separate webviews with separate copies of the same
 * two values. This is how the one that did not make the change finds out —
 * the same announce-and-re-read as `src/lib/window-sync.ts`.
 */
export async function onWidgetSettingsChanged(handler: () => void): Promise<UnlistenFn> {
  return listen<void>(WIDGET_SETTINGS_EVENT, () => handler());
}
