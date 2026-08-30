import { useEffect } from "react";

import ErrorState from "@/components/common/states/ErrorState";
import InlineError from "@/components/common/states/InlineError";
import Spinner from "@/components/common/states/Spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { useScreenshotStore } from "@/stores/screenshotStore";

import ScreenshotReport from "./ScreenshotReport";
import ScreenshotReview from "./ScreenshotReview";
import ScreenshotSummary from "./ScreenshotSummary";

/**
 * Cleanup > Screenshots (development-plan.md sections 38, 42) — the two views
 * of one scan, and the gate between them.
 *
 * ```text
 * SCREENSHOTS                        [ Review ]      SCREENSHOTS · REVIEW
 * 147 screenshots found                 ────►        ☐ Screenshot 2026-08-29…
 * Today: 12  This week: 38  This month: 97           ☑ Screenshot 2026-08-28…
 *                                                    [ Choose folder… ] [ Organize… ]
 * ```
 *
 * Everything this route does that touches a file is on the far side of two
 * buttons the user pressed — Organize, then the confirmation. The scan on
 * mount is the exception, and it is not an exception to section 67: it reads,
 * and only reads.
 *
 * The scan is re-run on every arrival rather than reused from the store,
 * because the folders it walks change between visits for reasons that have
 * nothing to do with this app — every Print Screen is one — and a ticked box
 * next to a file that is no longer there is the beginning of the kind of
 * mistake this whole feature is built to avoid.
 */
function CleanupScreenshots() {
  const scan = useScreenshotStore((state) => state.scan);
  const isScanning = useScreenshotStore((state) => state.isScanning);
  const error = useScreenshotStore((state) => state.error);
  const stage = useScreenshotStore((state) => state.stage);
  const report = useScreenshotStore((state) => state.report);
  const runScan = useScreenshotStore((state) => state.runScan);
  const backToSummary = useScreenshotStore((state) => state.backToSummary);

  useEffect(() => {
    void runScan();
  }, [runScan]);

  // Leaving the route drops the selection with it. A set of ticked files is a
  // thing the user is in the middle of, not a preference: coming back
  // tomorrow to find forty boxes already checked would be the app having made
  // a decision on their behalf while they were gone.
  useEffect(() => backToSummary, [backToSummary]);

  // The failure comes first: a scan that could not run produces no scan, so
  // checking `scan === null` first would answer folders we could not read
  // with a skeleton that never resolves.
  if (error !== null && scan === null) {
    return (
      <ErrorState
        title="Could not look for your screenshots."
        message={error}
        onRetry={() => void runScan()}
      />
    );
  }

  if (scan === null) {
    return <ScreenshotSkeleton />;
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      {report !== null && <ScreenshotReport report={report} />}

      {/*
        A rescan that failed after an earlier one worked. The panel below is
        still drawn, because the previous scan's results are the best thing
        available — but they are now a description of a moment that has passed,
        and that has to be said rather than left to look current.
      */}
      {error !== null && (
        <InlineError
          message={`Could not look again — what is below is from the last scan that worked. ${error}`}
          onRetry={() => void runScan()}
          retryLabel="Rescan"
        />
      )}

      {stage === "summary" ? (
        <ScreenshotSummary scan={scan} />
      ) : (
        <ScreenshotReview scan={scan} />
      )}

      {isScanning && <Spinner className="text-xs" label="Looking again…" />}
    </div>
  );
}

/** The shape of the panel while the screenshot folders are walked. */
function ScreenshotSkeleton() {
  return (
    <div role="status" aria-busy className="flex flex-col gap-4 py-2">
      <span className="sr-only">Looking for your screenshots</span>
      <Skeleton className="h-52 w-full" aria-hidden />
    </div>
  );
}

export default CleanupScreenshots;
