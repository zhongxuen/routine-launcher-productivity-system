import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Eye, HardDrive, Loader2, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";

import DriveCard from "@/components/cleanup/storage/DriveCard";
import ProfileFolderRow from "@/components/cleanup/storage/ProfileFolderRow";
import EmptyState from "@/components/common/states/EmptyState";
import ErrorState from "@/components/common/states/ErrorState";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { byLargestFirst, formatBytes, measuredBytes } from "@/lib/storage-utils";
import { useDuplicateStore } from "@/stores/duplicateStore";
import { useLargeFileStore } from "@/stores/largeFileStore";
import { useStorageStore } from "@/stores/storageStore";

/**
 * Cleanup > Storage — development-plan.md sections 38, 66 and 67.
 *
 * Section 38's sixth utility, and the one section 81 never scheduled: how
 * much room is left on each fixed drive, and which of the profile's folders
 * is holding it, largest first.
 *
 * # It reports, and it says that it reports
 *
 * The four tools beside this one are section 67's sequence — scan, show
 * results, user selects, confirm, perform action. This one stops at "show
 * results" and has nothing after it: no move, no delete, no confirmation
 * dialog, no selection to make. That is stated on screen rather than left to
 * be discovered, because a page under a heading called Cleanup that lists
 * folders by size *looks* like the prelude to deleting something, and the
 * user deserves to know it is not before they start reading numbers.
 *
 * Section 66's "restrict dangerous operations" is honoured here in the only
 * way this view can honour it: there is no operation on this page to
 * restrict. Nothing it can call — through its store, its service or its
 * commands — is capable of changing a file.
 *
 * # Where it would act, it points
 *
 * A folder holding 40 GB raises a question this app already answers twice
 * over, so each measured folder offers "Find large files here" and "Find
 * duplicates here". Both carry the folder into the tool that owns that
 * question, pre-filled, and both leave the acting — the selecting, the
 * confirming, the moving — to that tool and its own guards. That is what
 * makes a read-only page belong under Cleanup rather than beside Settings.
 *
 * # Measuring must never block, so it arrives folder by folder
 *
 * A profile tree takes tens of seconds to add up, most of it `AppData`. The
 * drives and the folder names are on screen immediately; each size is a
 * separate call and lands on its own, moving its row up the list as it does;
 * and Stop cancels the walk that is running rather than merely stopping the
 * ones that have not started. A folder Windows will not open is counted in
 * the row's own caption and skipped — normal on every machine, and never a
 * reason to fail the page.
 */
