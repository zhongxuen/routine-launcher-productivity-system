import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface ListSkeletonProps {
  /** How many placeholders to draw. Match what the real list usually holds. */
  rows?: number;
  /** The shape of one placeholder — height and width of the real row. */
  rowClassName?: string;
  /** Layout of the set. Defaults to a stack; pass a grid for card layouts. */
  className?: string;
  /**
   * What is being read, for screen readers: "Loading your routines".
   *
   * The bars themselves are decoration, so they are hidden and this sentence
   * is announced in their place — otherwise the wait is completely silent to
   * anyone not looking at the screen.
   */
  label: string;
}

/**
 * Placeholder rows while an async read is in flight.
 *
 * Skeletons rather than a spinner, and skeletons the size of the real rows,
 * because the point is that the heading and everything below the list do not
 * jump when the data lands (development-plan.md section 84). A spinner is
 * only right where the shape of the answer is genuinely unknown — see
 * `Spinner` for those.
 */
function ListSkeleton({
  rows = 4,
  rowClassName = "h-10 w-full",
  className,
  label,
}: ListSkeletonProps) {
  return (
    <div role="status" aria-busy className={cn("flex flex-col gap-2", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={rowClassName} aria-hidden />
      ))}
    </div>
  );
}

export default ListSkeleton;
export { ListSkeleton };
