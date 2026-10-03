# 跨设备键鼠共享（实验预览）

键鼠物理连接在 Windows 时，推到配置的屏幕外边缘，就能直接操控 Mac 的系统光标与应用；从 Mac 的连接边缘推回，可返回 Windows。键盘跟随输入目标。Mac 自己的物理键鼠也能反向操控 Windows。无需远程桌面窗口。

**实现状态：** 两端原生程序、输入协议、TLS 会话、切换状态机、启动入口及自动测试已实现。2026-09-21 已验证 Windows 实体键鼠控制 Mac 并返回 Windows；Mac 实体键鼠控制 Windows 尚有按住状态异常，正在修复。不能把模拟测试当作已经完成实机验收，也没有宣称测得端到端延迟。

## 构建与启动

沿用现有 AgentLink 配对。需要 Node.js 22+、Windows 10 1703+（交互登录、普通桌面）和 macOS 12+。Mac 编译需要 Xcode 命令行工具；Windows 使用系统 .NET Framework 编译器。

在两端各自的项目目录执行 `npm run build`。不要用旧 release 目录代替含此功能的新源码。首次构建不覆盖已有产物；修改原生源码后请指定新输出路径重新构建，保留旧产物。

Windows PowerShell：

```powershell
node scripts/build-input-share.mjs 'build/AgentLinkInput.exe'
# 在当前 Node 私密配置中加入下方 input_share 配置，保留原配置备份，再重启 Node。
```

Windows Node 配置增加（helper 必须是完整路径）：

```json
{"input_share":{"enabled":true,"helper":"D:\\AgentLink\\build\\AgentLinkInput.exe"}}
```

只在配对 Mac 主动开启共享后才启动 Windows 输入钩子；启用配置本身不会拦截输入。可将 layout 对象放在 input_share 内定制屏幕边缘。

Mac Terminal：

```sh
node scripts/start-input-share-mac.mjs YOUR-WINDOWS-NAME
```

Mac 入口沿用 `~/Library/Application Support/AgentLink/config/runtime.local.json`，也可用 `AGENTLINK_CONFIG` 指定。只有一个配对设备时可以省略名称。它会构建 `build/AgentLink Input Preview.app` 并预检权限。

在 Mac「系统设置 → 隐私与安全性」中，允许本次构建的 AgentLink Input Preview.app 使用「辅助功能」和「输入监控」。启动器通过 LaunchServices 运行已授权的 .app，并通过私有目录中的命名管道传输输入，不把键码写成日志文件。没有权限时明确停止，不尝试绕过。当前辅助程序为本地临时签名；重新编译可能需要重新授权，正式分发仍需固定签名身份与公证。辅助程序需要可访问 WindowServer 的登录会话；受限沙箱中空的显示器列表也会阻止启动。

默认复用已配对 Windows Node 的 HTTPS 端口（通常 **7443**），通过 `/input-share` 的认证 HTTP Upgrade 建立 TLS 1.3 长连接。不会新开端口或修改防火墙、IP、DNS、网关和网络优先级。Node 默认关闭此能力，必须先显式设置 `input_share.enabled`。开发诊断保留独立 host 模式；仅显式使用 `connect --standalone --port 7444` 时才连接独立服务。

Mac 菜单栏显示「本机 / 接收 Windows / 控制 Windows」，提供停止按钮。任一端按 **Ctrl+Alt+Esc**（Mac 为 Control+Option+Esc）立即停止该会话；终端 Ctrl+C 也可停止。紧急停止/断线/锁屏/显示器变化后，需重新运行两端入口，不自动重新夺取输入。

## 布局、多显示器与按键

默认：Windows 最右侧显示器的右边缘连接 Mac 最左侧显示器的左边缘。多显示器在各自 OS 的桌面空间中移动；同一台电脑的显示器相接处不会触发跨设备切换。

查看原生显示器 ID 和坐标：

```sh
node dist/apps/input-share/main.js inspect --helper 'build/AgentLink Input Preview.app/Contents/MacOS/AgentLinkInput'
```

Windows 使用 `--helper build/AgentLinkInput.exe`。复制 `examples/input-share-layout.example.json`，填入两端真实显示器 ID，将布局对象放到 Windows Node 的 `input_share.layout` 中并重启 Node。每条链接自动双向；可以添加多条连接不同显示器的链接。支持 left/right/top/bottom，连接边必须相对，一个显示器的同一边不得重复配置。负坐标有效；边缘按比例映射，不把 Retina 点数当成 Windows 物理像素。默认速度系数 1，可在 0.1–5 之间调整。

