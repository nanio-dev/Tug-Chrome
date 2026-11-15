# Tug Web

<p align="center">
  <img src="public/tug-icon.png" alt="Tug Web Logo" width="108" />
</p>

<p align="center">
  <strong>100% 独立运行的现代浏览器多线程下载与 BitTorrent / Magnet P2P 扩展（Chrome / Edge Manifest V3）</strong>
</p>

<p align="center">
  简体中文 | <a href="./README.en.md">English</a>
</p>

---

**Tug Web** 是 Tug 家族面向 Chromium 浏览器（Chrome / Edge / Brave / Arc）打造的**纯浏览器端独立下载管理器扩展**。它**不需要安装任何桌面端宿主程序或 Native Messaging 服务**，直接在浏览器扩展内部基于 **Offscreen Document + OPFS（Origin Private File System）随机读写存储** 实现：

- **HTTP / HTTPS 多连接分片下载（1–32 连接）与动态工作窃取（Work Stealing）**
- **BitTorrent（`.torrent`）与磁力链接（`magnet:?xt=urn:btih:...`）浏览器内下载**（WebTorrent WebRTC DataChannel P2P + BEP 19 HTTP/HTTPS WebSeed 混合加速 + 逐分片 SHA-1 校验）
- **浏览器默认下载自动接管、页面磁力链接捕获、右键快捷发送与批量嗅探**

---

## 核心特性

### 1. 100% 独立运行，零外部依赖
- 纯浏览器扩展形态运行，无需配合 `Tug Desktop`、Python、Node.js 或任何本地可执行文件。
- 采用 **Service Worker + Offscreen Document** 双层常驻架构，关闭 Popup 弹窗或切换标签页不会中断下载。

### 2. HTTP / HTTPS 多连接分片与动态工作窃取
- 自动探测目标服务器 `Accept-Ranges`、`Content-Range`、`ETag` 与 `Last-Modified`，解析 RFC 5987 / RFC 6266 `Content-Disposition` 文件名。
- 支持 **1–32 并发连接**。当某个分片提前完成时，自动查找剩余字节最多的活跃分片（`>= 256 KiB`）并从中间切分（**Work Stealing**），压榨长尾连接带宽。
- 断点续传：通过 `IndexedDB` 持久化每个分片的 `[start, current, end]` 进度，暂停或重启后对比 `ETag` 安全续传；不支持 Range 的服务器自动平滑回退至单流下载。
- 可选 **SHA-256 完整性校验** 与 **令牌桶全局限速（KiB/s）**。

### 3. BitTorrent / Magnet 浏览器内混合引擎
- 内置零依赖 **Bencode 编解码器**（精确提取 `info` 原始字节切片计算 20 字节 SHA-1 `info_hash`）。
- 支持上传本地 `.torrent` 种子文件、粘贴远程 `.torrent` URL 或 `magnet:?xt=urn:btih:...`（支持 40 位 Hex 与 32 位 Base32）。
- **WebTorrent (WebRTC DataChannel) + WebSocket Tracker (`wss://`)**：支持浏览器节点之间的 BitTorrent Wire 协议（`bitfield` / `interested` / `unchoke` / `request` / `piece`）以及 **BEP 10 / BEP 9 (`ut_metadata`)** 磁力链接元数据交换。
- **BEP 19 HTTP/HTTPS WebSeed (`url-list` / `ws=`) + `xs=` 元数据直连**：对包含 WebSeed 的开源镜像、发行版 ISO 等种子提供满速多连接并发拉取，并对每个 Piece 执行严格 **SHA-1 校验**。
- 支持多文件种子的**按需文件勾选（`onlyFiles`）**与实时勾选更新。

### 4. OPFS 零内存膨胀随机写盘与一键导出
- 下载过程中所有分片与 BT Piece 直接通过 `FileSystemFileHandle.createWritable({ keepExistingData: true })` + `seek(offset)` 写入浏览器私有文件系统（OPFS），避免在内存中拼接 `Blob` 导致大文件 OOM。
- 任务完成后自动（或手动）通过 `chrome.downloads` 导出到系统下载目录，并支持自动清理 OPFS 临时缓存。

