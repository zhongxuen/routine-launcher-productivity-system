import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

interface SpinnerProps {
  /** What is happening: "Searching that folder…". Shown, and announced. */
  label: string;
  /** Hide the words and keep only the glyph — for inside a button or a row. */
  hideLabel?: boolean;
  /**
   * A second line under the label. Its usual job on this app's scan screens
   * is to say that nothing is being changed — a progress bar over someone's
   * Downloads folder is a thing worth being explicit about.
   */
  hint?: string;
  className?: string;
}

/**
 * The wait whose shape is unknown.
 *
 * Skeletons are the default (see {@link ListSkeleton}) because they promise
 * the layout that is coming. A spinner is right where nobody can make that
 * promise: a filesystem walk that may return four files or four thousand, a
 * routine action opening an application, a hash pass over a folder tree.
 * Drawing eight fake rows for a scan that finds none would be a lie the user
 * watches for ten seconds.
 */
function Spinner({ label, hideLabel = false, hint, className }: SpinnerProps) {
  if (hint) {
    return (
      <div
        role="status"
        aria-busy
        className={cn("flex flex-col items-center gap-2 text-center", className)}
      >
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="max-w-md text-xs text-muted-subtle">{hint}</p>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-busy
      className={cn("flex items-center justify-center gap-2 text-sm text-muted-foreground", className)}
    >
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span className={hideLabel ? "sr-only" : undefined}>{label}</span>
    </div>
  );
}

export default Spinner;
export { Spinner };
