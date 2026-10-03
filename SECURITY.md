# Security and preview limits

AgentLink is a personal trusted-LAN preview. Authentication uses a random bearer token over HTTPS with certificate verification. Each registry entry also pins the expected device identifier. The Mac file bridge listens on loopback and has an independent Digest credential.

File APIs validate allowed roots, reject common symlink escapes, and protect export roots. These checks are not a complete defense against a hostile local process changing filesystem links concurrently. File versions use metadata, not a filesystem snapshot. Atomic rename support is subject to the underlying OS/filesystem and concurrent applications.

**Shell, persistent tasks and app launch run with the Node user's account permissions. A permitted working directory is not a sandbox.** Shell commands can access locations and networks beyond file-API roots. A promise to approve deletions is not enforced against arbitrary shell code in this preview. Do not describe it as such. Use an appropriately restricted user and capabilities.

Task journals contain commands, working directories and stdout/stderr. Keep the task directory private. Output and journal size limits are enforced, but task-count/disk quotas and managed retention are not complete. Interrupted tasks are retained rather than replayed. Partial uploads remain available after failures. Operators choose when retained records may be removed.

An emergency-stop marker disables requests and cancels tracked commands; it does not close independently launched GUI applications. Supervisors must not erase that marker or automatically rotate trust to resume operation.

Do not commit registries, tokens, private keys, certificates, audit logs, task journals, screenshots, local launch configs, machine-specific backups or installed binaries. Use the source exporter. Its scan is a release aid, not a guarantee against every possible secret format.

Until the owner publishes a disclosure contact, report security concerns privately to the repository owner. Do not attach live credentials or private logs to public issues.

## Optional input sharing

The opt-in input-sharing HTTP Upgrade uses the existing paired Node HTTPS port and certificate/token over TLS 1.3; no extra inbound port is needed. A standalone development listener on port 7444 remains available only when explicitly selected. It can control the signed-in desktop. Keep it on a trusted LAN and scope firewall access to the intended client. No helper starts before token authentication. The listener honors the Node kill-switch; mode/token/config changes require restarting it. Physical keystrokes are not logged. macOS Accessibility/Input Monitoring consent and Windows interactive desktop access are required, and secure desktops are not bypassed. See [input-sharing safeguards and acceptance limits](docs/INPUT-SHARING.md).
