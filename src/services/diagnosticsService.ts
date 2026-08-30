/**
 * The crash log's side of the `invoke` boundary (development-plan.md
 * section 85).
 *
 * Three calls, and between them everything the frontend may do with the log:
 * write an entry, ask where the file is, and open its folder in Explorer.
 * There is no call that reads it back — the log is a file on the user's
 * machine that the user opens, not a document this app renders.
 *
 * Nothing here transmits anything. Section 68's promise is that the data
 * stays on the computer, and a crash reporter is the feature most likely to
 * break that by accident, so the only destination in this file is a path
 * under the app's own data directory. See `src-tauri/src/services/logging.rs`.
 */

import { invoke } from "@tauri-apps/api/core";

/** Where the log lives, as the backend reports it. */
export interface LogLocation {
  /** The active file, e.g. `C:\Users\...\logs\routine-launcher.log`. */
  file: string;
  /** The folder holding it and the rotated copies. */
  folder: string;
  /** How many files that folder ever holds. */
  keptFiles: number;
  /** How large each may get before it is rotated. */
  maxFileBytes: number;
}

/** Which window an error came from. Written into the log line. */
export type LogSurface = "main" | "popup" | "launcher" | "widget";

/**
 * How an error was caught. Also written into the line, because the three are
 * worth telling apart when reading back: a render that threw took a screen
 * down with it, while a rejected promise may have gone unnoticed.
 */
export type LogErrorKind = "render" | "unhandled-error" | "unhandled-rejection";

/**
 * Where the log file is.
 *
 * Rejects only when logging could not be started at all — the one case where
 * there is no honest answer, and the UI says so rather than showing a path
 * nothing was ever written to.
 */
export async function getLogLocation(): Promise<LogLocation> {
  return invoke<LogLocation>("get_log_location");
}

/** Opens the log folder in Explorer, with the active file selected. */
export async function openLogFolder(): Promise<void> {
  return invoke("open_log_folder");
}

/**
 * Writes one entry into the same file the Rust layer writes to.
 *
 * One file rather than two, so a crash in this webview and the panic in the
 * process hosting it can be read in the order they happened — which is
 * usually the only way to tell which one caused the other.
 *
 * The message and stack are truncated by the backend; nothing sent from here
 * decides how much of the user's disk one report takes.
 */
export async function logFrontendError(entry: {
  window: LogSurface;
  kind: LogErrorKind;
  message: string;
  stack?: string | null;
}): Promise<void> {
  return invoke("log_frontend_error", {
    window: entry.window,
    kind: entry.kind,
    message: entry.message,
    stack: entry.stack ?? null,
  });
}
