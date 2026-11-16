# Tug Agent

**简体中文** · [English](README.en.md)

Tug Agent 为 Tug Web 提供传统 BitTorrent TCP/UDP/DHT 连接，以及系统文件保存、打开和定位能力，支持 Windows、macOS 和 Linux。

## 安装与使用

在扩展中按提示启用 Agent，也可直接下载对应平台的安装包：

| 平台 | 下载 | 首次安装 |
|---|---|---|
| Windows x64 | [tug-agent.exe](https://github.com/nanio-dev/Tug-Web/releases/download/last/tug-agent.exe) | 下载后运行 |
| macOS Intel / Apple Silicon | [通用应用包](https://github.com/nanio-dev/Tug-Web/releases/download/last/tug-agent-macos-universal.zip) | 解压后打开 `Tug Agent.app` |
| Linux x64 | [安装包](https://github.com/nanio-dev/Tug-Web/releases/download/last/tug-agent-linux-x64.tar.gz) | 解压后在该目录运行 `sh install.sh` |
| Linux ARM64 | [安装包](https://github.com/nanio-dev/Tug-Web/releases/download/last/tug-agent-linux-arm64.tar.gz) | 解压后在该目录运行 `sh install.sh` |

macOS 首次打开可能需要在「系统设置 → 隐私与安全性」中允许。Linux 请以桌面用户安装，不使用 `sudo`；暂不支持 Snap/Flatpak 沙箱浏览器。

安装后扩展会自动连接，后续按需唤醒，空闲 120 秒自动退出。可在管理面板的 Agent 设置中卸载。

## 本地构建

在本目录执行：

| 平台 | 环境 | 命令 | 输出 |
|---|---|---|---|
| Windows | Rust MSVC、C++ Build Tools | `build.bat --no-pause` | `tug-agent.exe` |
| macOS / Linux | Rust、C/C++ 构建工具 | `sh build.sh` | `tug-agent` |

完整打包与发布见[项目 README](../README.md)。

[Apache-2.0](../LICENSE)
