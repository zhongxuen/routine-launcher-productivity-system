import { HardDrive } from "lucide-react";

import { Card } from "@/components/ui/card";
import { driveTitle, formatBytes, isNearlyFull, percentUsed } from "@/lib/storage-utils";
import { cn } from "@/lib/utils";
import type { Drive } from "@/types/storage";

/**
 * One fixed drive: what is on it, what is left, and nothing to press.
 *
 * ```text
 * ┌──────────────────────────────────────┐
 * │ Windows (C:)              NTFS       │
 * │ ████████████████░░░░░░░  67% used    │
 * │ 305 GB free of 931 GB                │
 * └──────────────────────────────────────┘
 * ```
 *
 * The bar is drawn from `usedBytes`, but the sentence under it leads with
 * *free* space, because that is the number a person is actually looking for —
 * "how much room have I got". Both come from the same two figures, so they
 * cannot disagree.
 *
 * A drive over 90% full is coloured and says so in words. That is the whole
 * of the reaction: no "clean up this drive" button, no suggestion of what to
 * remove. This utility reports, and the two links on the folders below are
 * the only places it points anywhere.
 */
function DriveCard({ drive }: { drive: Drive }) {
  const used = percentUsed(drive);
  const full = isNearlyFull(drive);

  return (
    <Card className="flex min-w-0 flex-1 flex-col gap-2.5 p-4">
      <header className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <HardDrive className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="truncate text-sm font-medium" title={drive.root}>
            {driveTitle(drive)}
          </p>
          {drive.holdsProfile && (
            // Says which drive the folder list underneath is measuring, which
            // is not obvious at all on a machine with three of them.
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Your files
            </span>
          )}
        </div>
        {drive.fileSystem !== "" && (
          <p className="shrink-0 text-xs text-muted-foreground">{drive.fileSystem}</p>
        )}
      </header>

      {/* Decorative: every figure it encodes is written out underneath it, so
          a screen reader that skipped it would miss nothing. */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className={cn("h-full rounded-full transition-all", full ? "bg-destructive" : "bg-primary")}
          style={{ width: `${used}%` }}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{formatBytes(drive.freeBytes)} free</span> of{" "}
        {formatBytes(drive.totalBytes)} · {used}% used
        {full && <span className="text-destructive"> · nearly full</span>}
      </p>
    </Card>
  );
}

export default DriveCard;
