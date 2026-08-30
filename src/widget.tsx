/**
 * Entry point for the desktop widget window (development-plan.md sections
 * 26, 83).
 *
 * A sibling of `main.tsx`, `popup.tsx` and `launcher.tsx`, not a route inside
 * any of them. The widget is a fourth Tauri window with its own document
 * (`widget.html`), meant to sit on the desktop while the user works on
 * something else — which is exactly what a panel inside a window that may be
 * minimised, buried or closed could not do. So this mounts one component and
 * nothing else: no router, no sidebar, no `useFocusLifecycle`.
 *
 * What it does share is the stylesheet and the theme, because a widget that
 * did not look like the app it belongs to would read as a different program.
 * What it does *not* share is the background: `widget.html` leaves the window
 * transparent so the widget can be drawn at the opacity section 83 asks for.
 */

import React from "react";
import ReactDOM from "react-dom/client";

import WidgetWindow from "./components/widget/WidgetWindow";
import AppErrorBoundary from "./components/common/AppErrorBoundary";
import { installCrashLogging } from "./lib/crash-log";
import { initMotion } from "./stores/motionStore";
import { initTheme } from "./stores/themeStore";
import "./index.css";

// Both applied before the first render, so the window never flashes the wrong
// theme and never animates its first frame in when animations are off.
initTheme();
initMotion();

// Section 85's crash log, armed before the first render so that a component
// which throws on mount is still recorded. `AppErrorBoundary` below is what
// the user sees when one does.
installCrashLogging("widget");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary size="compact">
      <WidgetWindow />
    </AppErrorBoundary>
  </React.StrictMode>,
);
