/**
 * The frontend half of section 85's crash log.
 *
 * Each of the four windows calls {@link installCrashLogging} once, before it
 * renders. From then on three things are recorded, all of them into the same
 * file the Rust layer writes to:
 *
 * - a render that threw, caught by `AppErrorBoundary`;
 * - an uncaught error, caught by the `error` listener;
 * - a promise nobody handled, caught by `unhandledrejection`.
 *
 * The last two matter more than they look. A React error boundary only sees
 * exceptions thrown during rendering — an `await` that rejected inside an
 * event handler never reaches it, and that is most of what this app does.
 * Without these listeners the log would only ever hold the crashes that had
 * already put a fallback screen on the user's monitor, which are the ones
 * they can describe anyway.
 *
 * ## Why the path is fetched up front
 *
 * The fallback screen's whole job is to say *where the log is*, and it is
 * rendered at the moment the app has just proved it cannot be relied on. So
 * the path is read once at startup and kept here, where a component that is
 * already handling a crash can have it synchronously rather than starting an
 * async call it might not survive.
 */

import {
  getLogLocation,
  logFrontendError,
  type LogErrorKind,
  type LogLocation,
  type LogSurface,
} from "@/services/diagnosticsService";

/**
 * The most reports one run will write.
 *
 * A component that throws on every render can produce them faster than
 * anything can read them; the backend's rotation would keep the *file*
 * bounded, but at the cost of throwing away the first crash — which is the
 * one that explains the rest.
 */
const MAX_REPORTS = 50;

let surface: LogSurface = "main";
let installed = false;
let reports = 0;
let lastReport = "";
let location: LogLocation | null = null;

/**
 * Arms the crash log for one window, and starts fetching the log's path.
 *
 * Safe to call twice; the second call does nothing, which is what keeps
 * `React.StrictMode` from installing two of every listener.
 */
export function installCrashLogging(windowSurface: LogSurface): void {
  if (installed) return;
  installed = true;
  surface = windowSurface;

  window.addEventListener("error", (event) => {
    // `event.error` is the exception where there was one. A failed <script>
    // or <img> fires the same event with nothing on it, and `event.message`
    // is then all there is to go on.
    report("unhandled-error", event.error ?? event.message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    report("unhandled-rejection", event.reason);
  });

  void primeLogLocation();
}

/**
 * Reads where the log file is, and remembers it.
 *
 * A failure is left alone: the fallback screen has a sentence for the case
 * where it does not know the path, and a toast about it during a normal
 * launch would be noise about a feature the user has not needed yet.
 */
export async function primeLogLocation(): Promise<LogLocation | null> {
  try {
    location = await getLogLocation();
  } catch {
    location = null;
  }
  return location;
}

/**
 * The log's path, if it has been read — no promise, no await.
 *
 * The crash screen calls this. Something that is rendering *because* the app
 * broke should not depend on the app working.
 */
export function getCachedLogLocation(): LogLocation | null {
  return location;
}

/**
 * Records one error, and never throws while doing it.
 *
 * Everything that could fail here is swallowed on purpose. This runs inside
 * error boundaries and inside `window.onerror`; an exception thrown from it
 * would replace a readable fallback screen with a blank one, which is exactly
 * the outcome section 85 asks us to prevent.
 */
export function report(kind: LogErrorKind, error: unknown, componentStack?: string): void {
  try {
    const { message, stack } = describeError(error);

    // Still in the devtools console, where a developer expects it.
    console.error(`[${surface}/${kind}]`, error);

    // React re-renders a throwing component before giving up, and
    // `StrictMode` renders everything twice in development, so the identical
    // crash arrives more than once. One line per distinct failure.
    const signature = `${kind}:${message}:${stack ?? ""}:${componentStack ?? ""}`;
    if (signature === lastReport) return;
    lastReport = signature;

    if (reports >= MAX_REPORTS) return;
    reports += 1;

    const detail = [stack, componentStack && `React tree:${componentStack}`]
      .filter(Boolean)
      .join("\n");

    void logFrontendError({
      window: surface,
      kind,
      message: reports === MAX_REPORTS ? `${message} (further reports suppressed)` : message,
      stack: detail || null,
    }).catch(() => {
      // The backend is the thing that writes logs. If it cannot be reached
      // there is nowhere left to say so.
    });
  } catch {
    // As above, one level out: a crash reporter that crashes reports nothing.
  }
}

/**
 * Pulls a message and a stack out of whatever was thrown.
 *
 * `throw` accepts any value, and by the time something reaches an
 * `unhandledrejection` listener it may well be a string, a `Response`, or an
 * object with no `message` at all — so this never assumes an `Error`.
 */
export function describeError(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return {
      message: `${error.name}: ${error.message}`,
      stack: error.stack ?? null,
    };
  }

  if (typeof error === "string") {
    return { message: error, stack: null };
  }

  try {
    return { message: JSON.stringify(error) ?? String(error), stack: null };
  } catch {
    // Circular, or something with a throwing getter.
    return { message: String(error), stack: null };
  }
}