### 5. 智能浏览器下载接管与 Tug 家族同源 UI
- 可配置自动接管 `chrome.downloads.onCreated`、最小拦截文件大小阈值（MB）、自定义文件扩展名白名单、站点域名黑名单，以及按住 `Alt` 键临时绕过接管。
- 延续 Tug 家族 **Material You 橄榄绿 / 暖米白（Light & Dark）** 视觉语言，内置 **Popup 迷你弹窗**、**全屏下载管理器工作台（`manager.html`）**、**独立设置页（`options.html`）** 与完整**中英双语（`zh-CN` / `en-US`）**。

---

## 仓库目录结构

```text
Tug-Web/
├── docs/
│   ├── architecture.md          # MV3 独立双层架构、OPFS 存储与模块设计说明
│   ├── protocol.md              # 扩展内部消息总线协议与引擎数据契约
│   ├── privacy.md               # 权限最小化与隐私安全合规说明
│   └── testing.md               # 自动化测试与手工验收指南
├── public/
│   ├── manifest.json            # Chrome / Edge Manifest V3 清单
│   ├── icons/                   # 16 / 32 / 48 / 64 / 128 扩展图标
│   └── _locales/                # zh_CN / en 浏览器扩展多语言包
├── scripts/
│   └── build-extension.mjs      # 打包 background.js / content.js 并同步 dist/extension
├── src/
│   ├── shared/                  # 类型契约、RPC 客户端、文件名消毒、格式化、i18n、Material You 样式
│   ├── engine/
│   │   ├── storage/             # OPFS 随机读写后端 (part-store.ts) 与 IndexedDB 元数据存储 (task-store.ts)
│   │   ├── http/                # HTTP Range 多连接分片器、动态工作窃取、令牌桶限速器
│   │   ├── torrent/             # Bencode 编解码、Torrent/Magnet 解析器、WebTorrent WebRTC + WebSeed 会话
│   │   └── core/                # TaskManager 队列调度、断点续传、系统目录导出
│   ├── offscreen/               # Offscreen Document 持久下载与 WebRTC 宿主
│   ├── background/              # MV3 Service Worker：下载拦截、右键菜单、快捷键、徽标与通知
│   ├── content/                 # 页面磁力链接拦截、Alt 绕过感知与页面链接嗅探
│   ├── popup/                   # 浏览器工具栏 Popup 迷你面板
│   ├── manager/                 # 全屏下载管理器工作台（任务列表、分段条、BT 详情、添加弹窗、设置）
│   └── options/                 # 扩展独立设置页
└── tests/                       # Node 测试套件（Bencode、HTTP 分片、BT/Magnet、拦截器与 i18n）
```

---

## 快速开始

### 环境要求
- **Node.js** `>= 22`（推荐 Node.js 24 LTS）
- **Chrome** `>= 116` 或 **Microsoft Edge** `>= 116`

### 安装依赖与构建

```bash
# 1. 安装依赖
npm install

# 2. 运行 TypeScript 严格类型检查
npm run check

# 3. 运行自动化单元与集成测试
npm test

# 4. 构建生产版本扩展（产物位于 dist/ 与 dist/extension/）
npm run build
```

### 在 Chrome / Edge 中加载扩展
1. 打开浏览器并访问：
   - **Chrome**: `chrome://extensions/`
   - **Edge**: `edge://extensions/`
2. 开启右上角的 **开发者模式（Developer mode）**。
3. 点击 **加载已解压的扩展程序（Load unpacked）**。
4. 选择本项目构建生成的 `D:\git\Tug-Web\dist`（或 `D:\git\Tug-Web\dist\extension`）目录即可完成安装。

---

## 详细文档

- [系统架构设计 (`docs/architecture.md`)](docs/architecture.md)
- [内部通信与数据协议 (`docs/protocol.md`)](docs/protocol.md)
- [隐私策略与权限说明 (`docs/privacy.md`)](docs/privacy.md)
- [测试方案与验收清单 (`docs/testing.md`)](docs/testing.md)

---

## 开源协议

本项目基于 [Apache License 2.0](LICENSE) 开源。
