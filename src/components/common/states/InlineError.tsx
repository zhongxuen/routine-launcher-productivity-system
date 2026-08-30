import { AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface InlineErrorProps {
  /** What the write reported. Already user-presentable. */
  message: string;
  /** Run the same thing again — a failed save, a failed move, a failed launch. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Put the banner away without retrying. */
  onDismiss?: () => void;
  className?: string;
}

/**
 * A *write* that failed, said next to the thing that was being written.
 *
 * Distinct from {@link ErrorState}, which replaces content a read never
 * produced. Here the content is fine — the file list is still right, the task
 * is still there — and only the action the user just took did not happen. So
 * the list stays and the failure appears above it as a banner, in the
 * destructive colour, because unlike a stale read this one is about something
 * the user did a second ago and is waiting on.
 *
 * Section 87 asks routine failures to report which step failed and offer a
 * retry rather than dying silently; this is the same contract for everything
 * smaller than a routine run — ticking off a task, moving a screenshot,
 * emptying a duplicate group.
 */
function InlineError({
  message,
  onRetry,
  retryLabel = "Try again",
  onDismiss,
  className,
}: InlineErrorProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive",
        className,
      )}
    >
      <AlertCircle className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && (
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0 text-xs text-destructive"
          onClick={onRetry}
        >
          {retryLabel}
        </Button>
      )}
      {onDismiss && (
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0 text-xs text-destructive/70"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      )}
    </div>
  );
}

export default InlineError;
export { InlineError };
