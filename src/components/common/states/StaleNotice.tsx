import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface StaleNoticeProps {
  /**
   * What may be wrong with what is on screen, as a sentence:
   * "Progress may be out of date."
   */
  message: string;
  onRetry: () => void;
  retryLabel?: string;
  className?: string;
}

/**
 * A re-read failed, but the figures from the last good one are still up.
 *
 * The counterpart to {@link ErrorState}: that one stands *instead of* content,
 * this one stands *under* it. Stale XP, a stale streak or a stale focus total
 * is still worth looking at, and blanking a dashboard card because its second
 * read failed would lose more than it protects.
 *
 * Deliberately quiet — muted, one line, a link rather than a button. The card
 * it sits under is rarely the most important thing on the page, and a loud
 * failure notice on a background refresh is noise.
 */
function StaleNotice({ message, onRetry, retryLabel = "Try again", className }: StaleNoticeProps) {
  return (
    <div
      role="status"
      className={cn("flex flex-wrap items-center gap-1 text-xs text-muted-foreground", className)}
    >
      <span>{message}</span>
      <Button variant="link" size="xs" className="h-auto p-0" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}

export default StaleNotice;
export { StaleNotice };
