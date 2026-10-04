# Installer preview

The source repository can now build a self-contained Mac application disk image and a Windows x64 setup program. These are **unsigned preview artifacts for testing**, not a public stable release. The GitHub Actions workflow `Installer preview (unsigned)` runs on packaging changes or manually, builds each installer on its own operating system, and retains the binaries as workflow artifacts; it does not publish a GitHub Release.

The installer workflow runs the full retained suite on Mac and the Windows packaging/input-sharing checks on Windows. The separate `Source validation` workflow runs on macOS, Windows, and Linux; it passed after the cross-platform fixture fixes. A passing CI matrix does not replace a clean-machine acceptance test.
The Windows job also installs the EXE into a new runner directory, checks the bundled app and Node runtime, installs the same version again, and confirms a private pairing-directory marker is unchanged.

## Build from a clean checkout

Both platforms require Node.js 22+ for the build machine only:

```sh
npm ci --ignore-scripts
npm run release
```

On Mac, the script builds `AgentLink.app`, verifies its bundled runtime and first-start API, then creates a DMG (or a ZIP if disk image creation is unavailable). The disk image contains the app, an Applications shortcut, and a short installation note. Users do not need Node or command scripts.

On Windows x64, install Inno Setup 6.3+ on the build machine or set `AGENTLINK_ISCC` to its `ISCC.exe`, then run the same release command. The setup EXE contains the Windows tray app, Node runtime, service code, input helper source, and production dependencies. It requests administrator approval once, installs to Program Files, configures inbound firewall rules scoped to its bundled Node runtime and the local subnet (TCP 7443 for the service; UDP 47823 for discovery), adds a Start Menu shortcut, and opens AgentLink as the original user. Pairing identities remain in that user's private configuration directory, outside the installation folder. Upgrades update the two named rules in place.

Each run uses a new `build/releases/AgentLink-<version>-*` directory and writes `RELEASE.json` with a SHA-256 digest. Existing release directories are never overwritten or cleaned. Only the installer file and metadata are intended for distribution; do not upload a build tree or private configuration.

## Try the preview

Open the latest successful [Installer preview workflow](https://github.com/dm56ytgfbn-source/AgentLink/actions/workflows/installer-preview.yml) while signed in to GitHub. Download the artifact for your platform under **Artifacts** and unzip that download. On Mac, open the DMG and drag `AgentLink.app` to Applications. On Windows x64, run `AgentLink-Setup-*.exe`; approve its one-time administrator prompt so it can prepare the LAN firewall rules. The GitHub artifact ZIP is just a download container, not another installer.

For Windows pairing, both computers must be awake, running the current AgentLink app, and on a network where they can reach each other. On one computer choose **允许别人连接**; on the other choose **添加电脑**. If discovery shows nothing, enter the first computer's current LAN IP. Discovery uses UDP 47823, while a direct IP connection uses TCP 7443. A company Wi-Fi with client isolation, different VLANs, or centrally managed firewall policy can still block these paths; contact the network administrator instead of opening the ports to the whole internet. The app's local-subnet rules do not bypass company policy or make devices on different networks reachable.

The GitHub `main` branch is the source of truth. To publish future source changes, work in a Git checkout of that repository, then run `git add`, `git commit`, and `git push origin main` after validation. The installer workflow builds fresh download artifacts from each pushed source revision. Do not upload desktop copies, `build/`, private `*.local.json`, certificates, or pairing files. Workflow artifacts are preview downloads with an expiry; a later public release should attach signed installers to a GitHub Release.

These binaries are unsigned. macOS Gatekeeper or Windows SmartScreen may warn or block them, so use them only for controlled tests. System Accessibility and Input Monitoring prompts for keyboard/mouse sharing still require a person to approve them. Do not remove the existing installation or pairing directory as part of preview testing.

## Before a public release

- Sign the complete Mac bundle with a stable Developer ID identity, enable hardened runtime, notarize the distributed DMG, and test the signed app's Accessibility and Input Monitoring permissions across upgrades.
- Sign the Windows application, installer, and uninstaller with a trusted publisher identity. The current unsigned EXE is suitable only for controlled preview testing.
- Install, upgrade, restart, pair, and use keyboard/mouse sharing on clean Mac and Windows machines. Confirm the original pairing identity survives an upgrade and that parallel old/new startup entries do not conflict.
- Validate Mac Apple Silicon and Intel separately. The current Windows payload is x64; other architectures need their own builds and tests.
- Review dependency audit findings and run the cross-platform acceptance matrix before publishing signed installers as GitHub Release assets.