只有没有按住键盘或鼠标按钮时才跨设备切换，避免拖拽、组合键被切断。切换后有 350 ms 的防反弹时间，可配置。跨设备拖动文件/窗口、剪贴板共享、触控手势、Fn/媒体键和 Caps Lock/Num Lock 状态同步不在本版验收范围内。普通键、左右修饰键、导航键、F1–F12、数字键盘、五键鼠标和滚轮按物理键位转发；目标端布局与输入法决定文字。Windows 键对应 Mac Command，Ctrl 保持 Control，不自动把 Ctrl+C 改写成 Command+C。Mac 本地输入发生时会退出当前远程控制，让本机用户接管。

## 安全与低延迟设计

- 常驻原生捕获/注入：Windows `WH_MOUSE_LL` / `WH_KEYBOARD_LL` / `SendInput`；Mac `CGEventTap` / `CGEvent`。不为每个事件启动 PowerShell。
- 持续 TLS 1.3 双向连接，校验证书和稳定 TLS 名称、配对身份、令牌、协议版本。未认证不得启动输入钩子。仅允许一组共享会话。
- `TCP_NODELAY`，只合并连续鼠标移动，最长约 4 ms 的合并窗口。按键、点击、滚轮是顺序边界，先刷新移动再发送，不丢按键抬起。
- 目标端先就绪确认，再拦截物理输入；每次切换提升 epoch，丢弃旧会话事件；700 ms 切换超时回到本地。
- 250 ms 心跳，1.5 秒失联阈值（再加一个检查周期）；原生辅助程序也独立检查控制器心跳，EOF、锁屏/安全桌面、显示器布局变化时恢复本机并释放自身注入的按键/按钮。背压和格式错误也停止会话，不积压陈旧输入。
- 不绕过 UAC、锁屏、macOS 安全输入或权限限制；高权限窗口无法注入时会停止。整机冻结、OS 崩溃或原生程序被强杀不属于可以承诺自动释放全部系统输入状态的情况。
- 复用 Node 的 kill-switch 文件；只接受 developer 模式，当前进程启动后修改配置需重启共享进程。令牌可授予操作当前用户桌面的能力，必须当作私密凭据保管。
- 不记录键码、输入文本或鼠标轨迹，只输出连接/焦点状态。TLS 通道不是公网远控或多用户协作服务。

诊断测试可显式指定 `--diagnostics --duration-seconds 300`，只输出每秒聚合计数（移动、左边缘、向外移动、按住状态、按键/按钮事件数量）及模式确认，不输出按键内容和逐事件坐标。诊断最长 600 秒，默认关闭；本机五分钟测试脚本启用此选项。

Mac 按住状态恢复依据 [Apple 的 HID 硬件状态表](https://developer.apple.com/documentation/coregraphics/cgeventsourcestateid)，避免把会话中的软件输入当作物理按住。对遗漏的释放事件重新核对，并向对端补发释放；真实按住时仍禁止跨屏。

实现参考：[Windows 低级鼠标钩子](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc)、[Apple Quartz Event Services](https://developer.apple.com/documentation/coregraphics/quartz-event-services)。实际可达延迟取决于局域网、调度、设备采样与目标应用；需要实际硬件测量后才能给出数值承诺。

## Computer Context 接口

`InputSharingEngine` 发出类型化的 `focus` 事件：

```json
{"version":1,"type":"input-focus","epoch":2,"source":"windows","target":"mac","reason":"edge","timestamp":0}
```

`source` 是物理输入来源，`target` 是输入目标；恢复本机时两者为 null。`hostSession` / `clientSession` 提供 `onFocus` 订阅，CLI 可使用 `--status-file` 将最新状态写到一个新建的私密文件。消费者读取时须允许短暂不完整内容并重试；事件订阅是首选。将 windows 映射为配对 device_id、mac 映射为 local 即可接入 Computer Context。**本版不会因用户移动鼠标而擅自修改正在运行的 Agent 任务的执行目标。** 后续可基于明确选择的 Agent 会话实现跟随、提示或固定工作设备策略。

## 验证与验收

```sh
npm run test:input-share
npm run test:retained
npm run build:windows-node
python3 scripts/test-package-source.py
```

自动测试覆盖目标确认、双向返回、物理 Mac 作为源、过期事件、超时释放、持键保护、接收端接管、负坐标、不同尺寸、内外边缘、多连接拓扑、合并顺序、密钥拒绝、帧限制、实际 TLS 传输、空闲心跳、断线和 kill-switch。所有夹具保留。

实机验收应在空白测试文档里进行：Windows → Mac → Windows；输入/删除测试文字和组合键；每一块显示器边缘；拖动但不跨屏；双端紧急停止；断网恢复；锁屏停止；显示器插拔停止；普通 125 Hz 与高采样鼠标；无权限启动。记录两端分辨率/缩放/布局、网络条件和实际体验。尚未完成这些项目时保持“实验预览”，不发布为已验收正式功能。
