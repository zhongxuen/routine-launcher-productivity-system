import { useState } from "react";
import { AlertOctagon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getCachedLogLocation } from "@/lib/crash-log";
import { openLogFolder } from "@/services/diagnosticsService";
import { cn } from "@/lib/utils";

interface CrashFallbackProps {
  /** What was thrown, already reduced to a sentence. */
  message: string;
  /**
   * Mount the tree again. Offered first because a crash on one render is very
   * often survivable — the alternative, reloading, throws away the window's
   * state as well.
   */
  onRetry: () => void;
  /**
   * `compact` is the popup, the launcher and the widget: small windows with
   * no chrome, where the full card would not fit and there is nothing to
   * navigate back to anyway.
   */
  size?: "default" | "compact";
  className?: string;
}

/**
 * What stands where the app was, when the app is not there any more
 * (development-plan.md section 85).
 *
 * The requirement it answers is a narrow one and worth stating plainly: a
 * React tree that throws unmounts itself, and what the user is left with is a
 * white rectangle. A window that has gone blank is indistinguishable from one
 * that has hung, so the first thing this does is prove the app is still
 * running and knows something went wrong.
 *
 * The second thing is to say *where the log is*. That sentence is the whole
 * reason section 85 asks for this screen rather than a generic apology: the
 * user cannot send us the crash — nothing in this app transmits anything, by
 * section 68 — so the only useful thing to hand them is the path to the file
 * that has it, and a button that opens the folder.
 *
 * The path comes from {@link getCachedLogLocation}, read at startup and held
 * in memory, so this renders it synchronously. A screen that only appears
 * when something has broken cannot be the one that depends on a call
 * succeeding.
 */
function CrashFallback({ message, onRetry, size = "default", className }: CrashFallbackProps) {
  const location = getCachedLogLocation();
  const [openFailed, setOpenFailed] = useState(false);

  async function reveal() {
    try {
      await openLogFolder();
      setOpenFailed(false);
    } catch {
      // No toast: the toaster lives inside the tree that just crashed. The
      // path is on screen either way, which is the part the user needs.
      setOpenFailed(true);
    }
  }

  if (size === "compact") {
    return (
      <div
        role="alert"
        className={cn("flex flex-col gap-2 p-3 text-xs", className)}
      >
        <p className="font-medium">Something went wrong.</p>
        {/* `break-all` because a Windows path has no spaces to wrap at, and
            these three windows are narrow enough that one would otherwise
            push the buttons off the edge. */}
        <p className="select-text break-all text-muted-foreground">
          {location
            ? `The details were saved to ${location.file}`
            : "The details could not be saved to a log file."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" onClick={onRetry}>
            Try again
          </Button>
          {location && (
            <Button size="xs" variant="ghost" onClick={() => void reveal()}>
              Open log folder
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        "flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center",
        className,
      )}
    >
      <AlertOctagon className="size-6 text-destructive" aria-hidden />

      <div className="flex max-w-lg flex-col gap-2">
        <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          This screen stopped working. Nothing you have saved is affected — your tasks,
          routines and focus history are in the database and were not touched.
        </p>
      </div>

      {/* The exception itself, small and selectable. It is rarely meaningful
          to the user, but it is the one line they can read out over the phone
          without opening a file. */}
      <p className="max-w-lg select-text break-words font-mono text-xs text-muted-foreground">
        {message}
      </p>

      <div className="flex max-w-lg flex-col gap-1">
        {location ? (
          <>
            <p className="text-sm">Logs saved to</p>
            <code className="select-text break-all rounded bg-muted px-2 py-1 font-mono text-xs">
              {location.file}
            </code>
            <p className="text-xs text-muted-foreground">
              The log stays on this computer. Nothing is sent anywhere.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            The details could not be written to a log file on this machine.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
        {location && (
          <Button size="sm" variant="outline" onClick={() => void reveal()}>
            Open log folder
          </Button>
        )}
        {/* Last, and deliberately not the first thing offered: a reload
            restarts the window and loses whatever was half-typed in it. */}
        <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
          Reload the window
        </Button>
      </div>

      {openFailed && (
        <p className="text-xs text-muted-foreground">
          Windows would not open the folder. The path above is the file itself.
        </p>
      )}
    </div>
  );
}

export default CrashFallback;
