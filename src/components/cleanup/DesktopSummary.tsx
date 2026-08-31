import { FolderOpen, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatBytes, formatItemCount } from "@/lib/desktop-utils";
import { useDesktopStore } from "@/stores/desktopStore";
import type { DesktopScan, DesktopSource } from "@/types/desktop";

/**
 * The summary panel of Desktop Cleanup (development-plan.md sections 38, 81).
 *
 * ```text
 * DESKTOP
 *
 * Items:            Kinds:              Age:
 * 84
 *                   Shortcuts    31     Today         4
 * Largest:          Folders       6     This week    11
 * 1.9 GB            Images       19     This month   23
 *                   Documents    14     Older        46
 *                   Archives      3
 *                   Installers    2
 *                   Other         9
 *
 * [ Review Desktop ]
 * ```
 *
 * A statement of what is on the desktop, and nothing more. It offers no "clean
 * up", no "delete the old installers", no suggestion of which items to lose —
 * section 39's "the system should only recommend actions" is honoured here by
 * not even doing that: the app has no idea which of these shortcuts matter,
 * and a recommendation dressed up as a number would be a nudge towards
 * deleting something on the strength of its extension or its date.
 *
 * There is one button, and it opens a list. That is the entire step from
 * "show results" to "user selects".
 *
 * Two columns rather than Downloads' one, because a desktop has two axes worth
 * looking at. Kind is what a thing *is*; age is how long it has been sitting
 * there, and on a desktop the second is usually the one somebody came here
 * about.
 */
