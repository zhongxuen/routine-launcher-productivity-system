import { ArrowLeft, FolderInput, FolderOpen } from "lucide-react";

import EmptyState from "@/components/common/states/EmptyState";
import InlineError from "@/components/common/states/InlineError";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  BUCKET_LABELS,
  bucketCounts,
  formatBytes,
  screenshotsInBucket,
  totalBytes,
} from "@/lib/screenshot-utils";
import { useScreenshotStore } from "@/stores/screenshotStore";
import type { Grouping, ScreenshotBucket, ScreenshotScan } from "@/types/screenshot";

import ScreenshotConfirmDialog from "./ScreenshotConfirmDialog";
import ScreenshotRow from "./ScreenshotRow";

/**
 * The "Review" flow of development-plan.md section 42 — step three of section
 * 67, where the user selects.
 *
 * The list opens with nothing ticked and no action available. Organize is
 * disabled until there is both a selection *and* a folder, and pressing it
 * opens a confirmation rather than doing anything: the steps of section 67
 * stay separate things the user does, in order, with the app never taking one
 * on their behalf.
 *
 * Two decisions are asked for before the button lights up, and they are
 * deliberately different questions:
 *
 * * **Which screenshots** — the checkboxes, filtered by the same buckets the
 *   summary counted.
 * * **Where they go** — a native folder picker, because a typed path is a
 *   path that can be wrong and "where did my screenshots go" is the one
 *   question this tool must never leave open.
 *
 * "Organize them into folders" (section 42) is the grouping choice beside it:
 * one folder, or dated subfolders inside it. Both are moves into somewhere
 * the user chose; neither invents a location.
 */
