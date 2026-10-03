# AgentLink — 给任意 AI Agent 的使用说明

AgentLink 让 Agent 使用已配对的其他电脑：可以是 Mac 或 Windows，也可以有多台。支持的操作取决于目标电脑报告的能力；文件、命令和应用操作已经按目标系统执行，视觉与窗口操作目前只在 Windows 节点提供。Agent 只需连接本机 AgentLink 的 MCP 服务。

本文件是 Agent 中立的使用说明。任何支持 MCP 的 Agent（Codex、Claude Code、Cursor、自研 Agent…）都可以直接使用。

## 心智模型

- **Agent 自己所在的电脑**叫“本机”。本机的终端、文件和应用仍然属于本机。
- **已配对的其他电脑**按名称和稳定设备 ID 列出。`computer_exec` 等工具在选中的电脑上执行，使用该电脑自己的 shell 和路径规则。
- 用户指定电脑时，先用 `computer_use` 选中它；不同 Agent 的选择互不影响。同名设备要用设备 ID，不能猜。

## 推荐的工作顺序

1. `computer_list` — 看有哪些电脑、哪台在线。没有指定目标时不要猜。
2. `computer_use` — 选中对端（可同时指定绝对工作目录）。
3. `computer_exec` — 跑命令、构建、测试、查看进程与日志。**默认手段。**
4. `computer_file_*` — 读写对端文件。工具覆盖不到的操作再用 `computer_exec`；Windows 是 PowerShell，Mac 是 zsh。
5. `computer_app_find` — 要用软件时先查目标系统的原生应用位置，不要靠猜测路径或反复遍历磁盘。Windows 查询开始菜单、已安装程序等；Mac 查询标准 Applications 目录。
6. `computer_app_launch` — 确认应用后再启动对端应用。
7. `computer_task_*` — 长任务（超过几十秒、或需要断线后仍能查询结果）。使用稳定的 `key`；提交结果不确定时**复用同一个 key**，不要换 key 重试。
8. `computer_windows` / `computer_window_capture` — 目标报告窗口能力时，且结果必须“用眼睛确认”时才截取目标窗口。
9. `computer_window_input` — 目标报告窗口输入能力且必须操作界面时才使用；输入长文本或中文优先用 `kind:"text"`。

## 必须遵守的规则

- **不要为了看一眼而打开整屏画面**。能用命令输出、文件内容、退出码证明的事，就不要截图。
- **不要删除对端文件、卸载软件、关闭用户正在使用的程序**，除非用户明确要求并确认了具体目标。
- **不要假设路径存在**。先用 `computer_file_stat` 或 `computer_exec` 确认。
- 命令失败时先读 stderr 和退出码；不要盲目重试同一条命令。
- 对端在锁屏、睡眠或未登录时，GUI 类操作会失败；此时用命令和文件完成工作，并如实告诉用户。
- 任务返回 `interrupted` 表示上一次执行结果未知，**不要自动重放**，先报告用户。

## 常见任务的正确做法

- "在某台 Mac/Windows 上写个贪吃蛇并运行测试" → `computer_list` → `computer_use` 选中目标 → `computer_exec` 创建文件/运行测试 → 用输出证明结果 → 需要视觉确认且设备支持时才截图。
- "继续 Windows 上那个项目" → `computer_use` 指定项目目录 → 用文件和命令工具继续。
- "看看 Windows 上那个软件现在什么样" → `computer_windows` 找到窗口 → `computer_window_capture` 单窗口截图。

## 报告要求

完成的依据必须是**可验证的证据**：命令输出、退出码、文件内容、任务日志。视觉证据只在任务本身需要视觉确认时才提供。
