# AgentLink

让Agent可以跨设备去操控并且让鼠标键盘可以共享

AgentLink connects paired macOS and Windows computers on a local network so an AI agent can use a selected computer's files, shell, and applications through MCP. The agent connects to its local AgentLink runtime; each agent session chooses its own target computer.

**Status: 0.1.0-rc.5 preview.** This is an experimental release with unsigned Mac and Windows installer previews, not a production-ready public installer. The cross-platform peer core has been tested, including a live Windows-to-Mac command and file transfer. The one-app experience and three- or four-computer keyboard/mouse layout still need broader validation. See the [implementation record](docs/PEER-ARCHITECTURE-2026-10-02.md).

## What works today

- Paired-device identity and authenticated HTTPS, with a separate computer selection for each MCP client session.
- Files, shell commands, persistent tasks, and application launch on Mac or Windows nodes. Windows uses PowerShell; Mac uses zsh.
- The Windows app can initiate pairing with another computer or approve incoming pairing, and can set the Mac screen to its left, right, top, or bottom for the current Windows-hosted input sharing setup.
- Windows window and screen tools for visual checks. The Mac node does not yet advertise these capabilities.
- Experimental LAN keyboard/mouse sharing between a Mac and Windows, with bidirectional switching and multi-monitor support. [Current boundaries](docs/INPUT-SHARING.md).
- A Mac settings-window preview can explicitly start its receiving node, show pairing requests, approve them locally, and stop the listener. This code has not replaced the current installed app.

The selected computer's shell is separate from the agent's built-in local terminal. Commands run with the Node process's user permissions; AgentLink is not an adversarial sandbox. GUI operations require an interactive, signed-in desktop.

## Build and test

Requires Node.js 22+ and npm. Native Mac components require macOS and Swift command-line tools; Windows UI components require a Windows build environment.

```sh
npm ci --ignore-scripts
npm run build
npm run build:windows-node
npm run test:retained
python3 scripts/test-package-source.py
```

## Installer previews

`npm run release` builds a self-contained Mac disk image on macOS or a Windows x64 setup EXE on Windows. The build machine needs Node.js; people installing the resulting app do not. Download the latest unsigned build from [Installer preview workflow](https://github.com/dm56ytgfbn-source/AgentLink/actions/workflows/installer-preview.yml) while signed in to GitHub. These artifacts are development previews and are not yet suitable for a public stable release. See [installer instructions and release gates](docs/INSTALLERS.md).

Follow [setup instructions](docs/SETUP.md) to create private configuration and pair computers. No working tokens, private keys, or machine-specific pairing files belong in this repository. Use the [MCP configuration example](examples/mcp-config.example.json) for your local agent.

## Current limits

- The 3–4-device keyboard/mouse topology and complete Mac↔Mac / Windows↔Windows acceptance matrix are future work.
- Recovery after reboot, changing networks, and upgrades needs more clean-machine testing.
- GUI tools do not bypass a lock screen or UAC. File version checks are scoped to AgentLink operations, not every program on a computer.
- Packaged preview builds are unsigned development artifacts; platform distribution and end-user installation have not been fully validated.

Read [SECURITY.md](SECURITY.md) before exposing a node to other devices. AgentLink source is licensed under [MIT](LICENSE); third-party dependencies retain their own licenses.
