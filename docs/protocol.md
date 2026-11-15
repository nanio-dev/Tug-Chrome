# 内部消息与 Agent 协议

## 插件 RPC

权威类型在 `src/shared/protocol.ts`、`src/shared/types.ts`。

```json
{
  "channel": "tug-web-rpc",
  "target": "background",
  "type": "add_task",
  "requestId": "unique-request-id",
  "payload": { "url": "https://example.com/file.zip", "connections": 8 }
}
```

成功返回 `{ "ok": true, "requestId": "...", "data": ... }`；失败返回 `{ "ok": false, "requestId": "...", "error": { "code": "...", "message": "...", "retryable": true } }`。

Background 负责系统集成，转发下载命令到 offscreen。任务事件使用 `channel: "tug-web-event"`，事件为 updated、removed 或 settings。

| 命令 | 用途 |
|---|---|
| `add_task`, `list_tasks`, `get_state_snapshot` | 创建及查询任务 |
| `pause_task`, `resume_task`, `pause_all`, `resume_all`, `remove_task` | 生命周期管理 |
| `list_torrent_files`, `set_torrent_files`, `torrent_runtime` | 文件选择与节点信息 |
| `get_settings`, `update_settings` | 设置 |
| `prepare_request_headers`, `clear_request_headers` | 临时 DNR 规则 |
| `export_blob_to_downloads` | 传入 exportId、taskId、blobUrl、relativePath；等待系统保存完成 |
| `cancel_task_export` | 按 exportId 取消浏览器保存 |
| `ensure_native_helper`, `get_native_helper_status` | 原生配对与状态 |
| `install_native_agent`, `get_agent_install_state`, `export_downloaded_agent`, `launch_downloaded_agent` | 安装交互 |

状态包括 queued、fetching_metadata、downloading、verifying、exporting、paused、completed、failed，另保留 seeding。verifying/exporting 属于活动任务，可暂停。

## HTTP 检查点

实时进度包含 received segments 与 committedSegments。IndexedDB 只保存后者及 committedBytes；`httpCheckpointVersion: 1` 标识修复后的提交语义。`httpDownloadComplete` 仅在传输、长度检查及可选校验都完成后设置，不能根据进度达到 100% 推断。

BT 使用 `btCheckpointVersion`、完成 Piece 位图与 `btExports`。文件选择改变时，失效缺失选中区间的完成标记。

## Agent 协议 2

监听回环 `127.0.0.1:16899`。HTTP `/health` 返回 service、version、protocolVersion、authRequired、port 等，不返回能力凭据。

Native Messaging 帧仍为 4 字节小端长度 + JSON。ready/pong 帧额外携带 `protocolVersion: 2` 与 `token`。浏览器先通过主机清单校验 allowed_origins，插件接收凭据后仅存入 `chrome.storage.session`。

除只读 health 外的请求必须带 `X-Tug-Agent-Token`。CORS 只允许合法扩展来源；网页来源被拒绝，即使带有凭据。客户端不跟随携带凭据的重定向；远程 WebSeed 不附加凭据。

| 接口 | 用途 |
|---|---|
| `POST /register` | 已授权后更新合法扩展 ID |
| `POST /session/start` | 从种子/磁力创建临时 BT 会话 |
| `GET /session/{id}/peers` | 会话状态 |
| `POST /session/{id}/stop` | 停止并清理 |
| `GET /webseed/{id}/{tail}` | BEP 19 Range 读取 |
| `POST /fs/export` | 二进制请求体，X-Relative-Path 为编码后的相对路径，返回 savedPath |
| `POST /fs/open` | open_file、reveal_file、open_folder，仅允许 Downloads 内目标 |
| `POST /fs/delete` | 删除 Downloads 内已存在文件 |
| `POST /uninstall` | 已授权卸载 |

旧协议 Agent 被标记为 updateRequired，不退回无授权调用。首次安装/扩展 ID 变更可通过安装器或自定义协议绑定，之后使用 Native Messaging。

## 注册与生命周期更新

/register 为开放注册入口，不要求能力凭据，允许合法扩展来源和无 Origin 的本机调用，拒绝普通网页来源；控制接口继续鉴权。注册后通过 Native Messaging 取得凭据，正常连接不依赖自定义协议页面。手动启动时替换旧实例并迁移到 AppData，普通握手不重启已有实例。健康查询与 Native Messaging 连接不阻止无任务空闲 120 秒退出。

Offscreen 文档不依赖 chrome.storage/nativeMessaging，使用 get_agent_credentials 私有 runtime RPC 获取后台已自动连接的凭据。该命令仅允许同扩展的 offscreen.html 调用，普通页面与内容脚本被拒绝；能力凭据仍不通过 HTTP 返回。卸载 API 只在常驻目录实际清理并完成注册表清理后返回 ok，错误以非成功 HTTP 状态返回。
