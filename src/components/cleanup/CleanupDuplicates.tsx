import { useEffect } from "react";
import { ShieldCheck } from "lucide-react";

import EmptyState from "@/components/common/states/EmptyState";
import InlineError from "@/components/common/states/InlineError";
import Spinner from "@/components/common/states/Spinner";
import { useDuplicateStore } from "@/stores/duplicateStore";

import DuplicateActionReport from "./DuplicateActionReport";
import DuplicateConfirmDialog from "./DuplicateConfirmDialog";
import DuplicateGroupCard from "./DuplicateGroupCard";
import DuplicateScanPanel from "./DuplicateScanPanel";
import DuplicateSelectionBar from "./DuplicateSelectionBar";

/**
 * Cleanup > Duplicates — the Duplicate Finder of development-plan.md sections
 * 38, 40 and 67.
 *
 * # The whole view is section 67's sequence, top to bottom
 *
 * ```text
 * Scan             DuplicateScanPanel — chooses folders, reads them, changes nothing
 *  ↓
 * Show results     DuplicateGroupCard — one card per group, nothing ticked
 *  ↓
 * User selects     the checkbox on each row; the bar appears once one is ticked
 *  ↓
 * Confirm          DuplicateConfirmDialog — every path listed, every warning said
 *  ↓
 * Perform action   the store, and only from that dialog
 * ```
 *
 * Nothing is scanned on mount. The first thing this view does is ask Rust
 * which folders it *would* scan and print them; reading a Downloads folder is
 * cheap, but hashing every file in it is not, and starting that because
 * somebody clicked a sidebar link would be the app deciding to work.
 *
 * # Two kinds of match, never blurred together
 *
 * Section 40 lists three comparisons — filename, size, hash — and only two of
 * them prove anything. Identical groups come first and carry a reclaimable
 * figure because their bytes match; same-name groups follow, say in words that
 * their contents differ, and promise nothing. The ordering is Rust's, so the
 * safe block is always the one the user reads first.
 */
function CleanupDuplicates() {
  const scan = useDuplicateStore((state) => state.scan);
  const isScanning = useDuplicateStore((state) => state.isScanning);
  const isReady = useDuplicateStore((state) => state.isReady);
  const error = useDuplicateStore((state) => state.error);
  const loadDefaults = useDuplicateStore((state) => state.loadDefaults);
  const runScan = useDuplicateStore((state) => state.runScan);

  // Only the folder names, and only once. See the note above about why the
  // scan itself waits for a button.
  useEffect(() => {
    void loadDefaults();
  }, [loadDefaults]);

  return (
    <div className="flex flex-col gap-4 py-2">
      <DuplicateScanPanel />

      {/* Above the results rather than instead of them: a failed *re*scan
          leaves the previous groups on screen, and those are still the best
          thing available to look at. */}
      {error !== null && (
        <InlineError
          className="px-4 py-3 text-sm"
          message={`The scan could not be completed. ${error}`}
          onRetry={() => void runScan()}
          retryLabel="Rescan"
        />
      )}

      <DuplicateActionReport />

      <ResultsBody isReady={isReady} isScanning={isScanning} hasScan={scan !== null} />

      <DuplicateSelectionBar />
      <DuplicateConfirmDialog />
    </div>
  );
}

/**
 * Everything under the scan panel: the placeholder before a scan, the skeleton
 * during one, the "nothing found" note, or the groups.
 */
function ResultsBody({
  isReady,
  isScanning,
  hasScan,
}: {
  isReady: boolean;
  isScanning: boolean;
  hasScan: boolean;
}) {
  // Select the scan itself and default outside the selector. `?? []` inside it
  // would hand zustand a new array on every read while `scan` is null, which
  // it takes for a change — and re-renders until React gives up.
  const scan = useDuplicateStore((state) => state.scan);
  const groups = scan?.groups ?? [];

  // A spinner rather than skeleton cards, and this is the one place in the
  // app where that is the honest choice: hashing a folder tree can come back
  // with nothing at all, and three placeholder cards would promise three
  // groups for however long the pass takes.
  if (isScanning) {
    return <Spinner className="py-14" label="Comparing files…" />;
  }

  // Still asking Rust which folders it would scan. Short, but it is a wait
  // and not an empty state — the difference matters because the sentence
  // underneath is an invitation to press Scan, and pressing it now would do
  // nothing.
  if (!isReady) {
    return <Spinner className="py-14" label="Finding your Downloads and Desktop folders…" />;
  }

  if (!hasScan) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Nothing has been read yet."
        hint="Scanning compares files by size and then by content. It only reads — nothing is moved or removed until you pick files and confirm."
      />
    );
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        title="No duplicates found."
        hint="Nothing in those folders shares both a size and its contents, and nothing shares a name."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {groups.map((group) => (
        <li key={group.id}>
          <DuplicateGroupCard group={group} />
        </li>
      ))}
    </ul>
  );
}

export default CleanupDuplicates;
