# AgentLink

让 AI Agent 使用你的另一台电脑，也让两台电脑共享键盘与鼠标。

## 下载安装

**当前公开下载：0.1.0-rc.5 预览版。** 未签名、未公证，适合愿意反馈问题的测试用户。普通用户不需要下载源码、安装 Node.js 或运行命令。

| 你的电脑 | 安装包 |
| --- | --- |
| Windows 10/11，x64 | [下载 Windows 安装程序 (.exe)](https://github.com/dm56ytgfbn-source/AgentLink/releases/download/v0.1.0-rc.5/AgentLink-Setup-0.1.0-rc.5-windows-x64.exe) |
| Mac，Apple Silicon / M 系列 | [下载 Mac 安装程序 (.dmg)](https://github.com/dm56ytgfbn-source/AgentLink/releases/download/v0.1.0-rc.5/AgentLink-0.1.0-rc.5-mac-arm64.dmg) |

[版本说明与所有下载](https://github.com/dm56ytgfbn-source/AgentLink/releases) · [新用户指南](docs/QUICKSTART.zh-CN.md) · [支持范围与进度](docs/PROJECT-STATUS.md)

下载无需登录 GitHub。**Code → Download ZIP** 和 **Source code** 下载的是开发源码；请使用上面的安装包链接。Intel Mac 暂无安装包。

## 三步开始

1. **两台都安装并打开。** Windows 运行 EXE；Mac 打开 DMG，把 AgentLink 拖入“应用程序”。两台电脑应在允许互访的局域网，保持开机并登录。
2. **添加另一台电脑。** 接收端开放连接，发起端选择“添加电脑”（Mac 的“连接新电脑”），在接收端确认配对。找不到时可以输入对方局域网 IP；详细排查见[指南](docs/QUICKSTART.zh-CN.md#找不到或连不上)。
3. **选择用途。** 按应用内 Agent 接入引导配置支持 MCP 的 Agent；或启用实验性键鼠共享，按提示授权并设置屏幕位置。配对完成不等于 Agent 客户端已接入。

## 能做什么

- Agent 通过通用 MCP 接口访问所选电脑的文件、终端和应用；每个会话独立选择目标，不限于某一家 Agent。
- 配对身份与加密连接、任务记录、经身份验证的地址更新。
- Windows 窗口捕获与输入，用于观察应用和检查任务结果。
- 实验性 Mac ↔ Windows 键鼠共享与屏幕位置设置。

当前并非所有组合均已实机验收。Windows ↔ Windows / Mac ↔ Mac 完整体验、三四台设备键鼠布局、重启与换网恢复仍在验证。Mac 执行端暂不提供与 Windows 相同的窗口工具。接入 MCP 也不保证能使用某个 Agent 产品内置的 Computer Use 展示面板。

## 版本与开发

`main` 是唯一开发源码；当前开发版本为 **0.1.0-rc.6**，**不代表已发布 rc.6 安装包**。下载版本始终以 Releases 为准。桌面副本、Actions 临时构建和源码 ZIP 不作为普通用户的安装入口。

构建需要 Node.js 22+。Mac 原生组件需要 Swift 工具链，Windows 应用与安装器需要 Windows 构建环境。

```sh
npm ci --ignore-scripts
npm run build
npm run build:windows-node
npm run test:retained
python3 scripts/test-package-source.py
```

[构建与发布流程](docs/INSTALLERS.md) · [高级手动部署](docs/SETUP.md) · [MCP 示例](examples/mcp-config.example.json) · [键鼠功能边界](docs/INPUT-SHARING.md)

新版本经测试后从同一提交构建两端安装器，先生成带校验值的 Release 草稿，再验收发布。不要上传私有配置、令牌、证书私钥或个人配对文件。服务具有运行用户的系统权限，请阅读 [SECURITY.md](SECURITY.md)。

源码采用 [MIT](LICENSE)，第三方依赖保留各自许可证。
