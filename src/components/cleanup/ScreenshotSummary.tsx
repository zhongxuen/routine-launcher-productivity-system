import { FolderOpen, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  BUCKET_HINTS,
  BUCKET_LABELS,
  formatBytes,
  formatScreenshotCount,
} from "@/lib/screenshot-utils";
import { useScreenshotStore } from "@/stores/screenshotStore";
import type { ScreenshotBucket, ScreenshotScan, ScreenshotSource } from "@/types/screenshot";

/**
 * The summary panel of development-plan.md section 42.
 *
 * ```text
 * SCREENSHOTS
 *
 * 147 screenshots found
 *
 * Today:
 * 12
 *
 * This week:
 * 38
 *
 * This month:
 * 97
 *
 * [ Review ]
 * ```
 *
 * A statement of what is on the disk, and nothing more. It does not suggest
 * which screenshots to file, does not offer a "tidy up", and has no action on
 * it that touches a file — the one button opens a list, which is the entire
 * step from "show results" to "user selects" (section 67).
 *
 * The three counts are cumulative and each one is clickable, opening the
 * review already narrowed to that window. That is the only shortcut the panel
 * offers, and it is a shortcut to *looking*.
 *
 * The folders that were searched are printed underneath, missing ones
 * included. A tool that reports a number without saying where it got it is
 * one the user has to take on faith, and this is a tool whose next screen
 * asks them to move files.
 */
function ScreenshotSummary({ scan }: { scan: ScreenshotScan }) {
  const isScanning = useScreenshotStore((state) => state.isScanning);
  const runScan = useScreenshotStore((state) => state.runScan);
  const openReview = useScreenshotStore((state) => state.openReview);

  const isEmpty = scan.total === 0;

  return (
    <Card className="flex flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-medium tracking-widest text-muted-foreground">SCREENSHOTS</p>
          <p className="text-2xl font-semibold">
            {isEmpty ? "No screenshots found" : `${formatScreenshotCount(scan.total)} found`}
          </p>
          {!isEmpty && (
            <p className="text-xs text-muted-subtle">
              {formatBytes(scan.totalBytes)} in total
            </p>
          )}
        </div>

        <Button
          size="sm"
          variant="ghost"
          disabled={isScanning}
          onClick={() => void runScan()}
          aria-label="Search the folders again"
        >
          <RefreshCw className={isScanning ? "animate-spin" : undefined} />
          {isScanning ? "Scanning…" : "Rescan"}
        </Button>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <BucketStat bucket="today" count={scan.today} disabled={isEmpty} />
        <BucketStat bucket="thisWeek" count={scan.thisWeek} disabled={isEmpty} />
        <BucketStat bucket="thisMonth" count={scan.thisMonth} disabled={isEmpty} />
      </div>

      <footer className="flex flex-col gap-3 border-t border-border/60 pt-4">
        <Button className="w-fit" disabled={isEmpty} onClick={() => openReview(null)}>
          <FolderOpen />
          Review
        </Button>

        <p className="text-xs text-muted-foreground">
          {isEmpty
            ? "Nothing to review — no screenshots turned up in the folders below."
            : "Reviewing lists them so you can pick the ones to file, and where to file them. Nothing is moved until you confirm."}
        </p>

        <SourceList sources={scan.sources} />
      </footer>
    </Card>
  );
}

/**
 * One of the mockup's label-over-number pairs, and a way into the list.
 *
 * A button rather than a figure because the number is the question somebody
 * has — "twelve today, which twelve?" — and the answer is one screen away.
 * The hint under it says what the window actually is: these roll back from
 * midnight rather than following the calendar, so that each count contains
 * the one before it, and a definition the user can read beats three numbers
 * they have to reverse-engineer.
 */
function BucketStat({
  bucket,
  count,
  disabled,
}: {
  bucket: ScreenshotBucket;
  count: number;
  disabled: boolean;
}) {
  const openReview = useScreenshotStore((state) => state.openReview);

  return (
    <button
      type="button"
      disabled={disabled || count === 0}
      onClick={() => openReview(bucket)}
      className={cn(
        "flex flex-col items-start gap-0.5 rounded-lg border border-transparent px-3 py-2 text-left transition-colors",
        "enabled:hover:border-border enabled:hover:bg-accent/40",
        "disabled:cursor-default",
      )}
      aria-label={`Review the ${count} screenshots from ${BUCKET_LABELS[bucket].toLowerCase()}`}
    >
      <span className="text-xs font-medium tracking-widest text-muted-foreground">
        {BUCKET_LABELS[bucket].toUpperCase()}
      </span>
      <span className="text-3xl font-semibold tabular-nums">{count}</span>
      <span className="text-xs text-muted-subtle">{BUCKET_HINTS[bucket]}</span>
    </button>
  );
}

/**
 * Every folder that was looked in, with what it contributed.
 *
 * The folders that do not exist are listed too, greyed out. That is the
 * difference between "you have no screenshots" and "we did not look where
 * yours are", and only the user can tell which of those is happening on their
 * machine.
 */
function SourceList({ sources }: { sources: ScreenshotSource[] }) {
  if (sources.length === 0) return null;

  return (
    <details className="text-xs text-muted-subtle">
      <summary className="cursor-pointer select-none py-1 hover:text-muted-foreground">
        Searched {sources.filter((source) => source.exists).length} of {sources.length} folders
      </summary>

      <ul className="mt-1 flex flex-col gap-1 pl-1">
        {sources.map((source) => (
          <li key={source.path} className="flex items-baseline justify-between gap-3">
            <span className={cn("min-w-0", !source.exists && "opacity-50")}>
              <span className="mr-2">{source.label}</span>
              <span className="break-all font-mono text-[11px]" title={source.path}>
                {source.path}
              </span>
            </span>
            <span className="shrink-0 tabular-nums">
              {!source.exists ? "not found" : (source.error ?? source.matched)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export default ScreenshotSummary;
