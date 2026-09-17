/**
 * Searching the installed-programs catalogue, for the routine builder's
 * application picker.
 *
 * The same question the backend answers at launch time
 * (`src-tauri/src/services/installed_apps.rs`), asked here for a different
 * reason: there it decides what a saved name *will* open, here it shows the
 * user what they are choosing while they are still choosing it. The two rank
 * matches the same way on purpose — a picker that suggested one program and a
 * launch that started another would be worse than no picker at all.
 */

import type { InstalledApp } from "@/types/installed-app";

import aliasGroups from "./app-aliases.json";

/**
 * Lowercases and drops everything that is not a letter or a digit, so
 * `Visual Studio Code`, `visualstudiocode` and `Visual-Studio-Code` are one
 * string. Spaces and punctuation are the part of a program's name people
 * remember least reliably.
 */
export function normaliseAppName(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/** The prefix that marks a Store app, addressed by ID rather than by path. */
export const APPS_FOLDER_PREFIX = "shell:AppsFolder\\";

/** `C:\Program Files\Google\Chrome\Application\chrome.exe` becomes `chrome`. */
function fileStem(target: string): string {
  const file = target.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return file.replace(/\.(exe|com|bat|cmd|lnk)$/i, "");
}

/**
 * Whether a target has to be handed to Windows to open rather than run
 * directly — a Store app or a shortcut.
 *
 * These are the targets that cannot carry arguments, which the builder needs
 * to know before a launch proves it: an arguments field that is accepted now
 * and refused at launch is a trap.
 */
export function opensViaShell(target: string): boolean {
  const trimmed = target.trim();
  return trimmed.startsWith(APPS_FOLDER_PREFIX) || /\.(lnk|url)$/i.test(trimmed);
}

/**
 * The catalogue entry a stored target *is*, or null.
 *
 * Matched on the target rather than the name, because that is what the action
 * stores: this is what lets a row saved as a path show "Google Chrome" over
 * it instead of leaving the user to read the path and work it out.
 */
export function installedAppFor(apps: InstalledApp[], target: string): InstalledApp | null {
  const wanted = target.trim().toLowerCase();
  if (!wanted) return null;
  return apps.find((app) => app.target.toLowerCase() === wanted) ?? null;
}

/**
 * Groups of names that all mean one program — `vscode`, `code` and
 * `Visual Studio Code`; `files` and `File Explorer`. Shared with the backend
 * (`installed_apps.rs` includes the same file) so the picker and the launch
 * agree on what a nickname means.
 */
const ALIAS_GROUPS: string[][] = aliasGroups.map((group) => group.map(normaliseAppName));

/**
 * The group `wanted` is one of the names in, and every name in groups it is
 * the start of (`vsc` is on its way to `vscode`).
 */
function appAliasesFor(wanted: string): { exact: string[] | null; partial: Set<string> } {
  let exact: string[] | null = null;
  const partial = new Set<string>();

  for (const group of ALIAS_GROUPS) {
    if (group.includes(wanted)) exact = group;
    else if (group.some((alias) => alias.startsWith(wanted))) group.forEach((alias) => partial.add(alias));
  }

  return { exact, partial };
}

/**
 * The programs matching what the user has typed, best first.
 *
 * The tiers are the point, not the ordering inside them: a program *called*
 * what was typed is a different claim from one that merely starts with those
 * letters, so `chrome` offers "Google Chrome" before "Chrome Remote Desktop"
 * however the list happened to be sorted. Within a tier the shortest name
 * wins — the least-qualified name is the one a bare word usually means.
 *
 * A known nickname comes first of all: `files` means File Explorer even on a
 * machine that also has an app called "Files", and inside a group the earlier
 * name wins.
 *
 * An empty query lists everything, which is how the dropdown answers "show me
 * what I have" for a user who does not know what to type.
 */
export function matchInstalledApps(
  apps: InstalledApp[],
  query: string,
  limit = 50,
): InstalledApp[] {
  const wanted = normaliseAppName(query.replace(/\.(exe|com|bat|cmd|lnk)$/i, ""));

  if (!wanted) return apps.slice(0, limit);

  const aliases = appAliasesFor(wanted);
  const ranked: { tier: number; rank: number; app: InstalledApp }[] = [];

  for (const app of apps) {
    const name = normaliseAppName(app.name);
    const stem = normaliseAppName(fileStem(app.target));
    const aliasRank =
      aliases.exact?.findIndex((alias) => alias === name || alias === stem) ?? -1;

    const tier =
      aliasRank >= 0
        ? 0
        : name === wanted || stem === wanted
          ? 1
          : name.startsWith(wanted) ||
              stem.startsWith(wanted) ||
              aliases.partial.has(name) ||
              aliases.partial.has(stem)
            ? 2
            : name.includes(wanted)
              ? 3
              : -1;

    if (tier >= 0) ranked.push({ tier, rank: Math.max(aliasRank, 0), app });
  }

  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.rank - b.rank ||
      a.app.name.length - b.app.name.length ||
      a.app.name.localeCompare(b.app.name),
  );

  return ranked.slice(0, limit).map((entry) => entry.app);
}

/**
 * What a typed name will actually open, or null when nothing answers to it.
 *
 * The same lookup the launch does, run while the user is still editing — so
 * "Chrome" can be shown resolving to Google Chrome before the routine is
 * saved rather than failing when it is run. A target that is already a path
 * is not a name and gets no guess.
 */
export function resolvedAppFor(apps: InstalledApp[], target: string): InstalledApp | null {
  const trimmed = target.trim();
  if (!trimmed || /[\\/]/.test(trimmed)) return null;

  const [best] = matchInstalledApps(apps, trimmed, 1);
  return best ?? null;
}
