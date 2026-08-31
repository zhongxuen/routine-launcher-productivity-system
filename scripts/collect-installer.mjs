/**
 * Copies the installer `tauri build` just produced into `installers/`, so the
 * file to hand somebody is in the repository rather than eight folders deep
 * in `src-tauri/target/`.
 *
 *   node scripts/collect-installer.mjs        # copy, then prune older copies
 *   node scripts/collect-installer.mjs --keep # copy, leave older ones alone
 *
 * `npm run installer:build` runs `tauri build` and then this.
 *
 * Only the NSIS `-setup.exe` is copied, not the MSI. It is the one the release
 * notes tell people to download and the one the updater installs; carrying the
 * MSI as well would double what every future version adds to the repository
 * for a file nobody is pointed at. The MSI is still built, and still sits in
 * `src-tauri/target/release/bundle/msi/`.
 *
 * Older copies are deleted by default because the working tree only ever needs
 * the current one — but note that deleting a committed binary does not shrink
 * the repository. Git keeps every version that was ever committed, so each
 * release adds its ~4 MB to the clone size permanently. That is the price of
 * having the file here; at a handful of releases a year it is a rounding
 * error, and if it ever stops being one the answer is to stop committing them
 * and use the GitHub Release as the only copy (README, "Packaging and
 * release").
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installersDir = join(root, 'installers')
const bundleDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis')

// The version the build used, read from the file that decides it. Reading it
// here rather than taking whatever is newest in the bundle folder means a
// stale installer from an earlier version cannot be picked up silently — the
// folder keeps every build, and the newest *file* is not always the newest
// *version* once a rebuild of an older tag has happened.
const config = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const version = config.version
const fileName = `Routine Launcher_${version}_x64-setup.exe`
const source = join(bundleDir, fileName)

if (!existsSync(source)) {
  console.error(`No installer for ${version} at:\n  ${source}\n`)
  console.error('Run `npm run tauri build` first — or, if that already ran, check')
  console.error('that `npm run version:check` agrees with the version above.')
  process.exit(1)
}

mkdirSync(installersDir, { recursive: true })

const destination = join(installersDir, fileName)
copyFileSync(source, destination)

const mb = (statSync(destination).size / 1024 / 1024).toFixed(1)
console.log(`installers/${fileName}  (${mb} MB)`)

if (!process.argv.includes('--keep')) {
  for (const entry of readdirSync(installersDir)) {
    if (entry === fileName) continue
    if (!entry.endsWith('-setup.exe')) continue
    rmSync(join(installersDir, entry))
    console.log(`removed installers/${entry}`)
  }
}
