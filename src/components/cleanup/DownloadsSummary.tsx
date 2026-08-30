import { FolderOpen, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatBytes, formatFileCount } from "@/lib/downloads-utils";
import { useDownloadsStore } from "@/stores/downloadsStore";
import type { DownloadsScan } from "@/types/downloads";

/**
 * The summary panel of development-plan.md section 39.
 *
 * ```text
 * DOWNLOADS
 *
 * Files:
 * 147
 *
 * Categories:
 *
 * Images       53
 * Documents    31
 * ZIP          12
 * Installers   18
 * Other        33
 *
 * Largest:
 * 2.4 GB
 *
 * [ Review Downloads ]
 * ```
 *
 * A statement of what is in the folder, and nothing more. It offers no "clean
 * up", no "delete the installers", no suggestion of which files to lose —
 * section 39's "the system should only recommend actions" is honoured here by
 * not even doing that: the app has no idea which of these downloads matter,
 * and a recommendation dressed up as a number would be a nudge towards
 * deleting something on the strength of its file extension.
 *
 * There is one button, and it opens a list. That is the entire step from
 * "show results" to "user selects".
 */
function DownloadsSummary({ scan }: { scan: DownloadsScan }) {
  const isScanning = useDownloadsStore((state) => state.isScanning);
  const runScan = useDownloadsStore((state) => state.runScan);
  const openReview = useDownloadsStore((state) => state.openReview);

  const isEmpty = scan.file_count === 0;

  return (
    <Card className="flex flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-medium tracking-widest text-muted-foreground">DOWNLOADS</p>
          <p className="max-w-md truncate text-xs text-muted-subtle" title={scan.folder}>
            {scan.folder}
          </p>
        </div>

        <Button
          size="sm"
          variant="ghost"
          disabled={isScanning}
          onClick={() => void runScan()}
          aria-label="Scan the folder again"
        >
          <RefreshCw className={isScanning ? "animate-spin" : undefined} />
          {isScanning ? "Scanning…" : "Rescan"}
        </Button>
      </header>

      {/* Stacked below `md` (section 84). The right-hand column is a list of
          "label ... size count" rows, and it is the first thing in Cleanup to
          stop being readable when the window is halved. */}
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="flex flex-col gap-6">
          <Stat label="Files" value={String(scan.file_count)} hint={formatBytes(scan.total_bytes)} />
          <Stat
            label="Largest"
            value={scan.largest === null ? "—" : formatBytes(scan.largest.size_bytes)}
            hint={scan.largest?.name}
          />
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium tracking-widest text-muted-foreground">CATEGORIES</p>

          <ul className="flex flex-col">
            {scan.categories.map((category) => (
              <li
                key={category.category}
                className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1.5 last:border-b-0"
              >
                <span className="text-sm">{category.label}</span>
                <span className="flex items-baseline gap-3">
                  <span className="text-xs text-muted-subtle">
                    {category.count === 0 ? "" : formatBytes(category.size_bytes)}
                  </span>
                  <span className="w-8 text-right text-sm tabular-nums">{category.count}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <footer className="flex flex-col gap-3 border-t border-border/60 pt-4">
        <Button className="w-fit" disabled={isEmpty} onClick={openReview}>
          <FolderOpen />
          Review Downloads
        </Button>

        <p className="text-xs text-muted-foreground">
          {isEmpty
            ? "Nothing to review — the top level of your Downloads folder is empty."
            : `Reviewing shows all ${formatFileCount(scan.file_count).toLowerCase()} so you can pick the ones to move or delete. Nothing is ever removed on its own.`}
        </p>

        <ScanNotes folderCount={scan.folder_count} unreadableCount={scan.unreadable_count} />
      </footer>
    </Card>
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
 * What the scan did *not* look at.
 *
 * Said out loud because the alternative is a count that quietly disagrees with
 * Explorer's, and a user who concludes the tool is wrong. Sub-folders are
 * stepped over on purpose: this utility never acts on a folder tree.
 */
function ScanNotes({
  folderCount,
  unreadableCount,
}: {
  folderCount: number;
  unreadableCount: number;
}) {
  const notes: string[] = [];

  if (folderCount > 0) {
    notes.push(
      `${folderCount} ${folderCount === 1 ? "folder was" : "folders were"} skipped — cleanup only ever touches files`,
    );
  }
  if (unreadableCount > 0) {
    notes.push(
      `${unreadableCount} ${unreadableCount === 1 ? "item" : "items"} could not be read and ${unreadableCount === 1 ? "is" : "are"} not listed`,
    );
  }

  if (notes.length === 0) return null;

  return <p className="text-xs text-muted-subtle">{notes.join(" · ")}.</p>;
}

export default DownloadsSummary;
