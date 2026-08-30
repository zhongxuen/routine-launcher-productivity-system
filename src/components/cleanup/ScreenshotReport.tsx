import { AlertCircle, Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useScreenshotStore } from "@/stores/screenshotStore";
import type { MoveOutcome, OrganizeResult } from "@/types/screenshot";

/**
 * What actually happened, after step five of development-plan.md section 67.
 *
 * Kept on screen until dismissed rather than flashed as a toast, for one
 * reason: an organise that half worked has to be readable. Rust attempts
 * every selected file even when an earlier one fails, so a report can say "23
 * moved, 2 could not be" — and those two are named, with the reason, because
 * a file the user believes was filed and was not is the worst outcome this
 * feature can produce.
 *
 * Skipped files are reported as loudly as failures and for the same reason.
 * "Already in that folder" and "not one of the screenshots that were found"
 * are both the app declining to do something the user asked for, and
 * declining quietly would leave them counting rows to work out what happened.
 */
function ScreenshotReport({ report }: { report: OrganizeResult }) {
  const dismissReport = useScreenshotStore((state) => state.dismissReport);

  const notMoved = report.outcomes.filter((outcome) => outcome.status !== "moved");
  const wentWell = report.failed === 0 && report.skipped === 0;

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 px-4 py-3"
      role="status"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-center gap-2 text-sm">
          {wentWell ? (
            <Check className="size-4 shrink-0 text-status-completed" />
          ) : (
            <AlertCircle className="size-4 shrink-0 text-priority-urgent" />
          )}
          <span>{report.summary}</span>
        </p>

        <Button size="icon-xs" variant="ghost" onClick={dismissReport} aria-label="Dismiss">
          <X />
        </Button>
      </div>

      {report.moved > 0 && (
        <p className="break-all text-xs text-muted-foreground">Into {report.destination}.</p>
      )}

      {notMoved.length > 0 && (
        <ul className="flex flex-col gap-1 pt-1 text-xs text-muted-foreground">
          {notMoved.map((outcome) => (
            <li key={outcome.path}>
              <span className="text-foreground">{outcome.name}</span>
              {outcome.message !== null && ` — ${outcome.message}`}
              {outcome.status === "skipped" && " (left where it was)"}
            </li>
          ))}
        </ul>
      )}

      <RenameNote outcomes={report.outcomes} />
    </div>
  );
}

/**
 * Says so when a file landed under a different name.
 *
 * A name already taken in the destination gets ` (1)` appended rather than
 * overwriting what was there — which is the right behaviour and a surprising
 * one, so somebody who later goes looking for `Screenshot 2026-08-29.png`
 * needs to be told it is now `Screenshot 2026-08-29 (1).png`.
 */
function RenameNote({ outcomes }: { outcomes: MoveOutcome[] }) {
  const renamed = outcomes.filter(
    (outcome) =>
      outcome.status === "moved" &&
      outcome.newPath !== null &&
      !outcome.newPath.endsWith(outcome.name),
  );

  if (renamed.length === 0) return null;

  return (
    <p className="text-xs text-muted-foreground">
      {renamed.length === 1
        ? `${renamed[0].name} was renamed — that name was already taken there.`
        : `${renamed.length} were renamed — those names were already taken there.`}
    </p>
  );
}

export default ScreenshotReport;
