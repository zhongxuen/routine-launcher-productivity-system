import { AlertCircle, Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatBytes, parentFolderName } from "@/lib/downloads-utils";
import { useDownloadsStore } from "@/stores/downloadsStore";
import type { ActionReport } from "@/types/downloads";

/**
 * What actually happened, after step five of development-plan.md section 67.
 *
 * Kept on screen until dismissed rather than flashed as a toast, for one
 * reason: an action that half worked has to be readable. Rust attempts every
 * selected file even when an earlier one fails, so a report can say "23 moved,
 * 2 could not be" — and the two are named, with the reason, because a file
 * the user believes was dealt with and was not is the worst outcome this
 * feature can produce.
 *
 * A move also names where each file went. The destination filename can differ
 * from the original — a name already taken in the destination gets ` (1)`
 * appended rather than overwriting what was there — and somebody who later
 * goes looking for the file needs to know that.
 */
function DownloadsActionReport({ report }: { report: ActionReport }) {
  const dismissReport = useDownloadsStore((state) => state.dismissReport);

  const failures = report.outcomes.filter((outcome) => !outcome.ok);
  const moved = report.outcomes.find((outcome) => outcome.ok && outcome.moved_to !== null);
  const isMove = moved !== undefined;

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 px-4 py-3"
      role="status"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-2 text-sm">
          {failures.length === 0 ? (
            <Check className="size-4 shrink-0 text-status-completed" />
          ) : (
            <AlertCircle className="size-4 shrink-0 text-priority-urgent" />
          )}
          <span>
            {report.succeeded > 0
              ? `${report.succeeded} ${report.succeeded === 1 ? "file" : "files"} ${isMove ? "moved" : "deleted"} · ${formatBytes(report.bytes)}`
              : "Nothing was changed"}
            {failures.length > 0 &&
              ` · ${failures.length} could not be ${isMove ? "moved" : "deleted"}`}
          </span>
        </p>

        <Button size="icon-xs" variant="ghost" onClick={dismissReport} aria-label="Dismiss">
          <X />
        </Button>
      </div>

      {isMove && moved?.moved_to != null && (
        <p className="text-xs text-muted-foreground">
          Moved into {parentFolderName(moved.moved_to)}.
        </p>
      )}

      {failures.length > 0 && (
        <ul className="flex flex-col gap-1 pt-1 text-xs text-muted-foreground">
          {failures.map((failure) => (
            <li key={failure.path}>
              <span className="text-foreground">{failure.name}</span>
              {failure.error !== null && ` — ${failure.error}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default DownloadsActionReport;
