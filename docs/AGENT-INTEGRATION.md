# 让任意 AI Agent 接入 AgentLink

AgentLink 是一个独立软件，不是某个 Agent 的插件。任何支持 **MCP**（Model Context Protocol）的客户端都能用它操作已配对的另一台电脑。

## 三种接入方式

| 方式 | 适用 | 入口 |
| --- | --- | --- |
| MCP over stdio | 本机的 Agent（Codex、Claude Code、Cursor、VS Code…） | `dist/apps/runtime/mcp.js` |
| MCP over HTTP | 其他进程、其他语言、同一局域网内需要 HTTP 的 Agent | `agentlink mcp-http [--port 7788]` |
| CLI / 本地脚本 | 一次性操作、CI | `agentlink ...` |

两种 MCP 方式暴露同一套 `computer_*` 工具；CLI 提供对应的常用操作入口。`computer_app_find` 按目标系统查询 Windows 应用记录或 Mac 应用包。不同设备报告各自支持的能力，Agent 应先查看 `computer_list` / `computer_info`。

## 一行注册

```sh
agentlink agent list                 # 看看装了哪些客户端、是否已注册
agentlink agent install cursor       # 只打印将要写入的内容（默认不写）
agentlink agent install cursor --apply
agentlink agent snippet              # 想要手动粘贴就用这个
```

支持的目标：`codex`、`claude-desktop`、`claude-code`、`cursor`、`vscode`、`generic`。

规则（写在代码里，不靠自觉）：

- **默认 dry-run**：不加 `--apply` 绝不写文件。
- **写入前备份**：已有配置先复制一份 `<file>.agentlink-backup-<时间戳>`。
- **只动自己那一项**：合并进现有的 `mcpServers` / `servers` / `[mcp_servers.*]`，其他服务器与设置原样保留；重复执行结果不变（幂等）。
- **拒绝破坏**：目标文件不是期望的结构就报错退出，不覆盖。

## 每个 Agent 独立上下文

不同客户端使用不同的 `AGENTLINK_SESSION`（例如 `agentlink-cursor`）。这意味着 A Agent 调用 `computer_use` 切换电脑，**不会**改变 B Agent 的目标电脑。

## 给 Agent 的说明书

`agents/AGENT-GUIDE.md` 是 Agent 中立的使用说明（工具顺序、必须遵守的规则、常见任务做法）。安装后可随时查看：

```sh
agentlink agent guide            # 打印
agentlink agent guide --install  # 安装到 <AGENTLINK_HOME>/AGENT-GUIDE.md
```

它的内容不依赖任何特定厂商的措辞或路径，可以直接放进任意 Agent 的系统提示或技能目录。

## 配置与状态位置

```sh
agentlink paths
```

优先级：`AGENTLINK_HOME` > 平台默认目录（macOS: `~/Library/Application Support/AgentLink`，Windows: `%APPDATA%\AgentLink`，Linux: `$XDG_CONFIG_HOME/agentlink`）。`AGENTLINK_CONFIG` 可单独指定注册表文件。**代码里没有任何硬编码的用户名、盘符或仓库路径。**

## 安全边界

- stdio 方式继承调用方权限；HTTP 方式默认**只监听 127.0.0.1**，需要 `Authorization: Bearer <token>`，token 保存在 `<home>/config/agent-http.local.json`（0600，首次启动自动生成）。
- 想绑定到局域网必须显式传 `--host`，并且启动时会打印警告。
- Agent 能做什么由对端电脑的配对、能力与模式决定；AgentLink 不会因为换了一个 Agent 就放宽权限。
