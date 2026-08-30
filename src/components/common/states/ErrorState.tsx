import { AlertCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  /**
   * What failed, in the user's terms: "Could not load your routines."
   * Not the exception — that is `message`.
   */
  title: string;
  /** The cause, as the backend reported it. Shown small, under the title. */
  message?: string | null;
  /**
   * Read it again. Omitted only when nothing the user can press would help,
   * in which case give them an `action` that goes somewhere useful instead.
   */
  onRetry?: () => void;
  retryLabel?: string;
  /** Anything else worth offering — a link to the page that owns the data. */
  action?: React.ReactNode;
  /** `compact` is the widget and the popup. See {@link EmptyState}. */
  size?: "default" | "compact";
  className?: string;
}

/**
 * A read that failed, standing where its content would have been.
 *
 * One shape for every failed load in the app (development-plan.md section
 * 84): what went wrong, the cause underneath it, and a way to try again.
 * The retry is the point — a SQLite read or a filesystem scan that failed
 * once will usually work on the second press, and an app that makes the user
 * navigate away and back to find that out is one that feels broken.
 *
 * Use this when the failure left *nothing* to show. When there is stale
 * content worth keeping on screen, say so under it with {@link StaleNotice}
 * rather than replacing it with this.
 */
function ErrorState({
  title,
  message,
  onRetry,
  retryLabel = "Try again",
  action,
  size = "default",
  className,
}: ErrorStateProps) {
  if (size === "compact") {
    return (
      <div className={cn("flex flex-wrap items-center gap-1 px-1 pt-1", className)}>
        <p className="text-[0.7rem] leading-tight text-muted-foreground">{title}</p>
        {onRetry && (
          <Button
            variant="link"
            size="xs"
            className="h-auto p-0 text-[0.7rem]"
            onClick={onRetry}
          >
            {retryLabel}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn("flex flex-col items-center gap-3 py-14 text-center", className)}
    >
      <AlertCircle className="size-5 text-destructive" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="text-sm">{title}</p>
        {message && <p className="max-w-md text-xs text-muted-foreground">{message}</p>}
      </div>
      {(onRetry || action) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

export default ErrorState;
export { ErrorState };