function CleanupStorage() {
  const navigate = useNavigate();

  const drives = useStorageStore((state) => state.drives);
  const profile = useStorageStore((state) => state.profile);
  const folders = useStorageStore((state) => state.folders);
  const isLoading = useStorageStore((state) => state.isLoading);
  const isSizing = useStorageStore((state) => state.isSizing);
  const sizingPath = useStorageStore((state) => state.sizingPath);
  const error = useStorageStore((state) => state.error);

  const load = useStorageStore((state) => state.load);
  const refresh = useStorageStore((state) => state.refresh);
  const stop = useStorageStore((state) => state.stop);

  // The pre-fill half of the two links. Setting the folder before navigating
  // rather than passing it through the route: both target views already keep
  // their scan folder in a store, and that store is what their scan button
  // reads — so this puts the folder exactly where a user who had picked it by
  // hand would have put it.
  const focusLargeFiles = useLargeFileStore((state) => state.focusFolder);
  const focusDuplicates = useDuplicateStore((state) => state.focusFolder);

  // Reading is all this page does, so it does it on arrival — the same as
  // Downloads and Screenshots, and unlike Large Files, which has to be told
  // which folder to walk. Repeat visits keep the report they built: the store
  // only reads when there is nothing to show.
  useEffect(() => {
    void load();
  }, [load]);

  const ordered = byLargestFirst(folders);
  const largest = ordered[0]?.size?.sizeBytes ?? 0;
  const measured = folders.filter((folder) => folder.size !== null).length;

  if (error !== null && profile === null) {
    return (
      <div className="flex flex-col gap-6 py-2">
        <Header />
        <ErrorState
          title="Could not read your drives."
          message={error}
          onRetry={() => void refresh()}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 py-2">
      <Header />

      <section className="flex flex-col gap-3">
        <h2 className="px-2 text-xs font-medium tracking-widest text-muted-foreground">DRIVES</h2>

        {isLoading && drives.length === 0 ? (
          <div role="status" aria-busy className="px-2">
            <span className="sr-only">Reading your drives</span>
            <Skeleton className="h-24 w-full" aria-hidden />
          </div>
        ) : drives.length === 0 ? (
          <EmptyState
            className="py-8"
            size="compact"
            icon={HardDrive}
            title="No fixed drives could be read."
            hint="Removable and network drives are left out on purpose — this page is about the disk your files live on."
          />
        ) : (
          <div className="flex flex-wrap gap-3 px-2">
            {drives.map((drive) => (
              <DriveCard key={drive.root} drive={drive} />
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="text-xs font-medium tracking-widest text-muted-foreground">
              YOUR FOLDERS
            </h2>
            <p className="min-w-0 truncate text-xs text-muted-foreground" title={profile ?? ""}>
              {profile ?? "—"}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {folders.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {measured} of {folders.length} measured · {formatBytes(measuredBytes(folders))}
              </p>
            )}
            {isSizing ? (
              <Button size="xs" variant="outline" onClick={() => void stop()}>
                Stop
              </Button>
            ) : (
              <Button size="xs" variant="ghost" onClick={() => void refresh()} disabled={isLoading}>
                <RefreshCw aria-hidden />
                {measured > 0 && measured < folders.length ? "Measure again" : "Refresh"}
              </Button>
            )}
          </div>
        </div>

        {isSizing && (
          <p
            className="flex items-center gap-2 px-2 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
            <span className="min-w-0 truncate">
              Measuring {shortName(sizingPath) ?? "your folders"}… sizes appear as each folder
              finishes.
            </span>
          </p>
        )}

        {isLoading && folders.length === 0 ? (
          <div role="status" aria-busy className="px-2">
            <span className="sr-only">Reading your folders</span>
            <Skeleton className="h-40 w-full" aria-hidden />
          </div>
        ) : folders.length === 0 ? (
          <EmptyState
            className="py-10"
            title="There are no folders in your user folder."
            hint="Nothing to measure, which is a fine answer."
          />
        ) : (
          <ul className="flex flex-col">
            {ordered.map((folder) => (
              <ProfileFolderRow
                key={folder.path}
                folder={folder}
                largestBytes={largest}
                isMeasuring={isSizing}
                onFindLargeFiles={() => {
                  focusLargeFiles(folder.path);
                  navigate("/cleanup/large-files");
                }}
                onFindDuplicates={() => {
                  focusDuplicates(folder.path);
                  navigate("/cleanup/duplicates");
                }}
              />
            ))}
          </ul>
        )}

        {error !== null && profile !== null && (
          // The report on screen is still true; the re-read is what failed.
          <p className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>The last refresh failed: {error} These figures are from before it.</span>
          </p>
        )}

        {folders.length > 0 && (
          <p className="flex items-start gap-2 px-2 text-xs text-muted-subtle">
            <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              Folders Windows keeps locked — parts of AppData on every machine — are counted as
              skipped rather than opened, so a size can be a floor rather than a total. Sizes
              include everything inside a folder; shortcuts and junctions are not followed, so
              nothing is counted twice.
            </span>
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * The heading, and the one sentence that matters most on this page.
 *
 * "Nothing here moves or deletes anything" is said before any number, not in
 * a footnote. Everything else under Cleanup ends in an action, so the
 * assumption a reader arrives with is the one worth correcting first.
 */
function Header() {
  return (
    <header className="flex flex-col gap-0.5 px-2">
      <p className="text-xs font-medium tracking-widest text-muted-foreground">STORAGE</p>
      <p className="text-sm text-muted-foreground">
        Where your disk has gone — by drive, then by folder, largest first.
      </p>
      <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-subtle">
        <Eye className="size-3.5 shrink-0" aria-hidden />
        This page only looks. Nothing here moves, deletes or changes a file.
      </p>
    </header>
  );
}

/** The folder name out of a path, for the "Measuring AppData…" line. */
function shortName(path: string | null): string | null {
  if (path === null) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

export default CleanupStorage;
