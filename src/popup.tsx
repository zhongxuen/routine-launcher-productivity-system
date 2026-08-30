/**
 * Entry point for the compact popup window (development-plan.md section 25).
 *
 * A sibling of `main.tsx`, not a route inside it. The popup is a second Tauri
 * window with its own document (`popup.html`), so this mounts one component
 * and nothing else — no router, no sidebar, no `useFocusLifecycle`. Those
 * belong to the app shell, and section 25's window is explicitly the thing
 * you use *instead of* opening the app.
 *
 * What it does share is the stylesheet and the theme, because a popup that
 * did not look like the app it belongs to would read as a different program.
 */

import React from "react";
import ReactDOM from "react-dom/client";

import PopupWindow from "./components/popup/PopupWindow";
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
installCrashLogging("popup");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary size="compact">
      <PopupWindow />
    </AppErrorBoundary>
  </React.StrictMode>,
);
