import { useEffect } from "react";

import ErrorState from "@/components/common/states/ErrorState";
import InlineError from "@/components/common/states/InlineError";
import Spinner from "@/components/common/states/Spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { useDesktopStore } from "@/stores/desktopStore";

import DesktopActionReport from "./DesktopActionReport";
import DesktopReview from "./DesktopReview";
import DesktopSummary from "./DesktopSummary";

/**
 * Cleanup > Desktop (development-plan.md sections 38, 81) — the two views of
 * one scan, and the gate between them.
 *
 * ```text
 * DESKTOP                        [ Review Desktop ]      DESKTOP · REVIEW
 * Items: 84                            ───────────►      ☐ Old Build.lnk
 * Shortcuts 31 · Folders 6 · …                           ☑ setup.exe
 * Older: 46                                              [ Move ] [ Delete ]
 * ```
 *
 * Everything this route does that touches a file is on the far side of a
 * button the user pressed. The scan on mount is the exception, and it is not
 * an exception to section 67: it reads, and only reads. The summary states
 * what is there; it recommends nothing and offers no action at all. The one
 * way forward is "Review Desktop", which is where selecting begins.
 *
 * The scan is re-run on every arrival rather than reused from the store,
 * because a desktop changes between visits for reasons that have nothing to do
 * with this app — every installer that drops a shortcut is one — and a
 * checkbox next to an item that is no longer there is the beginning of the
 * kind of mistake this whole feature is built to avoid.
 */
function CleanupDesktop() {
  const scan = useDesktopStore((state) => state.scan);
  const isScanning = useDesktopStore((state) => state.isScanning);
  const error = useDesktopStore((state) => state.error);
  const stage = useDesktopStore((state) => state.stage);
  const report = useDesktopStore((state) => state.report);
  const runScan = useDesktopStore((state) => state.runScan);
  const closeReview = useDesktopStore((state) => state.closeReview);

  useEffect(() => {
    void runScan();
  }, [runScan]);

  // Leaving the route drops the selection with it. A set of ticked items is a
  // thing the user is in the middle of, not a preference: coming back to
  // Desktop tomorrow and finding four boxes already checked would be the app
  // having made a decision on their behalf while they were gone.
  useEffect(() => closeReview, [closeReview]);

  // The failure comes first: a scan that could not run produces no scan, so
  // checking `scan === null` before `error` would answer a desktop we could
  // not read with a skeleton that never resolves.
  if (error !== null && scan === null) {
    return (
      <ErrorState
        title="Could not read your Desktop."
        message={error}
        onRetry={() => void runScan()}
      />
    );
  }

  if (scan === null) {
    return <DesktopSkeleton />;
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      {report !== null && <DesktopActionReport report={report} />}

      {/*
        A rescan that failed after an earlier one worked, said the same way
        Downloads says it. The panel below is still drawn — the previous scan
        is the best thing available — but it now describes a moment that has
        passed, and that has to be stated rather than left to look current,
        because everything the user ticks next is ticked against it.
      */}
      {error !== null && (
        <InlineError
          message={`Could not look again — what is below is from the last scan that worked. ${error}`}
          onRetry={() => void runScan()}
          retryLabel="Rescan"
        />
      )}

      {stage === "summary" ? <DesktopSummary scan={scan} /> : <DesktopReview scan={scan} />}

      {/* The summary's own Rescan button says "Scanning…" while it works, but
          Review has no such button — and a rescan follows every action — so
          the wait is stated here too. */}
      {isScanning && stage === "review" && <Spinner className="text-xs" label="Looking again…" />}
    </div>
  );
}

/**
 * The shape of the summary and the panel under it, while the desktops are
 * read.
 *
 * A skeleton rather than a spinner even though the scan is a filesystem walk:
 * what comes back is always these two blocks, whether the desktop holds four
 * items or four hundred, so the layout can be promised even when the contents
 * cannot.
 */
function DesktopSkeleton() {
  return (
    <div role="status" aria-busy className="flex flex-col gap-4 py-2">
      <span className="sr-only">Reading your Desktop</span>
      <Skeleton className="h-28 w-full" aria-hidden />
      <Skeleton className="h-48 w-full" aria-hidden />
    </div>
  );
}

export default CleanupDesktop;
