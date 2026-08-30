import { AlertCircle, CheckCircle2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { folderName, formatBytes } from "@/lib/duplicate-utils";
import { useDuplicateStore } from "@/stores/duplicateStore";

/**
 * What the last confirmed action actually did.
 *
 * Shown instead of letting the list quietly re-render with fewer rows, because
 * a cleanup tool that only refreshes has not told the user anything — and the
 * one thing they need to know is whether the file that would not delete was
 * the one they cared about. Every failure is named with the reason Rust gave.
 *
 * Dismissed by hand rather than on a timer: it is the only record of the
 * action, and it disappears on its own the next time one is started.
 */
function DuplicateActionReport() {
  const report = useDuplicateStore((state) => state.report);
  const dismissReport = useDuplicateStore((state) => state.dismissReport);

  if (report === null) return null;

  const isMove = report.action === "move";
  const failures = report.outcomes.filter((outcome) => !outcome.ok);
  const nothingWorked = report.succeeded === 0;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <header className="flex items-start gap-3">
        {nothingWorked ? (
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-priority-urgent" />
        ) : (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-sm">
            {nothingWorked
              ? `Nothing was ${isMove ? "moved" : "deleted"}.`
              : `${report.succeeded} ${report.succeeded === 1 ? "file" : "files"} ${isMove ? "moved" : "deleted"} · ${formatBytes(report.bytes)}`}
          </p>

          {isMove && report.destination !== null && !nothingWorked && (
            <p className="truncate text-xs text-muted-subtle" title={report.destination}>
              Now in {folderName(report.destination)} — {report.destination}
            </p>
          )}

          {report.failed > 0 && (
            <p className="text-xs text-muted-foreground">
              {report.failed} could not be {isMove ? "moved" : "deleted"} and{" "}
              {report.failed === 1 ? "is" : "are"} still where {report.failed === 1 ? "it was" : "they were"}.
            </p>
          )}
        </div>

        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Dismiss this report"
          onClick={dismissReport}
        >
          <X />
        </Button>
      </header>

      {failures.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-border/60 pt-3">
          {failures.map((outcome) => (
            <li key={outcome.path} className="flex flex-col" title={outcome.path}>
              <span className="truncate text-xs">{outcome.path}</span>
              <span className="text-xs text-muted-subtle">
                {outcome.error ?? "could not be changed."}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default DuplicateActionReport;
