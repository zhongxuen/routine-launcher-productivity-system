import { ArrowLeft, FolderInput, Trash2 } from "lucide-react";

import EmptyState from "@/components/common/states/EmptyState";
import InlineError from "@/components/common/states/InlineError";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { categoryLabel, filesInCategory, formatBytes } from "@/lib/downloads-utils";
import { useDownloadsStore } from "@/stores/downloadsStore";
import type { DownloadsScan, FileCategoryId } from "@/types/downloads";

import DownloadsConfirmDialog from "./DownloadsConfirmDialog";
import DownloadsFileRow from "./DownloadsFileRow";

/**
 * The "Review Downloads" flow of development-plan.md section 39 — step three
 * of section 67, where the user selects.
 *
 * The list opens with nothing ticked and no action available. Move and Delete
 * are disabled until at least one box is checked, and pressing either opens a
 * confirmation rather than doing anything: the four steps of section 67 stay
 * four separate things the user does, in order, with the app never taking one
 * of them on its behalf.
 *
 * The category chips filter, and only filter. "Select all" ticks what the
 * filter is showing and says so on the button, so it can never quietly reach
 * files that are not on screen.
 */
function DownloadsReview({ scan }: { scan: DownloadsScan }) {
  const category = useDownloadsStore((state) => state.category);
  const selected = useDownloadsStore((state) => state.selected);
  const actionError = useDownloadsStore((state) => state.actionError);
  const isActing = useDownloadsStore((state) => state.isActing);
  const closeReview = useDownloadsStore((state) => state.closeReview);
  const setCategory = useDownloadsStore((state) => state.setCategory);
  const toggleFile = useDownloadsStore((state) => state.toggleFile);
  const selectAllShown = useDownloadsStore((state) => state.selectAllShown);
  const clearSelection = useDownloadsStore((state) => state.clearSelection);
  const requestAction = useDownloadsStore((state) => state.requestAction);

  const shown = filesInCategory(scan.files, category);
  const selectedFiles = scan.files.filter((file) => selected.has(file.path));
  const selectedBytes = selectedFiles.reduce((total, file) => total + file.size_bytes, 0);

  const allShownSelected = shown.length > 0 && shown.every((file) => selected.has(file.path));
  const hasSelection = selectedFiles.length > 0;

  return (
    <Card className="flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button size="icon-sm" variant="ghost" onClick={closeReview} aria-label="Back to summary">
            <ArrowLeft />
          </Button>
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium tracking-widest text-muted-foreground">
              DOWNLOADS · REVIEW
            </p>
            <p className="text-xs text-muted-subtle">
              {shown.length} of {scan.file_count} shown · nothing happens until you choose an action
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="downloads-select-all"
            checked={allShownSelected}
            disabled={shown.length === 0}
            onCheckedChange={() => (allShownSelected ? clearSelection() : selectAllShown(shown))}
            aria-label={
              allShownSelected ? "Clear the selection" : `Select all ${shown.length} shown files`
            }
          />
          <label htmlFor="downloads-select-all" className="cursor-pointer text-xs">
            {allShownSelected
              ? "Clear selection"
              : `Select all ${category === null ? "" : "shown "}(${shown.length})`}
          </label>
        </div>
      </header>

      <CategoryFilter scan={scan} category={category} onChange={setCategory} />

      {actionError !== null && <InlineError message={actionError} />}

      {shown.length === 0 ? (
        <EmptyState className="py-10" title="No files in this category." />
      ) : (
        <ul className="flex max-h-[26rem] flex-col overflow-y-auto">
          {shown.map((file) => (
            <DownloadsFileRow
              key={file.path}
              file={file}
              isSelected={selected.has(file.path)}
              onToggle={() => toggleFile(file.path)}
              categoryLabel={categoryLabel(scan.categories, file.category)}
            />
          ))}
        </ul>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
        <p className="text-xs text-muted-foreground">
          {hasSelection
            ? `${selectedFiles.length} selected · ${formatBytes(selectedBytes)}`
            : "Nothing selected. Tick the files you want to deal with."}
        </p>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!hasSelection || isActing}
            onClick={() => requestAction("move")}
          >
            <FolderInput />
            Move…
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={!hasSelection || isActing}
            onClick={() => requestAction("delete")}
          >
            <Trash2 />
            Delete…
          </Button>
        </div>
      </footer>

      <DownloadsConfirmDialog files={selectedFiles} />
    </Card>
  );
}

/**
 * The five buckets as filter chips, plus All.
 *
 * Each chip carries its count, so the filter doubles as the summary's
 * category list — which is how somebody who came here to deal with "the 18
 * installers" gets to exactly those without reading 147 rows. Empty buckets
 * are disabled rather than hidden, so the row of chips does not change shape
 * between scans.
 */
function CategoryFilter({
  scan,
  category,
  onChange,
}: {
  scan: DownloadsScan;
  category: FileCategoryId | null;
  onChange: (category: FileCategoryId | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Chip isActive={category === null} onClick={() => onChange(null)}>
        All ({scan.file_count})
      </Chip>

      {scan.categories.map((entry) => (
        <Chip
          key={entry.category}
          isActive={category === entry.category}
          isDisabled={entry.count === 0}
          onClick={() => onChange(entry.category)}
        >
          {entry.label} ({entry.count})
        </Chip>
      ))}
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

export default DownloadsReview;
