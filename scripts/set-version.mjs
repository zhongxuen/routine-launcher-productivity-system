/**
 * Reads or sets the app version across every file that carries it
 * (development-plan.md section 85).
 *
 *   node scripts/set-version.mjs            # print each file's version, exit
 *                                           # non-zero if they disagree
 *   node scripts/set-version.mjs 0.2.0      # write 0.2.0 everywhere
 *
 * Four files, and they matter for different reasons, which is why none of
 * them can simply be dropped:
 *
 *   package.json            what `npm version`-shaped tooling reads
 *   package-lock.json       npm rewrites this from package.json anyway; kept
 *                           in step here so `npm ci` after a bump is a no-op
 *   src-tauri/Cargo.toml    the Rust crate's version
 *   src-tauri/Cargo.lock    cargo rewrites this too; same reasoning
 *   src-tauri/tauri.conf.json   THE one that ends up in the installer, in
 *                           Apps & features, and in `get_app_version`
 *
 * Tauri can read the version out of `package.json` instead — `"version":
 * "../package.json"` — but it resolves that path against the *working
 * directory* rather than against the config file, so whether it works depends
 * on where the build was launched from. An explicit number and a script that
 * writes it is the version of this that cannot be run from the wrong folder.
 *
 * ## The scheme
 *
 * Semver, `major.minor.patch`, no pre-release or build metadata: MSI's
 * `major.minor.patch` version field has nowhere to put them, so a version
 * this app cannot ship is a version it will not accept.
 *
 * - **patch** — fixes and polish; no new database migration.
 * - **minor** — new features, new migrations. The upgrade path is
 *   install-over-the-top and `db::init_db` runs whatever migrations are new.
 * - **major** — reserved for a release that cannot read an older database.
 *
 * Below 1.0.0 the app is pre-release and minor is the working bump.
 *
 * Two rules the installers impose, and the reason `allowDowngrades` is off:
 * the version must only ever go *up*, and it must never be reused for two
 * different builds. Windows compares versions to decide what an upgrade is,
 * so a rebuilt 0.2.0 will happily refuse to replace the 0.2.0 already there.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `major.minor.patch`, and nothing else — see the note on MSI above. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Every place the version lives, each with the way it is found in that file.
 *
 * The two lockfiles are matched narrowly on purpose. A lockfile is thousands
 * of version strings belonging to other people's packages, and a pattern that
 * was even slightly loose would rewrite one of those instead.
 */
const FILES = [
  {
    path: "package.json",
    // The first "version" of the root manifest.
    pattern: /^(\s*"version":\s*")([^"]+)(")/m,
  },
  {
    path: "package-lock.json",
    // Both the top-level "version" and the one on the "" (root) package
    // entry. `npm` writes the same number to both.
    pattern: /^(\s*"version":\s*")([^"]+)(")/gm,
    limit: 2,
  },
  {
    path: "src-tauri/tauri.conf.json",
    pattern: /^(\s*"version":\s*")([^"]+)(")/m,
  },
  {
    path: "src-tauri/Cargo.toml",
    // Anchored to the `name = "routine-launcher"` above it, so a dependency's
    // version can never be the thing that matches. `\r?\n` throughout: these
    // files are checked out with CRLF on Windows and LF elsewhere, and a
    // pattern that knew only one of the two would fail on the other machine.
    pattern: /(name = "routine-launcher"\r?\n(?:[^\r\n]*\r?\n)*?version = ")([^"]+)(")/,
  },
  {
    path: "src-tauri/Cargo.lock",
    // Same anchoring, in the lockfile's `[[package]]` block for this crate.
    pattern: /(name = "routine-launcher"\r?\nversion = ")([^"]+)(")/,
  },
];

function read(file) {
  const text = readFileSync(join(root, file.path), "utf8");
  const found = [...text.matchAll(new RegExp(file.pattern.source, file.pattern.flags.includes("g") ? file.pattern.flags : `${file.pattern.flags}g`))]
    .slice(0, file.limit ?? 1)
    .map((match) => match[2]);

  if (found.length < (file.limit ?? 1)) {
    throw new Error(`${file.path}: could not find the version field`);
  }

  return { text, found };
}

function write(file, version) {
  const { text } = read(file);
  let remaining = file.limit ?? 1;

  const next = text.replace(
    new RegExp(file.pattern.source, file.pattern.flags),
    (match, before, _current, after) => (remaining-- > 0 ? `${before}${version}${after}` : match),
  );

  if (next !== text) writeFileSync(join(root, file.path), next);
  return next !== text;
}

const target = process.argv[2];

if (target !== undefined && !SEMVER.test(target)) {
  console.error(
    `"${target}" is not a version this app can ship.\n` +
      "Use major.minor.patch — MSI has nowhere to put a pre-release suffix.",
  );
  process.exit(1);
}

if (target === undefined) {
  // Report mode. Used by `npm run version:check`, and by anyone about to cut
  // a release who wants to know what they are cutting.
  let mismatched = false;
  const versions = new Set();

  for (const file of FILES) {
    const { found } = read(file);
    for (const version of found) versions.add(version);
    console.log(`${file.path.padEnd(26)} ${found.join(", ")}`);
  }

  if (versions.size > 1) {
    console.error(`\nThese disagree. Run \`npm run version:set -- <version>\` to settle them.`);
    mismatched = true;
  }

  process.exit(mismatched ? 1 : 0);
}

for (const file of FILES) {
  const changed = write(file, target);
  console.log(`${changed ? "updated" : "already"}  ${file.path}`);
}

console.log(
  `\nNow at ${target}. The installer takes its number from tauri.conf.json;\n` +
    "commit all five files together so a build can never be ambiguous.",
);
