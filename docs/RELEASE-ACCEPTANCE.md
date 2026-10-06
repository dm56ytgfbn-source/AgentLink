> 历史验收记录：保留各日期原始结论，不代表当前产品状态。当前版本、公开下载和待验收事项以 [PROJECT-STATUS.md](PROJECT-STATUS.md) 为准。下文 rc.1 的“未实现发现 / 未运行 CI”仅适用于当时。

# 0.1.0-rc.1 acceptance record

Updated 2026-09-15 after live cutover. This is a personal LAN release candidate, not a stable production release.

## Current verified state

- New server certificate and stable TLS identity are active on both computers. Native macOS TLS policy accepts the certificate. Original configurations, certificate/key files and startup shortcut are retained.
- Windows binds all IPv4 interfaces instead of an obsolete DHCP address. The existing current-user Startup shortcut now launches the new supervisor and configuration. No firewall or DHCP setting was changed.
- Mac registry, installed runtime and LaunchAgent are active. The source registry points to the installed registry so the plugin/CLI and native viewer share the same pairing.
- A fresh MCP client through the actual plugin entry reports the paired Windows device ready.
- A real durable Windows task completed while clients disconnected; resubmitting the same key returned the same task. Both output phases remained readable.
- The verified Windows Node process was stopped once. Its supervisor started a new process, authenticated access returned, and the completed task remained readable. This verifies service recovery, not an operating-system reboot. Polling started after recovery, so no recovery-latency claim is made for this run.
- Mac mount reached ready only after actual I/O. A new file written through the mount matched content read through Windows RPC. The same mounted file remained readable after service recovery.
- Fixed false metadata for missing/inaccessible WebDAV files. Missing-file PROPFIND now returns 404. Real macOS mounted O_EXCL creation succeeds; a second exclusive write fails with EEXIST and preserves the original content. Verified on an isolated mount and the primary mount.
- Native viewer displays the selected Windows Notepad window. Text was sent through the viewer, then the remote File/Save menu was clicked through the rendered window. Windows file readback contained the exact entered text.
- Initial native connection logs reported local-network prohibition. The System Settings permission was already on when inspected; a later refresh connected. No permission toggle was changed by the agent. Signing/permission behavior across installs still needs broader testing.

## Automated validation

- Mac: 15 retained-fixture runtime tests passed, including HTTPS, tasks, WebDAV, stable TLS route changes and registry preservation. Main and Windows-targeted TypeScript builds passed.
- Windows: independent installation of 109 locked dependencies, then 15 retained tests: 14 passed and one platform-specific symlink case skipped. After the final WebDAV correction, its affected Windows test was redeployed and passed again.
- Native Swift client: five response checks plus legacy-certificate rejection with an actionable TLS explanation passed; app compilation and ad-hoc signature verification passed.
- Five source-publication checks passed: allowlist/hash/archive, credential detection, private-key detection, preserving existing output and rejecting source symlinks.
- Hosted GitHub CI has not run. Historical cleanup/delete tests were not rerun under the user's deletion restriction.

## Remaining release gates

- Full Windows logout/reboot and Mac sleep/wake, including busy mounts and locked desktops. User applications with existing unsaved documents were left open.
- Automatic address discovery is not implemented. After learning a new address, `computer reconnect` verifies TLS and device identity before saving the route with a backup. Reopen the native viewer after a route change; the running bridge/supervisor reload the registry.
- Signed/notarized distribution, clean-machine installation, a complete upgrade/rollback UI, storage quotas/retention and enforcement beyond the current user's shell rights.
- Multi-application input/keyboard shortcuts, concurrent local editors and repeated interruption testing. This is not a global Windows filesystem lock.

## Owner review

Use the desktop native-viewer launcher to inspect the existing Notepad acceptance file. Try selecting an application and check responsiveness. Review normal file operations through the Mac mount. Arrange a full reboot test when any unrelated unsaved work has been saved.

No final release archive or GitHub upload has been made. A clean source review directory can be exported separately; final packaging follows owner acceptance.


## 2026-09-19 跨设备键鼠共享增量

- macOS 完整 retained 回归：33 项通过；Windows 输入共享测试：18 项通过。
- Windows 真实输入辅助程序：控制器 EOF 与心跳超时恢复检查通过，均在本机直通模式完成。
- 两端原生辅助程序已经编译；Mac 最新测试程序的输入监控与辅助功能开关已在系统设置中确认开启。
- 新输入通道已部署至实际 Windows Node，复用现有 HTTPS 端口；局域网 HTTP Upgrade、配对证书验证、TLS 1.3 以及更新后 /info 健康检查通过。
- 旧服务文件及私密配置已备份；重启前确认未完成后台任务为 0。未修改防火墙或网络地址。
- Mac 启动改用 LaunchServices 和私有命名管道，避免要求整个终端拥有键鼠权限。开发执行环境无法直接完成该应用的启动验证；Computer Use 也拒绝操作终端，因此已准备并在访达中选中 5 分钟测试脚本，等待用户启动。
- 物理 Windows 键鼠跨到 Mac、往返切换、实际文本输入与端到端延迟仍待实机验收；不得据此标记为完整验收或正式发布。

## 2026-09-21 实机反馈与反向输入诊断

- 用户启动五分钟测试后，两端原生辅助程序已实际连接。22:07 至 22:10 的焦点日志记录多次 source=windows 的 Windows → Mac → Windows 往返；用户确认 Windows 键盘能在 Mac 输入。
- 用户随后反馈 Mac 自己的鼠标/触控板向左也无法进入 Windows。日志记录 Mac 本机活动导致 receiver-activity，但没有 source=mac 的成功切换。因此仅 Windows 键鼠作为来源的路径得到实机确认，不能宣称双向物理来源已验收。
- 五分钟测试脚本增加有时间上限的诊断：每秒聚合移动、左边缘、向外移动、按住状态和 ACK 信息，不记录按键编码、文本内容或逐事件坐标。普通启动默认不启用诊断。
- 自动化覆盖补充为实际 TLS 通道中更换物理来源（模拟辅助程序），验证 Windows 来源返回后，Mac 来源可进入 Windows、发送按键并返回 Mac。该测试不能替代原生硬件验收。
- 22:14 新一轮诊断确认：所有到达左边缘的移动均标为 held，包含向外移动；模式 local、ACK 正常。故障已缩小至 Mac 原生按住状态，而非边缘方向或网络。
- Mac 源码改为读取 HID 硬件状态，并在移动和切换前核对遗漏的释放；修饰键不再靠翻转缓存推断状态。修复产物 `build/AgentLink Input Recovery 20260921b.app` 已编译、签名校验、无输入捕获的按住状态回归检查通过。五分钟测试入口已指向修复版，常规入口仍保留旧 Preview。
- 修复快速退出的权限预检与 `open -W` 的 kevent 等待竞态：预检改为等待私有结果文件完整写入，并有大小与超时限制。输入共享 20 项自动测试通过（含更换物理来源的 TLS 用例及预检部分写入/超时用例）。
- 修复版在正常用户会话启动后报告权限不足；经用户明确授权并亲自完成系统验证，已在系统设置添加该构建，辅助功能和输入监控均确认开启。新原生辅助程序仍须完成实际 Mac → Windows 验收；不能把编译成功当成实机修复成功。未修改防火墙或地址，未做最终发布。
