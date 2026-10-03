# Installer preview

The source repository can now build a self-contained Mac application disk image and a Windows x64 setup program. These are **unsigned preview artifacts for testing**, not a public stable release. The GitHub Actions workflow `Installer preview (unsigned)` runs on packaging changes or manually, builds each installer on its own operating system, and retains the binaries as workflow artifacts; it does not publish a GitHub Release.

The installer workflow runs the full retained suite on Mac and the Windows packaging/input-sharing checks on Windows. The separate `Source validation` workflow continues to show outstanding cross-platform test failures; a successful preview build does not mean the full acceptance matrix is green.
The Windows job also installs the EXE into a new runner directory, checks the bundled app and Node runtime, installs the same version again, and confirms a private pairing-directory marker is unchanged.

## Build from a clean checkout

Both platforms require Node.js 22+ for the build machine only:

```sh
npm ci --ignore-scripts
npm run release
```

On Mac, the script builds `AgentLink.app`, verifies its bundled runtime and first-start API, then creates a DMG (or a ZIP if disk image creation is unavailable). The disk image contains the app, an Applications shortcut, and a short installation note. Users do not need Node or command scripts.

On Windows x64, install Inno Setup 6.3+ on the build machine or set `AGENTLINK_ISCC` to its `ISCC.exe`, then run the same release command. The setup EXE contains the Windows tray app, Node runtime, service code, input helper source, and production dependencies. It installs for the current user, adds a Start Menu shortcut, and opens AgentLink after installation. Pairing identities remain in the user's private configuration directory, outside the installation folder.

Each run uses a new `build/releases/AgentLink-<version>-*` directory and writes `RELEASE.json` with a SHA-256 digest. Existing release directories are never overwritten or cleaned. Only the installer file and metadata are intended for distribution; do not upload a build tree or private configuration.

## Before a public release

- Sign the complete Mac bundle with a stable Developer ID identity, enable hardened runtime, notarize the distributed DMG, and test the signed app's Accessibility and Input Monitoring permissions across upgrades.
- Sign the Windows application, installer, and uninstaller with a trusted publisher identity. The current unsigned EXE is suitable only for controlled preview testing.
- Install, upgrade, restart, pair, and use keyboard/mouse sharing on clean Mac and Windows machines. Confirm the original pairing identity survives an upgrade and that parallel old/new startup entries do not conflict.
- Validate Mac Apple Silicon and Intel separately. The current Windows payload is x64; other architectures need their own builds and tests.
- Review dependency audit findings and run the cross-platform acceptance matrix before publishing signed installers as GitHub Release assets.
