import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder rows while a view is being read. Matching the real row's height
 * keeps the heading and the list from jumping when the tasks arrive.
 */
function TaskListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-1 py-2" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-2 py-2">
          <Skeleton className="size-4 rounded-sm" />
          <Skeleton className="h-4 flex-1 max-w-[min(28rem,70%)]" />
        </div>
      ))}
    </div>
  );
}

export default TaskListSkeleton;
