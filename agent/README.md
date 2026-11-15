# Tug Agent (`tug-agent`)

`tug-agent`（界面显示名：**Tug Agent**）是专属于 **Tug Web 浏览器下载扩展** 的轻量级、无状态本地协议代理服务（Windows 原生无窗口后台进程）。

它旨在突破 Chromium 浏览器扩展沙箱的三项底层限制，同时保持 **100% 由浏览器插件主导业务状态** 的清晰架构：
1. **突破纯 TCP/UDP/DHT BitTorrent 沙箱限制**：浏览器沙箱仅允许 `fetch` (HTTP/HTTPS)、`WebSocket` (WSS) 与 `WebRTC DataChannel`，无法直接与传统 UDP Tracker、DHT 网络或裸 TCP/uTP BitTorrent 节点握手通信。
2. **消除完成导出时的 `blob:chrome-extension://...` 浏览器二次确认弹窗**：浏览器开启“下载前询问保存位置”或使用 360 等内置下载接管浏览器时，调用 `chrome.downloads.download(blobUrl)` 会触发带有 `blob:chrome-extension://...` 的确认弹窗；通过 `Tug Agent` 的 `/fs/export` 可将插件 OPFS 中的完成文件直接流式写入系统 `Downloads` 目录。
3. **原生资源管理器定位与打开文件**：通过 `/fs/open` 直接调用 `explorer.exe /select,"<path>"` 或系统默认关联程序，不受浏览器异步消息丢失 `User Gesture`（用户手势上下文）的限制。

---

## 1. 架构原则：插件端主导 + 服务端无状态协议代理

为避免“插件与本地服务各自维护一套下载队列与进度”带来的状态分裂、双端同步复杂性及耦合问题，`Tug Agent` 严格遵循以下架构边界：

| 维度 | Tug Web 浏览器插件（唯一大脑） | `Tug Agent` 本地代理（无状态手脚） |
|---|---|---|
| **代码归属** | `D:\git\Tug-Web\src` | `D:\git\Tug-Web\agent`（独立维护，不依赖 Tug Desktop） |
| **包名 / Host ID** | `chrome.runtime.id` | `cc.nanio.tug.agent`（清单文件 `cc.nanio.tug.agent.json`） |
| **任务队列与持久化** | `IndexedDB` (`TaskRecord`) 唯一维护所有任务状态 | **不保存任何任务数据库**（`persistence: None`） |
| **断点续传与分片位图** | 插件端记录已校验通过的 `btCompletedPieces` | 按需根据 HTTP `Range` 请求即时拉取指定字节范围 |
| **分片校验与存储** | 插件端逐 Piece 执行 SHA-1 校验并写入浏览器 `OPFS` | 仅在系统 `%TEMP%\tug-agent-stage` 维护会话期临时缓冲，任务暂停/停止/完成时立即删除 |
| **生命周期** | 随浏览器运行 | 无活动任务/导出操作且空闲 120 秒退出；握手连接和健康查询不阻止退出 |
| **容灾能力** | 即使下载到 50% 时关闭或卸载代理，前 50% 分片仍完整保存在插件 `OPFS` 中 | 随时可杀、随时重建 |

---

## 2. 源码目录与模块结构

```text
agent/
├── Cargo.toml                # Rust 依赖配置（axum, librqbit, tokio, futures-util 等）
├── README.md                 # 架构方案、模块说明、浏览器适配表与 API 协议文档
└── src/
    ├── main.rs               # 进程入口（windows_subsystem = "windows"）、单实例锁、空闲自动退出巡检与路由挂载
    ├── config.rs             # 全局常量（监听端口 16899、超时 120s、Host ID cc.nanio.tug.agent、DHT 引导节点与公共 Tracker）
    ├── state.rs              # 共享状态 AppState、受管会话条目 ManagedSessionEntry 与 librqbit::Session 初始化
    ├── registry.rs           # Windows HKCU 注册表按需检测浏览器并静默安装（Native Messaging 清单 + tug-agent:// 协议，幂等无黑框）
    ├── native_messaging.rs   # Native Messaging 标准输入输出（4 字节小端长度前缀 + JSON）通信循环
    ├── routes.rs             # 控制面路由（/health, /register, /session/start, /session/{id}/peers, /session/{id}/stop）
    ├── streamer.rs           # 数据面路由（/webseed/{id}/{*tail}）：将 librqbit 文件流包装为 BEP 19 HTTP 206 Range 流
    └── file_ops.rs           # 本地文件路由（/fs/export 零弹窗流式落盘、/fs/open 资源管理器定位/打开、/fs/delete 安全删除）
```

