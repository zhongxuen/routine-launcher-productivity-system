import { ArrowLeft, FolderInput, Trash2 } from "lucide-react";

import EmptyState from "@/components/common/states/EmptyState";
import InlineError from "@/components/common/states/InlineError";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  actionableItems,
  formatBytes,
  itemsMatching,
  kindLabel,
  totalBytes,
  type DesktopFilter,
} from "@/lib/desktop-utils";
import { cn } from "@/lib/utils";
import { useDesktopStore } from "@/stores/desktopStore";
import type { AgeBucketId, DesktopKindId, DesktopScan } from "@/types/desktop";

import DesktopConfirmDialog from "./DesktopConfirmDialog";
import DesktopItemRow from "./DesktopItemRow";

/**
 * The "Review Desktop" flow (development-plan.md sections 38, 81) — step three
 * of section 67, where the user selects.
 *
 * The list opens with nothing ticked and no action available. Move and Delete
 * are disabled until at least one box is checked, and pressing either opens a
 * confirmation rather than doing anything: the four steps of section 67 stay
 * four separate things the user does, in order, with the app never taking one
 * of them on its behalf.
 *
 * The chips filter, and only filter — by kind on the first row, by age on the
 * second, and the two narrow together. "Select all" ticks what the filter is
 * showing *and what can be acted on*, and says how many that is on the label,
 * so it can never quietly reach a folder, a public-desktop shortcut, or a row
 * that is not on screen.
 */
function DesktopReview({ scan }: { scan: DesktopScan }) {
  const filter = useDesktopStore((state) => state.filter);
  const selected = useDesktopStore((state) => state.selected);
  const actionError = useDesktopStore((state) => state.actionError);
  const isActing = useDesktopStore((state) => state.isActing);
  const closeReview = useDesktopStore((state) => state.closeReview);
  const setKind = useDesktopStore((state) => state.setKind);
  const setAge = useDesktopStore((state) => state.setAge);
  const toggleItem = useDesktopStore((state) => state.toggleItem);
  const selectAllShown = useDesktopStore((state) => state.selectAllShown);
  const clearSelection = useDesktopStore((state) => state.clearSelection);
  const requestAction = useDesktopStore((state) => state.requestAction);

  const shown = itemsMatching(scan.items, filter);
  const selectable = actionableItems(shown);
  const selectedItems = scan.items.filter((item) => selected.has(item.path));

  const allSelectableSelected =
    selectable.length > 0 && selectable.every((item) => selected.has(item.path));
  const hasSelection = selectedItems.length > 0;

  return (
    <Card className="flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button size="icon-sm" variant="ghost" onClick={closeReview} aria-label="Back to summary">
            <ArrowLeft />
          </Button>
          <div className="flex flex-col gap-0.5">
            <p className="text-xs font-medium tracking-widest text-muted-foreground">
              DESKTOP · REVIEW
            </p>
            <p className="text-xs text-muted-subtle">
              {shown.length} of {scan.item_count} shown · nothing happens until you choose an action
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="desktop-select-all"
            checked={allSelectableSelected}
            disabled={selectable.length === 0}
            onCheckedChange={() =>
              allSelectableSelected ? clearSelection() : selectAllShown(selectable)
            }
            aria-label={
              allSelectableSelected
                ? "Clear the selection"
                : `Select all ${selectable.length} items that can be acted on`
            }
          />
          <label htmlFor="desktop-select-all" className="cursor-pointer text-xs">
            {allSelectableSelected ? "Clear selection" : `Select all (${selectable.length})`}
          </label>
        </div>
      </header>

      <Filters scan={scan} filter={filter} onKind={setKind} onAge={setAge} />

      {actionError !== null && <InlineError message={actionError} />}

      {shown.length === 0 ? (
        <EmptyState className="py-10" title="Nothing matches those filters." />
      ) : (
        <ul className="flex max-h-[26rem] flex-col overflow-y-auto">
          {shown.map((item) => (
            <DesktopItemRow
              key={item.path}
              item={item}
              isSelected={selected.has(item.path)}
              onToggle={() => toggleItem(item)}
              kindLabel={kindLabel(scan.kinds, item.kind)}
              showSource={scan.sources.filter((source) => source.exists).length > 1}
            />
          ))}
        </ul>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
        <p className="text-xs text-muted-foreground">
          {hasSelection
            ? `${selectedItems.length} selected · ${formatBytes(totalBytes(selectedItems))}`
            : "Nothing selected. Tick the items you want to deal with."}
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

      <DesktopConfirmDialog items={selectedItems} />
    </Card>
  );
}

/**
 * The two rows of filter chips: seven kinds, then four age windows.
 *
 * Each chip carries its count, so the filters double as the summary's two
 * lists — which is how somebody who came here to deal with "the 46 things
 * older than a month" gets to exactly those without reading 84 rows. Empty
 * buckets are disabled rather than hidden, so the rows do not change shape
 * between scans.
 */
function Filters({
  scan,
  filter,
  onKind,
  onAge,
}: {
  scan: DesktopScan;
  filter: DesktopFilter;
  onKind: (kind: DesktopKindId | null) => void;
  onAge: (age: AgeBucketId | null) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        <Chip isActive={filter.kind === null} onClick={() => onKind(null)}>
          All kinds ({scan.item_count})
        </Chip>

        {scan.kinds.map((entry) => (
          <Chip
            key={entry.kind}
            isActive={filter.kind === entry.kind}
            isDisabled={entry.count === 0}
            onClick={() => onKind(entry.kind)}
          >
            {entry.label} ({entry.count})
          </Chip>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Chip isActive={filter.age === null} onClick={() => onAge(null)}>
          Any age ({scan.item_count})
        </Chip>

        {scan.ages.map((entry) => (
          <Chip
            key={entry.age}
            isActive={filter.age === entry.age}
            isDisabled={entry.count === 0}
            onClick={() => onAge(entry.age)}
          >
            {entry.label} ({entry.count})
          </Chip>
        ))}
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

export default DesktopReview;
