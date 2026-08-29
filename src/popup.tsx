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
import { initTheme } from "./stores/themeStore";
import "./index.css";

// Applied before the first render so the window never flashes the wrong theme.
initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PopupWindow />
  </React.StrictMode>,
);