---

## 3. Windows 浏览器检测与按需唤醒机制

### 3.1 检测到已安装的浏览器才写入注册表
运行 `tug-agent.exe --install`（无需管理员权限，仅写入当前用户 `HKCU` 注册表）时，`registry.rs` 会依次检测本机目录（`%LOCALAPPDATA%` / `%APPDATA%` / `%ProgramFiles%` / `%ProgramFiles(x86)%`）与系统注册表，**仅对本机实际已安装的浏览器写入 `NativeMessagingHosts\cc.nanio.tug.agent`**，绝不向注册表写入未安装浏览器的空项；同时自动清理旧版 `com.tug.web.helper` 与 `tug-web://` 残留。

已内置支持的 14 款主流 Chromium 内核浏览器：

| 类别 | 浏览器 | 注册表路径 (`HKCU\...\NativeMessagingHosts\cc.nanio.tug.agent`) |
|---|---|---|
| **国际主流** | Google Chrome | `HKCU\Software\Google\Chrome\NativeMessagingHosts\cc.nanio.tug.agent` |
| | Microsoft Edge | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\cc.nanio.tug.agent` |
| | Chromium | `HKCU\Software\Chromium\NativeMessagingHosts\cc.nanio.tug.agent` |
| | Brave | `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\cc.nanio.tug.agent` |
| | Vivaldi | `HKCU\Software\Vivaldi\NativeMessagingHosts\cc.nanio.tug.agent` |
| | Opera / Opera GX | `HKCU\Software\Opera Software\NativeMessagingHosts\cc.nanio.tug.agent` |
| | Yandex Browser | `HKCU\Software\Yandex\YandexBrowser\NativeMessagingHosts\cc.nanio.tug.agent` |
| **国内主流** | 360 极速浏览器 | `HKCU\Software\360Chrome\Chrome\NativeMessagingHosts\cc.nanio.tug.agent` |
| | 360 极速浏览器 X | `HKCU\Software\360ChromeX\Chrome\NativeMessagingHosts\cc.nanio.tug.agent` |
| | 360 安全浏览器 | `HKCU\Software\360se6\Chrome\NativeMessagingHosts\cc.nanio.tug.agent` |
| | QQ 浏览器 | `HKCU\Software\Tencent\QQBrowser\NativeMessagingHosts\cc.nanio.tug.agent` |
| | 搜狗高速浏览器 | `HKCU\Software\SogouExplorer\NativeMessagingHosts\cc.nanio.tug.agent` |
| | 百分浏览器 (CentBrowser) | `HKCU\Software\CentBrowser\NativeMessagingHosts\cc.nanio.tug.agent` |
| | 夸克浏览器 (PC 版) | `HKCU\Software\Quark\NativeMessagingHosts\cc.nanio.tug.agent` |

### 3.2 自动绑定与静默按需唤醒
1. **自定义协议注册**：写入 `HKCU\Software\Classes\tug-agent`（`tug-agent://`），并带 `CREATE_NO_WINDOW` 标志静默启动守护实例。
2. **静默注册扩展 ID**：插件向 `/register` 提交当前扩展 ID，Agent 更新 Native Messaging 清单；随后建立原生握手获取控制凭据。普通连接无需打开协议授权页。
3. **日常静默按需唤醒**：绑定完成后，当插件需要解析磁力链接、下载纯 TCP/UDP 种子或导出完成文件时，后台 Service Worker 调用 `chrome.runtime.connectNative("cc.nanio.tug.agent")`，浏览器在后台静默拉起 `tug-agent.exe`（全程无黑框），原生连接用于握手；无任务和文件操作时空闲 120 秒自动退出，下次打开界面按需唤醒。

