# Installers

The current Windows installer, kept here so it can be downloaded straight from
this repository rather than built first.

**To install:** download the `.exe`, double-click it, and click *More info* →
*Run anyway* if Windows shows "Windows protected your PC". The installer is not
signed with a Windows code-signing certificate, so SmartScreen has nothing to
check it against — see the "Packaging and release" section of the top-level
README.

It installs for the current user only, needs no administrator rights, and
pulls in the WebView2 runtime silently if the machine does not already have it
(Windows 11 always does).

## What is here

One file: `Routine Launcher_<version>_x64-setup.exe`, 64-bit Windows only.

Two things refresh it, and neither has to be remembered at the moment it
matters:

- **Publishing a release** — `.github/workflows/sync-installer.yml` downloads
  that release's `.exe` and commits it here, so this file is never a version
  behind what people are being offered. `git pull` after publishing.
- **`npm run installer:build`** — for a local build that is not being
  released. (`npm run installer:collect` alone copies a build that already
  ran.)

Both replace the previous version's copy rather than adding to it. The MSI is
not kept here; it is still built, in `src-tauri/target/release/bundle/msi/`.

## This is not the release

The GitHub Release for a tag is what the in-app updater reads, and it carries
the signed `latest.json` that this folder does not. Installing from here works,
and updates from here do not exist — a copy installed from this folder still
updates itself, because it checks the same endpoint every other copy does, but
nothing about *this file* is what makes that work. Publishing a release is
still `git tag v<version> && git push origin v<version>`.
