import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { copiesIn, formatBytes } from "@/lib/duplicate-utils";
import { useDuplicateStore } from "@/stores/duplicateStore";
import type { DuplicateGroup } from "@/types/duplicates";

import DuplicateFileRow from "./DuplicateFileRow";

/**
 * One duplicate group, laid out as development-plan.md section 40 prints it:
 *
 * ```text
 * DUPLICATES
 *
 * photo.png
 * photo (1).png
 * photo-copy.png
 *
 * Size:
 * 4.2 MB
 *
 * [ Review ]
 * ```
 *
 * The mockup's `[ Review ]` is the card itself — the files are already listed,
 * each with the checkbox that is the "user selects" step, so there is nothing
 * left for a Review button to open.
 *
 * # The badge is the honest part
 *
 * Section 40 asks for three comparisons and only two of them prove anything,
 * so the two verdicts are never rendered as if they were one:
 *
 * - **Identical** — same size and same SHA-256. The bytes match; keeping one
 *   copy loses nothing, and the group states what removing the rest frees.
 * - **Same name** — the copy markers came off the names and they matched, but
 *   the contents differ. The card says so in words, offers no reclaimable
 *   figure, and does not offer the one-click "Select the copies" shortcut,
 *   because there is no basis for calling any of them a copy.
 *
 * # Two shortcuts, both undoable in a click
 *
 * "Select the copies" ticks everything except the oldest file. It is a faster
 * route to a selection the user could make by hand — the oldest is marked on
 * its own row, and unticking it or ticking it back is one click. Nothing is
 * ticked when the card first appears; a scan that pre-selected files would be
 * the app deciding, which section 67 does not allow.
 */
function DuplicateGroupCard({ group }: { group: DuplicateGroup }) {
  const selected = useDuplicateStore((state) => state.selected);
  const toggleFile = useDuplicateStore((state) => state.toggleFile);
  const selectCopiesIn = useDuplicateStore((state) => state.selectCopiesIn);
  const selectAllIn = useDuplicateStore((state) => state.selectAllIn);
  const clearGroup = useDuplicateStore((state) => state.clearGroup);

  const isIdentical = group.kind === "identical";
  const selectedHere = group.files.filter((file) => selected.has(file.path)).length;
  const copies = copiesIn(group);
  const allCopiesSelected =
    copies.length > 0 && copies.every((file) => selected.has(file.path));

  return (
    <Card className="flex flex-col gap-3 p-4">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium" title={group.name}>
              {group.name}
            </span>
            <Badge variant={isIdentical ? "default" : "outline"} className="shrink-0 font-normal">
              {isIdentical ? "Identical" : "Same name"}
            </Badge>
          </div>

          <p className="text-xs text-muted-foreground">
            {isIdentical
              ? `${group.files.length} copies · ${formatBytes(group.sizeBytes)} each · keeping one frees ${formatBytes(group.reclaimableBytes)}`
              : `${group.files.length} files share this name but their contents differ — check before removing any of them.`}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {isIdentical && (
            <Button
              size="xs"
              variant="ghost"
              disabled={allCopiesSelected}
              onClick={() => selectCopiesIn(group.id)}
              title="Ticks every copy except the oldest one"
            >
              Select the copies
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => selectAllIn(group.id)}>
            Select all
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={selectedHere === 0}
            onClick={() => clearGroup(group.id)}
          >
            Clear
          </Button>
        </div>
      </header>

      <ul className="flex flex-col">
        {group.files.map((file) => (
          <DuplicateFileRow
            key={file.path}
            file={file}
            isSelected={selected.has(file.path)}
            onToggle={() => toggleFile(file.path)}
          />
        ))}
      </ul>

      {selectedHere === group.files.length && (
        <p className="px-2 text-xs text-priority-urgent">
          Every copy in this group is selected — nothing would be left behind.
        </p>
      )}
    </Card>
  );
}

export default DuplicateGroupCard;
