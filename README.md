# Tug Web

<p align="center"><img src="public/tug-icon.png" alt="Tug Web" width="108" /></p>

**可独立运行的 HTTP 多连接、BitTorrent / Magnet 浏览器下载器，支持可选 Tug Agent。**

简体中文 | [English](README.en.md)

Tug Web 面向 Chromium 浏览器（Chrome / Edge Manifest V3），不依赖 Tug Desktop。HTTP 下载和 WebTorrent/WebSeed 可直接通过 Offscreen Document + OPFS 运行。可选的 Windows Tug Agent 提供传统 BT TCP/UDP/DHT、系统文件导出与打开能力。任务队列、设置与恢复状态始终由插件管理。

## 下载能力

- **HTTP/HTTPS 多连接**：配置 1–32 连接，使用均衡的有界 Range 工作队列。明文 HTTP 或已识别的 HTTP/1.1 使用最多 6 个有效工作者，避免反复切割浏览器中排队的请求；HTTPS/HTTP/2 保留配置并发。
- **安全续传**：检查 206 的范围、长度和资源验证器；通过强 ETag 或 Last-Modified / If-Range 续传。只有写盘并同步确认后的位置才会持久化。探测不支持 Range 时使用单流，中途资源变化则明确失败。
- **可选增量 SHA-256**、全局限速、网络空闲超时；任务区分下载、校验与保存阶段。
- **Torrent / Magnet**：WebRTC WebTorrent、HTTP WebSeed、逐 Piece SHA-1 校验；支持远程或本地种子、`xs=` / `ws=` 磁力参数和多文件勾选。普通 TCP/UDP/DHT 节点通过 Agent 接入。
- **OPFS 存储**：专用 Worker 使用 SyncAccessHandle 定位写，回退至 WritableFileStream；使用有限聚合缓冲，重置与续传采用不同语义，存储错误不会被当成成功。
- **保存与恢复**：通过浏览器下载 API 或已授权 Agent 导出；BT 逐文件记录保存结果，失败后只重试未保存文件，任务完成后清理缓存。
- **浏览器交互**：下载自动接管、右键菜单、磁力链接捕获、Alt 临时绕过；Popup、管理面板、设置页、中英双语和深浅色主题。

Agent 当前**不接管 HTTP 源站下载**。纯浏览器有效并发仍受浏览器网络栈与服务器协议限制；配置 32 不代表任意源站都会建立 32 条有效连接。

## 开发与加载

需要 Node.js >= 22、Chrome/Edge >= 116；构建 Agent 需要 Rust。

```powershell
npm ci
npm run check
npm test
npm run build
```

在 `chrome://extensions` 或 `edge://extensions` 开启开发者模式，加载 `dist/` 或 `dist/extension/`。

Windows 可直接双击根目录 `build.bat` 构建 `dist`，缺少依赖时自动安装；构建后在扩展页面点击重新加载。双击 `agent/build.bat` 构建 Release 并输出 `agent/tug-agent.exe`。命令行或自动化调用可加 `--no-pause` 取消结束等待，失败时返回非零退出码。

Agent 的构建、安装和原生消息配对见 [agent/README.md](agent/README.md)。新版插件要求 **Agent 协议 2**；旧版会显示“需要更新 Agent”。请同时更新插件与 Agent，不会退回无授权的本地接口。

## 测试与性能验证

```powershell
npm run test:browser
npm run test:agent
npm run bench:http -- --connections=8,32
```

浏览器测试使用已安装的 Playwright Chromium，或通过 `TUG_TEST_BROWSER` 指定 Chromium 可执行文件。测试创建独立配置，不操作日常浏览器数据。Agent 测试通过原生 stdio 获取凭据，使用隔离目录，不修改注册表。

详见 [测试说明](docs/testing.md) 和 [本轮改善及兼容性说明](docs/implementation-notes.md)。

## 代码结构

| 目录 | 职责 |
|---|---|
| `src/engine/http` | Range 队列、响应校验、网络超时、增量哈希与限速 |
| `src/engine/storage` | OPFS Worker、内存后端与 IndexedDB |
| `src/engine/torrent` | Bencode、种子/磁力解析、WebRTC/WebSeed 与 Agent 客户端 |
| `src/engine/core` | 唯一任务管理器、恢复、逐文件保存状态 |
| `src/background` / `src/offscreen` | 浏览器集成与引擎宿主 |
| `src/manager` / `src/popup` / `src/options` | 用户界面 |
| `agent` | Windows 无任务数据库的本地辅助程序 |
| `tests` / `scripts` | 回归测试、真实浏览器/Agent 集成测试与压测工具 |

## 文档

- [架构与数据提交约定](docs/architecture.md)
- [内部消息与 Agent 协议](docs/protocol.md)
- [隐私与本机接口边界](docs/privacy.md)
- [自动化与手动验证](docs/testing.md)

Apache License 2.0，见 [LICENSE](LICENSE)。
