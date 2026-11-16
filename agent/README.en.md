# Tug Agent

[简体中文](README.md) · **English**

Tug Agent adds traditional BitTorrent TCP/UDP/DHT connectivity and system file saving, opening and reveal to Tug Web on Windows, macOS and Linux.

## Installation and use

Follow the extension's Agent setup flow, or download the package for your platform:

| Platform | Download | First installation |
|---|---|---|
| Windows x64 | [tug-agent.exe](https://github.com/nanio-dev/Tug-Web/releases/download/last/tug-agent.exe) | Download and run |
| macOS Intel / Apple Silicon | [Universal app](https://github.com/nanio-dev/Tug-Web/releases/download/last/tug-agent-macos-universal.zip) | Extract and open `Tug Agent.app` |
| Linux x64 | [Installer](https://github.com/nanio-dev/Tug-Web/releases/download/last/tug-agent-linux-x64.tar.gz) | Extract and run `sh install.sh` in that folder |
| Linux ARM64 | [Installer](https://github.com/nanio-dev/Tug-Web/releases/download/last/tug-agent-linux-arm64.tar.gz) | Extract and run `sh install.sh` in that folder |

On macOS, first launch may require approval in System Settings → Privacy & Security. On Linux, install as your desktop user without `sudo`; sandboxed Snap/Flatpak browsers are not currently supported.

The extension connects automatically after installation and starts Agent when needed. Agent exits after 120 seconds of inactivity. Uninstall it from the dashboard's Agent settings.

## Local build

Run from this directory:

| Platform | Requirements | Command | Output |
|---|---|---|---|
| Windows | Rust MSVC, C++ Build Tools | `build.bat --no-pause` | `tug-agent.exe` |
| macOS / Linux | Rust, C/C++ build tools | `sh build.sh` | `tug-agent` |

See the [project README](../README.en.md) for packaging and publishing.

[Apache-2.0](../LICENSE)
