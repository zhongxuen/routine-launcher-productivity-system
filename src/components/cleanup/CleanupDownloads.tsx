import { useEffect } from "react";

import ErrorState from "@/components/common/states/ErrorState";
import InlineError from "@/components/common/states/InlineError";
import Spinner from "@/components/common/states/Spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { useDownloadsStore } from "@/stores/downloadsStore";

import DownloadsActionReport from "./DownloadsActionReport";
import DownloadsReview from "./DownloadsReview";
import DownloadsSummary from "./DownloadsSummary";

/**
 * Cleanup > Downloads (development-plan.md sections 38-39) — the two views of
 * one scan, and the gate between them.
 *
 * ```text
 * DOWNLOADS                    [ Review Downloads ]      DOWNLOADS · REVIEW
 * Files: 147                          ───────────►       ☐ old-video.mp4
 * Images 53 · Documents 31 · …                           ☑ setup.exe
 * Largest: 2.4 GB                                        [ Move ] [ Delete ]
 * ```
 *
 * Everything this route does that touches a file is on the far side of a
 * button the user pressed. The scan on mount is the exception, and it is not
 * an exception to section 67: it reads, and only reads. The summary states
 * what is there; it recommends nothing and offers no action at all. The one
 * way forward is "Review Downloads", which is where selecting begins.
 *
 * The scan is re-run on every arrival rather than reused from the store,
 * because a Downloads folder changes between visits for reasons that have
 * nothing to do with this app — every browser download is one — and a
 * checkbox next to a file that is no longer there is the beginning of the
 * kind of mistake this whole feature is built to avoid.
 */
function CleanupDownloads() {
  const scan = useDownloadsStore((state) => state.scan);
  const isScanning = useDownloadsStore((state) => state.isScanning);
  const error = useDownloadsStore((state) => state.error);
  const stage = useDownloadsStore((state) => state.stage);
  const report = useDownloadsStore((state) => state.report);
  const runScan = useDownloadsStore((state) => state.runScan);
  const closeReview = useDownloadsStore((state) => state.closeReview);

  useEffect(() => {
    void runScan();
  }, [runScan]);

  // Leaving the route drops the selection with it. A set of ticked files is a
  // thing the user is in the middle of, not a preference: coming back to
  // Downloads tomorrow and finding four boxes already checked would be the
  // app having made a decision on their behalf while they were gone.
  useEffect(() => closeReview, [closeReview]);

  // The failure comes first: a scan that could not run produces no scan, so
  // checking `scan === null` before `error` would answer a folder we could
  // not read with a skeleton that never resolves.
  if (error !== null && scan === null) {
    return (
      <ErrorState
        title="Could not read your Downloads folder."
        message={error}
        onRetry={() => void runScan()}
      />
    );
  }

  if (scan === null) {
    return <DownloadsSkeleton />;
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      {report !== null && <DownloadsActionReport report={report} />}

      {/*
        A rescan that failed after an earlier one worked, said the same way
        Screenshots says it. The panel below is still drawn — the previous
        scan is the best thing available — but it now describes a moment that
        has passed, and that has to be stated rather than left to look
        current, because everything the user ticks next is ticked against it.
      */}
      {error !== null && (
        <InlineError
          message={`Could not look again — what is below is from the last scan that worked. ${error}`}
          onRetry={() => void runScan()}
          retryLabel="Rescan"
        />
      )}

      {stage === "summary" ? <DownloadsSummary scan={scan} /> : <DownloadsReview scan={scan} />}

      {/* The summary's own Rescan button says "Scanning…" while it works, but
          Review has no such button — and a rescan can be started from the
          tray or a previous view — so the wait is stated here too. */}
      {isScanning && stage === "review" && (
        <Spinner className="text-xs" label="Looking again…" />
      )}
    </div>
  );
}

/**
 * The shape of the summary and the panel under it, while the folder is walked.
 *
 * A skeleton rather than a spinner even though the scan is a filesystem walk:
 * what comes back is always these two blocks, whether the folder holds four
 * files or four hundred, so the layout can be promised even when the contents
 * cannot.
 */
function DownloadsSkeleton() {
  return (
    <div role="status" aria-busy className="flex flex-col gap-4 py-2">
      <span className="sr-only">Reading your Downloads folder</span>
      <Skeleton className="h-28 w-full" aria-hidden />
      <Skeleton className="h-48 w-full" aria-hidden />
    </div>
  );
}

export default CleanupDownloads;