---

## 4. 本地 HTTP 代理接口规范 (`http://127.0.0.1:16899`)

服务仅绑定 `127.0.0.1`。协议版本为 **2**：除只读 `/health` 和扩展 ID 注册 `/register` 外，所有接口要求 `X-Tug-Agent-Token`。32 字节随机能力凭据只通过 Native Messaging 的 `ready` / `pong` 帧交给已配对扩展，不通过 HTTP 暴露；扩展仅存入 `chrome.storage.session`，Agent 存放于当前用户应用目录的 `TugAgent/auth-token`。授权凭据不是任务数据库。

CORS 只反射合法扩展来源，不允许网页来源或 `*`。旧版 Agent 会被新版插件标记为需要更新。首次配对仍使用安装器/`tug-agent://register?extId=...` 绑定扩展 ID，然后建立 Native Messaging 连接。Agent 当前不接管 HTTP 源站下载。

### 4.1 健康检查与状态探测
- **`GET /health`**
  - 响应示例：
    ```json
    {
      "ok": true,
      "service": "tug-agent",
      "version": "1.0.0",
      "hostName": "cc.nanio.tug.agent",
      "port": 16899,
      "activeSessions": 0
    }
    ```

### 4.2 扩展 ID 动态绑定
- **`POST /register`**
  - 请求体：`{ "extId": "lhpgbfogojepnbnollifhjllngbfdcfb" }`
  - 说明：幂等检查并写入 `cc.nanio.tug.agent.json` 的 `allowed_origins`。

### 4.3 启动无状态 BT / 磁力会话
- **`POST /session/start`**
  - 请求体：
    ```json
    {
      "url": "magnet:?xt=urn:btih:...",
      "torrentBytesBase64": "<可选：.torrent 文件 Base64>",
      "trackers": ["udp://tracker.opentrackr.org:1337/announce"],
      "onlyFiles": [0, 1]
    }
    ```
  - 响应体：
    ```json
    {
      "ok": true,
      "sessionId": "0",
      "infoHash": "7acf8fb590b2060dd9c3146ef770169d593433b0",
      "name": "debian-13.7.0-amd64-netinst.iso",
      "totalBytes": 792723456,
      "torrentBytesBase64": "<解析后的完整 .torrent 元数据 Base64>",
      "webSeedUrl": "http://127.0.0.1:16899/webseed/0/"
    }
    ```

### 4.4 按需流式读取分片 (BEP 19 HTTP WebSeed 兼容)
- **`GET /webseed/{id}/{*tail}`**
  - 请求头：`Range: bytes=0-4194303`
  - 响应：`206 Partial Content` 流式输出对应文件区间的字节流。

### 4.5 获取实时节点 (Peers) 与速率状态
- **`GET /session/{id}/peers`**
  - 响应：返回当前会话的实时下载速率 (`downloadSpeedBytes`)、已连接 TCP/uTP/DHT 节点列表 (`peers`) 及 Tracker 状态 (`trackers`)。

### 4.6 停止会话并清理临时缓冲
- **`POST /session/{id}/stop`**
  - 响应：立即从 `librqbit` 移除会话并物理删除 `%TEMP%\tug-agent-stage\s-*` 临时目录。

### 4.7 本地文件系统辅助接口（免 `blob:` 弹窗落盘与目录定位）
所有接口先校验能力凭据。打开/删除仅允许实际 Downloads 根目录内的目标，拒绝目录穿越；导出还拒绝链接目录。数据先写同目录临时文件并同步，完成后不覆盖地发布最终文件，中断时清理临时文件。

