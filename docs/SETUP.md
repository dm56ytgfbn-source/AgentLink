# Advanced manual deployment (developer / administrator)

> 普通用户请先阅读[新用户指南](QUICKSTART.zh-CN.md)。下文是高级手动部署，不是安装包使用步骤；安装包会处理自带运行时与初始配置。

## Windows Node

1. Build the source using Node.js 22+ and `npm ci --ignore-scripts`, then `npm run build`.
2. Create a dedicated shared folder and a separate private configuration folder, outside the shared roots when possible.
3. From the private folder, run:

```powershell
node C:\path\to\agentlink\dist\apps\node\main.js init node.local.json D:\AgentLinkShare
```

`init` creates a random token and device identifier and refuses to overwrite an existing config. Do not paste the resulting token into chat or commit the file.

4. Create a TLS server certificate and key. For a stable LAN IP, an OpenSSL example is below. Replace `192.0.2.10` (a documentation address) with the actual address before use:

```sh
openssl req -x509 -newkey rsa:3072 -nodes -keyout key.pem -out cert.pem -days 365 -subj /CN=AgentLink -addext subjectAltName=IP:192.0.2.10 -addext extendedKeyUsage=serverAuth -addext keyUsage=digitalSignature,keyEncipherment -addext basicConstraints=critical,CA:FALSE
```

5. Configure absolute `cert`, `key`, `audit` and `kill_switch` paths. For a computer whose LAN address changes, set `host` to `0.0.0.0` so a DHCP change does not leave the service trying to bind a missing address. This listens on all IPv4 interfaces; restrict the firewall rule to the intended trusted LAN/peer scope. Set `mode` to `developer` and enable only needed capabilities. For this preview, the full list is `filesystem`, `shell`, `apps`, `screen`, `window`, `tasks`.

The native Mac viewer validates the server certificate using macOS TLS policy. Include the `serverAuth` extended key usage above, as well as a matching SAN. A legacy certificate can work with the Node client yet fail this native check. For an existing pair, preserve the original certificate/key/config and deliberately rotate both the Windows server certificate and the Mac's verified pin; do not disable validation or silently overwrite a working pair.
6. For durable tasks, configure an absolute `tasks_dir` in the private folder. Restrict that folder using NTFS ACLs to the intended user. Enabling `tasks` is equivalent to enabling shell execution rights.
7. Allow the chosen TCP port (default 7443) in the Windows firewall only for the intended trusted LAN/peer scope. AgentLink does not automatically weaken the firewall or disable certificate validation.
8. Start the node:

```powershell
node C:\path\to\agentlink\dist\apps\node\main.js serve C:\private\node.local.json
```

## Mac pairing

Copy only the **public certificate** to the Mac through a trusted channel and verify its fingerprint. Keep the server private key on Windows.

Create a private registry outside Git:

```json
{
  "devices": [{
    "name": "YOUR-WINDOWS-NAME",
    "device_id": "THE-ID-FROM-WINDOWS-CONFIG",
    "url": "https://192.0.2.10:7443",
    "token": "THE-PRIVATE-TOKEN-FROM-WINDOWS-CONFIG",
    "ca": "/absolute/path/to/public-cert.pem"
  }]
}
```

Use `chmod 600` on the registry. Set `AGENTLINK_CONFIG` to its absolute path, then run `node dist/apps/runtime/cli.js doctor YOUR-WINDOWS-NAME`.

Keep the Mac on DHCP. If the Windows address changes, verify the new endpoint and ensure its certificate matches it. Do not disable TLS checking to work around an IP change.

### Stable identity with a changing address

For new pairings that need address changes, include a unique DNS identity such as `agentlink-<device-id>.local` in the certificate SAN, alongside `localhost` and `127.0.0.1` for the local supervisor. Use the same DNS identity as the optional `tls_server_name` in the Mac registry. This is the certificate identity, not an automatic DNS registration. The registry `url` supplies the current network address.

After learning the new address, run:

```sh
node dist/apps/runtime/cli.js computer reconnect YOUR-WINDOWS-NAME https://192.0.2.20:7443
```

The command verifies the configured TLS identity and device ID before saving a new route. It preserves credentials/certificate settings and writes a private backup. The running file bridge and Mac supervisor read route updates; reopen the native viewer after changing its route. LAN discovery is implemented, but automatic recovery is not guaranteed on every network. Legacy pairings without a stable certificate name may first require certificate rotation.

## Login supervision

Windows, from the intended user session:

```powershell
.\scripts\windows-install-startup.ps1 -NodeExe 'C:\Program Files\nodejs\node.exe' -Project 'C:\path\to\agentlink' -Config 'C:\private\node.local.json'
```

This tries an interactive-user scheduled task. If task registration is denied, it creates a user Startup shortcut instead. It does not prompt for administrator elevation. A matching existing installation is reused; a conflicting one is preserved and reported. The supervisor checks a healthy existing Node before starting one, limits repeated launches, and latches the emergency-stop state. It does not unlock Windows or terminate user applications.

To stop future recovery without deleting anything, create a file named `<absolute config filename>.supervisor-stop`. The supervisor stays halted; removing the marker alone does not resume the current supervisor process. The Node's separate `kill_switch` immediately disables access and cancels its tracked commands. Restoring access requires an explicit operator action and credential review.

## Mac file bridge

Create a bridge configuration outside Git. The password must be an independent random secret of at least 32 characters, not the Windows token:

```json
{
  "name": "YOUR-WINDOWS-NAME",
  "port": 7480,
  "roots": { "Share": "D:\\AgentLinkShare" },
  "password": "REPLACE-WITH-INDEPENDENT-RANDOM-SECRET",
  "probe_relative_path": "Share/connection-check.txt"
}
```

Create a small harmless `connection-check.txt` in the shared root beforehand. The supervisor reads it to verify actual mounted I/O. It never silently creates/deletes user files to repair a mount. `ready` is false if only the mount entry exists but I/O has not passed.

```sh
node scripts/install-macos.mjs /absolute/private/runtime.local.json /absolute/private/bridge.local.json
```

This copies the built runtime/dependencies to `~/Library/Application Support/AgentLink`, compiles the NetFS helper, and registers a user LaunchAgent. It refuses to overwrite an existing installation. The mount defaults to `~/AgentLink/<device-name>`. A stale mount can receive an ordinary unmount/remount attempt; busy mounts are not force-unmounted. The state file explains the result.

The installer is first-install tooling, not a complete upgrade manager. Existing RC installations require deliberate versioned migration and rollback review.

## Native application viewer

```sh
node scripts/build-native.mjs '/new/output/path/AgentLink Windows.app'
```

The output path must be new. The viewer uses `AGENTLINK_CONFIG` if set; otherwise it checks the installed Application Support registry, then the legacy adjacent `agentlink/runtime.local.json` layout. macOS may require local-network permission for the application. Ad-hoc signing is for local testing; notarized distribution is not included.

With one paired device, the viewer selects it automatically. With multiple devices, launch its executable with `AGENTLINK_COMPUTER` set to the exact paired name. It refuses an ambiguous target instead of silently choosing another computer.

## Source export

```sh
python3 scripts/package-source.py /new/output/path/AgentLink-source
```

The exporter uses an explicit source allowlist, excludes private records and Git history, scans for private keys and known local credentials, and writes a file hash manifest. By default it prepares a source directory for review. After owner acceptance, use a new output path and add `--archive` to also create a ZIP. Use the exported directory for a new GitHub repository; do not upload a raw copy of the existing working directory. Automated checks do not replace reviewing files before publication.
