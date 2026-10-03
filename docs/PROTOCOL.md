# AgentLink Protocol · RC1

仅 HTTPS。请求头 `Authorization: Bearer <token>`。

`GET /info` 返回 NodeInfo：device_id、name、os、hostname、architecture、capabilities，以及可选的 protocol_version 和 features。RC1 的 protocol_version 为 2；功能通过 capabilities 和 features 判断，不能仅依赖版本号。

`POST /rpc` 请求结构：

```json
{"id":"uuid","type":"request","action":"files.read","payload":{"path":"D:\\AgentLinkShare\\test.txt"},"timestamp":0}
```

成功结构：

```json
{"id":"uuid","type":"response","ok":true,"result":{},"error":null}
```

失败结构：

```json
{"id":"uuid","type":"response","ok":false,"result":null,"error":{"code":"PATH_DENIED","message":"PATH_DENIED"}}
```

操作：

| action | payload | result |
| --- | --- | --- |
| files.list | path | name/type 数组 |
| files.read | path | encoding=base64, data |
| files.write | path, data, encoding=utf8/base64 | bytes |
| files.stat | path | type、size、mtime_ms、ctime_ms、mode、version |
| files.mkdir | path | created |
| files.rename | path, destination（目标不得已存在） | renamed |
| files.delete | path（文件或空目录） | deleted |
| files.read_chunk | path, offset, length ≤ 1 MiB, version? | data(base64)、bytes、eof、version |
| files.write_chunk | path, offset, data(base64，解码后 ≤ 1 MiB) | bytes |
| files.truncate | path, size | size |
| files.commit | path（同目录 staging 文件）, destination, version | committed |
| files.replace | path, destination, source_version, version | committed |
| shell.run | command, cwd, environment?, timeout? | exit_code, stdout, stderr, duration(ms) |
| tasks.submit | key, command, cwd, timeout? | id、status、duplicate |
| tasks.get | task_id | id、status、active、时间、exit_code?、error_code? |
| tasks.logs | task_id, cursor?（默认 0） | events、next_cursor、caught_up |
| tasks.cancel | task_id | cancellation_requested |
| apps.launch | app, cwd, args? | pid |
| screen.capture | monitor?（从 0 开始） | image/png 二进制，失败仍为 JSON |
| window.list | 无 | 可见应用窗口数组（id、title、process、pid、位置和大小） |
| window.capture | id | 该应用窗口的 image/png 二进制 |
| window.focus | id | focused |
| window.input | id、kind，以及坐标/按键/文字参数 | accepted |

`window.input` 的 kind 为 move、down、up、scroll、text 或 key，坐标相对所选窗口左上角。非零 Shell 退出码是成功完成执行后的 result；请求/超时/权限错误用 error。同步命令在连接断开时请求取消，但不能由此推断远端未产生效果。协议 action 为封闭集合，画面目前使用短轮询，没有 WebSocket 事件流。

持久任务与 HTTP 会话独立，断开客户端不会取消任务。`tasks` capability 和私有 tasks_dir 必须同时配置。同一 key 与相同 command/cwd/timeout 返回原任务；参数冲突返回 CONFLICT。最多 4 个活跃任务，满额返回 BUSY。timeout 使用毫秒，默认一小时，最大一天。新 key 可能再次执行命令，客户端不能在响应不确定时自动换 key。

任务状态为 accepted、running、succeeded、failed、cancelled、interrupted。Node 重启后，未结束任务标为 interrupted，不重放；它表示先前结果不确定。取消接口返回的是请求是否发出，需继续查询最终状态。日志 cursor 是事件索引，沿 next_cursor 继续读取。任务目录只允许一个 Node 实例拥有。

文件 version 是服务端返回的不透明值。commit/replace 的 version 必须匹配目标当前版本，或为 null 表示目标不存在；冲突时保留现有文件和来源文件。replace 还校验 source_version，且源与目标必须同目录。实现使用操作系统 rename，不会先删除目标。版本检查仅协调该 Node 的操作，不能替代 Windows 全局文件锁。

错误码类型定义位于 packages/protocol/index.ts。HTTP 401 表示认证失败，403 表示权限失败，404 表示缺失，400 表示无效请求，其余执行/内部错误返回 500。
