/**
 * Entry point for the quick launcher window (development-plan.md section 28).
 *
 * A sibling of `main.tsx` and `popup.tsx`, not a route inside either. The
 * launcher is a third Tauri window with its own document (`launcher.html`),
 * summoned by a global shortcut from anywhere on the machine — which is
 * precisely what an overlay inside a window that may be minimised, buried or
 * never opened could not be. So this mounts one component and nothing else:
 * no router, no sidebar, no `useFocusLifecycle`.
 *
 * What it does share is the stylesheet and the theme, because a launcher that
 * did not look like the app it launches would read as a different program.
 */

import React from "react";
import ReactDOM from "react-dom/client";

import QuickLauncher from "./components/launcher/QuickLauncher";
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
installCrashLogging("launcher");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary size="compact">
      <QuickLauncher />
    </AppErrorBoundary>
  </React.StrictMode>,
);