function DesktopSummary({ scan }: { scan: DesktopScan }) {
  const isScanning = useDesktopStore((state) => state.isScanning);
  const runScan = useDesktopStore((state) => state.runScan);
  const openReview = useDesktopStore((state) => state.openReview);

  const isEmpty = scan.item_count === 0;
  const actionable = scan.items.filter((item) => item.actionable).length;

  return (
    <Card className="flex flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-medium tracking-widest text-muted-foreground">DESKTOP</p>
          <SourceLine sources={scan.sources} />
        </div>

        <Button
          size="sm"
          variant="ghost"
          disabled={isScanning}
          onClick={() => void runScan()}
          aria-label="Scan the desktop again"
        >
          <RefreshCw className={isScanning ? "animate-spin" : undefined} />
          {isScanning ? "Scanning…" : "Rescan"}
        </Button>
      </header>

      {/* Stacked below `lg` (section 84). Three columns of "label ... count"
          rows is the first thing in Cleanup to stop being readable when the
          window is halved, and there are three of them here. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Stat
            label="Items"
            value={String(scan.item_count)}
            hint={`${formatBytes(scan.total_bytes)} across ${scan.file_count + scan.shortcut_count} files and shortcuts`}
          />
          <Stat
            label="Largest"
            value={scan.largest === null ? "—" : formatBytes(scan.largest.size_bytes)}
            hint={scan.largest?.name}
          />
        </div>

        <CountList
          title="KINDS"
          rows={scan.kinds.map((kind) => ({
            key: kind.kind,
            label: kind.label,
            count: kind.count,
            // Folders were never measured, so a size next to one would be a
            // claim about something this scan deliberately did not look at.
            size: kind.kind === "folder" ? null : kind.size_bytes,
          }))}
        />

        <CountList
          title="AGE"
          rows={scan.ages.map((age) => ({
            key: age.age,
            label: age.label,
            count: age.count,
            size: age.size_bytes,
          }))}
        />
      </div>

      <footer className="flex flex-col gap-3 border-t border-border/60 pt-4">
        <Button className="w-fit" disabled={isEmpty} onClick={openReview}>
          <FolderOpen />
          Review Desktop
        </Button>

        <p className="text-xs text-muted-foreground">
          {isEmpty
            ? "Nothing to review — the top level of your desktop is empty."
            : `Reviewing shows all ${formatItemCount(scan.item_count).toLowerCase()} so you can pick the ones to move or delete. Nothing is ever removed on its own.`}
        </p>

        <ScanNotes
          scan={scan}
          actionable={actionable}
          unactionable={scan.item_count - actionable}
        />
      </footer>
    </Card>
  );
}

/**
 * Which desktops were read, said in one line.
 *
 * Named rather than assumed, and both of them: a user whose Public Desktop
 * holds four shortcuts they have never been able to remove should be able to
 * see that this tool looked there and why it cannot help.
 */
function SourceLine({ sources }: { sources: DesktopSource[] }) {
  const present = sources.filter((source) => source.exists);
  if (present.length === 0) return null;

  return (
    <p
      className="max-w-xl truncate text-xs text-muted-subtle"
      title={present.map((source) => source.path).join("\n")}
    >
      {present.map((source) => source.path).join("  ·  ")}
    </p>
  );
}

/** One of the mockup's label-over-number pairs. */
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs font-medium tracking-widest text-muted-foreground">
        {label.toUpperCase()}
      </p>
      <p className="text-3xl font-semibold tabular-nums">{value}</p>
      {hint !== undefined && (
        <p className="max-w-xs truncate text-xs text-muted-subtle" title={hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * A column of "label ... size count" rows.
 *
 * Empty buckets are printed rather than dropped, so the panel is the same
 * height and the same shape after a cleanup as it was before one — a list that
 * reflows every time you delete something is a list you have to re-read every
 * time you delete something.
 *
 * A size of zero prints as nothing rather than as "0 KB". A bucket can hold
 * items and still weigh nothing — the folders row always does, and an age
 * window containing only folders does too — and "0 KB" beside a count of 6
 * reads as a measurement that came out zero rather than as one that was never
 * taken.
 */
function CountList({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; label: string; count: number; size: number | null }[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium tracking-widest text-muted-foreground">{title}</p>

      <ul className="flex flex-col">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1.5 last:border-b-0"
          >
            <span className="text-sm">{row.label}</span>
            <span className="flex items-baseline gap-3">
              <span className="text-xs text-muted-subtle">
                {row.size === null || row.size === 0 ? "" : formatBytes(row.size)}
              </span>
              <span className="w-8 text-right text-sm tabular-nums">{row.count}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the scan did *not* do, and what it cannot do anything about.
 *
 * Said out loud because the alternative is a count that quietly disagrees with
 * what is on screen, and a user who concludes the tool is wrong. Three things
 * are worth stating: folders are listed but never acted on, the public desktop
 * is read-only here, and anything that could not be read is not in the list.
 */
function ScanNotes({
  scan,
  actionable,
  unactionable,
}: {
  scan: DesktopScan;
  actionable: number;
  unactionable: number;
}) {
  const notes: string[] = [];

  if (scan.folder_count > 0) {
    notes.push(
      `${scan.folder_count} ${scan.folder_count === 1 ? "folder is" : "folders are"} listed but never acted on — cleanup only ever touches files and shortcuts`,
    );
  }

  const publicSource = scan.sources.find((source) => source.kind === "public");
  const onPublic = scan.items.filter((item) => item.source === publicSource?.label).length;
  if (publicSource !== undefined && onPublic > 0) {
    notes.push(
      `${onPublic} ${onPublic === 1 ? "item is" : "items are"} on the ${publicSource.label}, shared with everyone who uses this computer, and can only be changed with administrator rights this app does not ask for`,
    );
  }

  if (scan.unreadable_count > 0) {
    notes.push(
      `${scan.unreadable_count} ${scan.unreadable_count === 1 ? "entry" : "entries"} could not be read or ${scan.unreadable_count === 1 ? "is a link" : "are links"} to somewhere else, and ${scan.unreadable_count === 1 ? "is" : "are"} not listed`,
    );
  }

  scan.sources
    .filter((source) => source.error !== null)
    .forEach((source) => notes.push(`${source.label} could not be read — ${source.error}`));

  if (unactionable > 0 && actionable === 0 && scan.item_count > 0) {
    notes.push("nothing on this desktop can be moved or deleted from here");
  }

  if (notes.length === 0) return null;

  return <p className="text-xs text-muted-subtle">{notes.join(" · ")}.</p>;
}

export default DesktopSummary;