- **`POST /fs/export`**
  - 请求头：`X-Relative-Path: <URL 编码的相对路径，如 Tug/video.mp4>`
  - 请求体：文件二进制流（`Blob` / `ReadableStream`）
  - 响应：`{ "ok": true, "savedPath": "C:\\Users\\<User>\\Downloads\\Tug\\video.mp4" }`
- **`POST /fs/open`**
  - 请求体：`{ "action": "open_file" | "reveal_file" | "open_folder", "path": "...", "subDir": "Tug" }`
  - 说明：直接调用系统资源管理器高亮定位文件（`explorer.exe /select,"..."`）或使用系统默认程序打开文件。
- **`POST /fs/delete`**
  - 请求体：`{ "path": "..." }`
  - 说明：当用户在插件中勾选“同时删除系统下载目录中的已下载文件”时安全移除目标文件。

---

## 5. 编译与安装指南

### 编译 Release 可执行文件
Windows 可直接双击本目录的 `build.bat`，自动构建 Release 并将二进制输出到本目录的 `tug-agent.exe`。命令行可使用 `build.bat --no-pause`，失败会返回非零退出码。脚本仅构建和复制，不安装或启动 Agent。

```powershell
cd D:\git\Tug-Web\agent
cargo build --release
Copy-Item .\target\release\tug-agent.exe .\tug-agent.exe -Force
```

### 检测本机浏览器并注册服务
```powershell
.\tug-agent.exe --install
```

### 验证服务运行状态
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:16899/health"
```

### 自动化验证与开发模式

仓库根目录运行 `npm run test:agent`：以隔离用户目录启动真实 Agent，通过原生 stdio 获取授权，验证导出、并发重名、中断清理、来源授权和路径限制，不安装服务或修改注册表。

`--serve-only --native-stdio --port=0` 为隔离测试/开发模式：跳过安装与迁移，禁用 BT 网络，在随机回环端口提供 API。常规运行仍使用 16899 和完整 BT 网络。

## 安装、唤醒与退出

先运行 agent/build.bat，再运行根目录 build.bat，并将源码与 agent/tug-agent.exe 一起推送。插件从 GitHub 固定链接附加 ?t=时间戳下载，完整缓存为 Blob，再交给浏览器保存；保存阶段不重复联网下载。安装文件仍名为 tug-agent.exe，不要求用户保留扩展 ID 文件名。

首次连接时插件通过 /register 静默提交扩展 ID，然后从 Native Messaging 获取控制凭据，无需打开协议授权页。/register 不要求凭据，但拒绝普通网页 Origin；文件、BT 和卸载等操作仍需凭据。其他有相应本机通信权限的扩展也能注册，这是开放注册的边界。

手动启动/安装会结束旧的已知 Agent 实例，将自身迁移到 LOCALAPPDATA/TugAgent 后再运行，并清理原安装文件；开发目录也采用此流程，只有明确的调试参数 --no-migrate 或 --serve-only 才跳过。日常浏览器握手复用已运行实例，避免打断下载。

无 BT 会话、无文件导出操作且空闲 120 秒自动退出，Native Messaging 端口打开及只读健康轮询不延长生命周期。下次打开界面或导出时重新唤醒。启动日志在 LOCALAPPDATA/TugAgent/startup.log；卸载入口仍清理该常驻目录与注册。

卸载会先将正在运行的二进制移出常驻目录，再清理该目录与注册；接口成功表示目录删除已确认。独立隐藏清理进程在 Agent 退出后删除临时二进制。插件在成功后清理凭据并切回独立模式，失败显示原因。正常运行时握手与凭据刷新由插件后台自动处理，保存文件不要求二次手动激活。

下载根目录规则：Agent 使用 Windows 标准 Known Folder API 的系统 Downloads，支持系统级目录迁移；不读取浏览器私有配置。纯插件模式最终路径由浏览器导出流程决定。插件配置的下载子目录在各自根目录下追加。
