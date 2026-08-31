/**
 * Formatting and selection helpers for Desktop Cleanup
 * (development-plan.md sections 38, 66, 67, 81).
 *
 * Pure functions only — nothing here reads or writes a file, and nothing here
 * decides that an action should happen. The store owns the selection; this
 * module only turns what Rust sent into the words the panels print.
 */

import { formatAge, formatBytes } from "@/lib/downloads-utils";
import type {
  AgeBucketId,
  AgeCount,
  DesktopItem,
  DesktopKindId,
  KindCount,
} from "@/types/desktop";

/**
 * Bytes and age are said the same way here as in Downloads, so re-exported
 * rather than copied: "2.4 GB" and "3 days ago" mean the same thing in both
 * panels, and two implementations of that would eventually stop agreeing.
 */
export { formatAge, formatBytes };

/**
 * The two filters the review list offers, and the shape of "no filter".
 *
 * A filter narrows and only narrows. Neither one can ever add an item the
 * other has excluded, which is what makes "Select all shown" safe to offer.
 */
export interface DesktopFilter {
  kind: DesktopKindId | null;
  age: AgeBucketId | null;
}

export const NO_FILTER: DesktopFilter = { kind: null, age: null };

/**
 * "84 items", "1 item", "Nothing" — the summary's count line.
 *
 * "Items" rather than "files" throughout, because a third of what is on a
 * desktop is shortcuts and some of it is folders, and calling those files
 * would be the panel quietly misdescribing what it counted.
 */
export function formatItemCount(count: number): string {
  if (count === 0) return "Nothing";
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/** "3 items", "empty" — what a folder row says instead of a size. */
export function formatFolderContents(itemCount: number | null): string {
  if (itemCount === null) return "Could not be read";
  if (itemCount === 0) return "Empty";
  return `${itemCount} ${itemCount === 1 ? "item" : "items"}`;
}

/**
 * The label for a kind id, taken from the counts Rust sent rather than from a
 * second copy of the same seven words.
 *
 * Falls back to the id so a kind added on the Rust side shows up as something
 * rather than as blank.
 */
export function kindLabel(kinds: KindCount[], id: DesktopKindId): string {
  return kinds.find((entry) => entry.kind === id)?.label ?? id;
}

/** The same, for an age window. */
export function ageLabel(ages: AgeCount[], id: AgeBucketId): string {
  return ages.find((entry) => entry.age === id)?.label ?? id;
}

/**
 * The items a filter is currently showing, largest first.
 *
 * The scan already arrives sorted, so this only ever narrows — which is what
 * keeps the review list in the same order the summary's "Largest" line refers
 * to. A null on either axis means "all of them" on that axis.
 */
export function itemsMatching(items: DesktopItem[], filter: DesktopFilter): DesktopItem[] {
  return items.filter(
    (item) =>
      (filter.kind === null || item.kind === filter.kind) &&
      (filter.age === null || item.age === filter.age),
  );
}

/**
 * The items in a list that an action could actually be performed on.
 *
 * Folders and anything on the public desktop are not among them. Used by
 * "Select all shown" so it can never tick a row whose checkbox is not there,
 * and by the review's counts so "Select all (12)" means twelve things that
 * can really be moved.
 */
export function actionableItems(items: DesktopItem[]): DesktopItem[] {
  return items.filter((item) => item.actionable);
}

/** Total size of the given items, for the "4 selected · 1.2 GB" line. */
export function totalBytes(items: DesktopItem[]): number {
  return items.reduce((total, item) => total + item.size_bytes, 0);
}

/**
 * The folder a moved item ended up in, named rather than printed in full.
 *
 * Takes the item's *new* path and answers with the containing folder's name,
 * so "moved into Archive" reads as a place instead of as a second copy of the
 * filename the user just saw.
 */
export function parentFolderName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  // The last part is the item itself; the one before it is where it landed.
  return parts[parts.length - 2] ?? filePath;
}
