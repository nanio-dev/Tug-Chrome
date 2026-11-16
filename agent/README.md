# Tug Agent 辅助组件

Tug Agent 为 Tug Web 提供可选的 Windows 本地能力：传统 BitTorrent TCP/UDP/DHT 连接、系统文件保存、打开与定位。HTTP 源站下载由浏览器扩展负责；组件不独立维护下载任务列表。

## 使用

从 [GitHub last Release](https://github.com/nanio-dev/Tug-Web/releases/download/last/tug-agent.exe) 下载辅助组件，按扩展中的引导完成启用与配对。普通 HTTP/HTTPS 下载可以使用纯浏览器模式。仅支持 Windows x64；建议与扩展同步更新。

## 构建

需要 Rust MSVC 工具链和 C++ Build Tools。双击本目录 `build.bat`，会生成 Release 文件 `tug-agent.exe`。完整发布包请在项目根目录运行 `packer.bat`。命令行调用可加 `--no-pause`。

## Companion component

Tug Agent optionally adds traditional BT connectivity and system file export/open/reveal to Tug Web on Windows x64. Browser-only mode is available for ordinary HTTP/HTTPS downloads. Download it from the [GitHub last release](https://github.com/nanio-dev/Tug-Web/releases/download/last/tug-agent.exe) and follow the extension's pairing flow.

Build with `build.bat`, or run the root `packer.bat` to package both components. Licensed under [Apache-2.0](../LICENSE).
