# Desktop app

The desktop app is Electron (44.x). It bundles the backend and the standalone
frontend build and runs the backend as a separate Node process, so the user's
machine does not need Node.js. Its data lives in Electron's per-app data folder
(`userData`).

## Download

From the [latest release](https://github.com/MoshikoNayman/Mirabilis/releases/latest):

| Platform | Asset |
|---|---|
| macOS, Apple Silicon | `Mirabilis.AI-<version>-arm64.dmg` |
| Windows x64 | `Mirabilis.AI-<version>-x64.exe` (NSIS, choose install folder, desktop shortcut) |
| Linux x64 | `Mirabilis.AI-<version>-x86_64.AppImage` |

Check the download against the release's checksum file:

```bash
shasum -a 256 -c SHA256SUMS-macos.txt     # macOS
sha256sum -c SHA256SUMS-linux.txt         # Linux
Get-FileHash .\Mirabilis*-x64.exe -Algorithm SHA256   # Windows, PowerShell
```

The installers are not code-signed or notarized yet, so the OS may still warn
after the checksum matches.

### First launch on macOS

Gatekeeper may say the app is damaged or from an unidentified developer. Clear
it once, any of these ways:

- Terminal: `xattr -cr "/Applications/Mirabilis AI.app"`, then open the app.
- Ventura or Sonoma: right-click the app, Open, then Open again.
- Sequoia: open it once, then System Settings > Privacy & Security > Open Anyway.

## Build from source

Requires Node.js 18+ on the build machine. Staging happens in a temp directory
that is removed on exit; only `desktop/dist/` is written.

```bash
cd desktop
./build.sh            # unpacked app for the host platform (dir target)
./build.sh dmg        # macOS: dmg and zip, arm64
./build.sh appimage   # Linux x64; build on Linux
```

```bat
cd desktop
build.bat             # Windows NSIS installer
```

Output goes to `desktop/dist/`. The version comes from `desktop/package.json`.

Signing for Gatekeeper needs a `Developer ID Application` certificate in the
keychain and `xcrun notarytool` credentials. Without them the build works but
macOS treats the app as unsigned.

## Updates

- `autoDownload` is off. The app reports a new version and you choose Download,
  Skip This Version or Later. Skip records the version, so a later release still
  shows.
- No check runs while Go Dark is on, or before the window has reported the Go
  Dark state.
- Automatic checks run at most every six hours. A manual check (app menu on
  macOS, tray on Windows and Linux) ignores that limit and always reports a
  result.
- macOS cannot install an update until the app is signed: Squirrel.Mac rejects
  an unsigned bundle. An unsigned macOS build opens the releases page instead.
  Windows and Linux install updates themselves. `MIRABILIS_SIGNED=1` enables
  the macOS install path for a signed build.

Settings are in `update-settings.json` in the app data folder, mode `0600`:

| Setting | Default |
|---|---|
| `enabled` | on |
| `skippedVersion` | none |
| `lastCheckAt` | none |

## Release requirements

- `build.publish` in `desktop/package.json` points at this repository's GitHub
  releases, which makes electron-builder write the `latest*.yml` feed files.
  An installed app reads those to find updates, so the release workflow fails
  if they are missing.
- macOS releases need both the `.dmg` (manual install) and the `.zip` (the only
  format Squirrel.Mac updates from).
- electron-builder is pinned to 25.1.8. Version 26 does not copy `node_modules`
  out of `extraResources`, and the packaged backend fails on its first import.
  Both build scripts run `verify-release.js`, which fails when the packaged
  backend has no `node_modules`.
- `npm audit` does not cover the bundled Electron runtime. Keep Electron within
  the three most recent majors, which are the ones that get security fixes.