function ScreenshotReview({ scan }: { scan: ScreenshotScan }) {
  const bucket = useScreenshotStore((state) => state.bucket);
  const selected = useScreenshotStore((state) => state.selected);
  const destination = useScreenshotStore((state) => state.destination);
  const grouping = useScreenshotStore((state) => state.grouping);
  const actionError = useScreenshotStore((state) => state.actionError);
  const isOrganizing = useScreenshotStore((state) => state.isOrganizing);
  const backToSummary = useScreenshotStore((state) => state.backToSummary);
  const setBucket = useScreenshotStore((state) => state.setBucket);
  const toggle = useScreenshotStore((state) => state.toggle);
  const selectAllShown = useScreenshotStore((state) => state.selectAllShown);
  const clearSelection = useScreenshotStore((state) => state.clearSelection);
  const setGrouping = useScreenshotStore((state) => state.setGrouping);
  const chooseDestination = useScreenshotStore((state) => state.chooseDestination);
  const requestOrganize = useScreenshotStore((state) => state.requestOrganize);

  const shown = screenshotsInBucket(scan.screenshots, bucket);
  const selectedScreenshots = scan.screenshots.filter((screenshot) =>
    selected.has(screenshot.path),
  );

  const allShownSelected =
    shown.length > 0 && shown.every((screenshot) => selected.has(screenshot.path));
  const hasSelection = selectedScreenshots.length > 0;
  const canOrganize = hasSelection && destination !== null && !isOrganizing;

  return (
    <Card className="flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={backToSummary}
            aria-label="Back to summary"
          >
            <ArrowLeft />
          </Button>
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium tracking-widest text-muted-foreground">
              SCREENSHOTS · REVIEW
            </p>
            <p className="text-xs text-muted-subtle">
              {shown.length} of {scan.screenshots.length} shown · nothing moves until you confirm
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="screenshots-select-all"
            checked={allShownSelected}
            disabled={shown.length === 0}
            onCheckedChange={() => (allShownSelected ? clearSelection() : selectAllShown())}
            aria-label={
              allShownSelected
                ? "Clear the selection"
                : `Select all ${shown.length} shown screenshots`
            }
          />
          <label htmlFor="screenshots-select-all" className="cursor-pointer text-xs">
            {allShownSelected
              ? "Clear selection"
              : `Select all ${bucket === null ? "" : "shown "}(${shown.length})`}
          </label>
        </div>
      </header>

      <BucketFilter scan={scan} bucket={bucket} onChange={setBucket} />

      {scan.truncated && (
        <p className="text-xs text-muted-subtle">
          {scan.total} screenshots were found and the newest {scan.screenshots.length} are listed.
          File some, then rescan to reach the rest.
        </p>
      )}

      {actionError !== null && <InlineError message={actionError} />}

      {shown.length === 0 ? (
        <EmptyState className="py-10" title="No screenshots in this window." />
      ) : (
        <ul className="flex max-h-[26rem] flex-col overflow-y-auto">
          {shown.map((screenshot) => (
            <ScreenshotRow
              key={screenshot.path}
              screenshot={screenshot}
              isSelected={selected.has(screenshot.path)}
              onToggle={() => toggle(screenshot.path)}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
        <DestinationPicker
          destination={destination}
          grouping={grouping}
          onChoose={() => void chooseDestination()}
          onGroupingChange={setGrouping}
        />

        <footer className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {hasSelection
              ? `${selectedScreenshots.length} selected · ${formatBytes(totalBytes(selectedScreenshots))}`
              : "Nothing selected. Tick the screenshots you want to file."}
          </p>

          <Button size="sm" disabled={!canOrganize} onClick={requestOrganize}>
            <FolderInput />
            Organize…
          </Button>
        </footer>
      </div>

      <ScreenshotConfirmDialog screenshots={selectedScreenshots} />
    </Card>
  );
}

/**
 * The buckets as filter chips, plus All and Older.
 *
 * Each chip carries its own count — the number of screenshots *in* that
 * window rather than the cumulative figure the summary prints, because a
 * filter that says 38 and then shows 26 rows would be lying about itself.
 * Empty windows are disabled rather than hidden, so the row does not change
 * shape between scans.
 */
function BucketFilter({
  scan,
  bucket,
  onChange,
}: {
  scan: ScreenshotScan;
  bucket: ScreenshotBucket | null;
  onChange: (bucket: ScreenshotBucket | null) => void;
}) {
  const counts = bucketCounts(scan.screenshots);

  return (
    <div className="flex flex-wrap gap-1.5">
      <Chip isActive={bucket === null} onClick={() => onChange(null)}>
        All ({scan.screenshots.length})
      </Chip>

      {(Object.keys(counts) as ScreenshotBucket[]).map((key) => (
        <Chip
          key={key}
          isActive={bucket === key}
          isDisabled={counts[key] === 0}
          onClick={() => onChange(key)}
        >
          {BUCKET_LABELS[key]} ({counts[key]})
        </Chip>
      ))}
    </div>
  );
}

/**
 * Where the selection is going, and how it is laid out once it gets there.
 *
 * Both controls sit above the Organize button rather than inside the
 * confirmation, because they are choices to *make* and a confirmation is a
 * thing to *read*. By the time the dialog opens, the sentence it has to show
 * is already fully determined — which is what lets it state exactly what is
 * about to happen instead of asking one more question.
 */
function DestinationPicker({
  destination,
  grouping,
  onChoose,
  onGroupingChange,
}: {
  destination: string | null;
  grouping: Grouping;
  onChoose: () => void;
  onGroupingChange: (grouping: Grouping) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Button size="sm" variant="outline" onClick={onChoose}>
        <FolderOpen />
        {destination === null ? "Choose folder…" : "Change folder…"}
      </Button>

      <p
        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
        title={destination ?? undefined}
      >
        {destination ?? "No folder chosen yet."}
      </p>

      <div className="flex items-center gap-1.5">
        <Chip isActive={grouping === "single"} onClick={() => onGroupingChange("single")}>
          One folder
        </Chip>
        <Chip isActive={grouping === "byMonth"} onClick={() => onGroupingChange("byMonth")}>
          By month
        </Chip>
      </div>
    </div>
  );
}

function Chip({
  isActive,
  isDisabled = false,
  onClick,
  children,
}: {
  isActive: boolean;
  isDisabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={isDisabled}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors",
        isActive
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        isDisabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}

export default ScreenshotReview;
