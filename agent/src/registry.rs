//! Windows 注册表与 Native Messaging Host 清单维护。
//!
//! 职责：
//! 1. 生成并更新 `cc.nanio.tug.agent.json` 清单中的 `allowed_origins`；
//! 2. 检测本机已安装的主流 Chromium 内核浏览器，仅对已检测到的浏览器在 `HKCU` 写入 `NativeMessagingHosts` 项（避免污染未安装浏览器的注册表）；
//! 3. 在当前用户注册表 (`HKCU\Software\Classes\tug-agent`) 静默注册 `tug-agent://` 自定义协议，并清理旧版 `com.tug.web.helper` 残留；
//! 4. 所有子进程调用均携带 `CREATE_NO_WINDOW` 标志，杜绝命令行黑框闪烁。

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::process::Command;

use anyhow::{Context, anyhow};

#[cfg(target_os = "windows")]
use crate::config::CREATE_NO_WINDOW;
use crate::config::{HOST_NAME, PROTOCOL_SCHEME};

#[cfg(target_os = "windows")]
const LEGACY_HOST_NAME: &str = "com.tug.web.helper";

#[cfg(target_os = "windows")]
struct BrowserTarget {
    _name: &'static str,
    nm_subkey: &'static str,
    detect_reg_keys: &'static [&'static str],
    detect_local_appdata: &'static [&'static str],
    detect_appdata: &'static [&'static str],
    detect_program_files: &'static [&'static str],
}

#[cfg(target_os = "windows")]
const BROWSER_TARGETS: &[BrowserTarget] = &[
    BrowserTarget {
        _name: "Google Chrome",
        nm_subkey: r"HKCU\Software\Google\Chrome\NativeMessagingHosts",
        detect_reg_keys: &[
            r"HKCU\Software\Google\Chrome",
            r"HKLM\Software\Google\Chrome",
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
        ],
        detect_local_appdata: &[r"Google\Chrome\User Data", r"Google\Chrome\Application\chrome.exe"],
        detect_appdata: &[],
        detect_program_files: &[r"Google\Chrome\Application\chrome.exe"],
    },
    BrowserTarget {
        _name: "Microsoft Edge",
        nm_subkey: r"HKCU\Software\Microsoft\Edge\NativeMessagingHosts",
        detect_reg_keys: &[
            r"HKCU\Software\Microsoft\Edge",
            r"HKLM\Software\Microsoft\Edge",
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
        ],
        detect_local_appdata: &[r"Microsoft\Edge\User Data"],
        detect_appdata: &[],
        detect_program_files: &[r"Microsoft\Edge\Application\msedge.exe"],
    },
    BrowserTarget {
        _name: "Chromium",
        nm_subkey: r"HKCU\Software\Chromium\NativeMessagingHosts",
        detect_reg_keys: &[r"HKCU\Software\Chromium"],
        detect_local_appdata: &[r"Chromium\User Data", r"Chromium\Application\chrome.exe"],
        detect_appdata: &[],
        detect_program_files: &[r"Chromium\Application\chrome.exe"],
    },
    BrowserTarget {
        _name: "Brave",
        nm_subkey: r"HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
        detect_reg_keys: &[
            r"HKCU\Software\BraveSoftware\Brave-Browser",
            r"HKLM\Software\BraveSoftware\Brave-Browser",
        ],
        detect_local_appdata: &[r"BraveSoftware\Brave-Browser\User Data"],
        detect_appdata: &[],
        detect_program_files: &[r"BraveSoftware\Brave-Browser\Application\brave.exe"],
    },
    BrowserTarget {
        _name: "Vivaldi",
        nm_subkey: r"HKCU\Software\Vivaldi\NativeMessagingHosts",
        detect_reg_keys: &[r"HKCU\Software\Vivaldi"],
        detect_local_appdata: &[r"Vivaldi\User Data", r"Vivaldi\Application\vivaldi.exe"],
        detect_appdata: &[],
        detect_program_files: &[r"Vivaldi\Application\vivaldi.exe"],
    },
    BrowserTarget {
        _name: "Opera / Opera GX",
        nm_subkey: r"HKCU\Software\Opera Software\NativeMessagingHosts",
        detect_reg_keys: &[r"HKCU\Software\Opera Software"],
        detect_local_appdata: &[r"Programs\Opera\opera.exe", r"Programs\Opera GX\opera.exe"],
        detect_appdata: &[r"Opera Software\Opera Stable", r"Opera Software\Opera GX Stable"],
        detect_program_files: &[r"Opera\opera.exe"],
    },
    BrowserTarget {
        _name: "Yandex Browser",
        nm_subkey: r"HKCU\Software\Yandex\YandexBrowser\NativeMessagingHosts",
        detect_reg_keys: &[r"HKCU\Software\Yandex\YandexBrowser"],
        detect_local_appdata: &[r"Yandex\YandexBrowser\User Data"],
        detect_appdata: &[],
        detect_program_files: &[r"Yandex\YandexBrowser\Application\browser.exe"],
    },
    BrowserTarget {
        _name: "360 极速浏览器",
        nm_subkey: r"HKCU\Software\360Chrome\Chrome\NativeMessagingHosts",
        detect_reg_keys: &[r"HKCU\Software\360Chrome"],
        detect_local_appdata: &[r"360Chrome\Chrome\User Data", r"360Chrome\Chrome\Application\360chrome.exe"],
        detect_appdata: &[],
        detect_program_files: &[r"360\360Chrome\Chrome\Application\360chrome.exe"],
    },
    BrowserTarget {
        _name: "360 极速浏览器 X",
        nm_subkey: r"HKCU\Software\360ChromeX\Chrome\NativeMessagingHosts",
        detect_reg_keys: &[r"HKCU\Software\360ChromeX"],
        detect_local_appdata: &[r"360ChromeX\Chrome\User Data", r"360ChromeX\Chrome\Application\360chromex.exe"],
        detect_appdata: &[],
        detect_program_files: &[r"360ChromeX\Chrome\Application\360chromex.exe"],
    },
    BrowserTarget {
        _name: "360 安全浏览器",
        nm_subkey: r"HKCU\Software\360se6\Chrome\NativeMessagingHosts",
        detect_reg_keys: &[r"HKCU\Software\360se6", r"HKCU\Software\360\360se6"],
        detect_local_appdata: &[r"360se6"],
        detect_appdata: &[r"360se6\User Data", r"360se6"],
        detect_program_files: &[r"360\360se6\Application\360se.exe"],
    },
    BrowserTarget {
        _name: "QQ 浏览器",
        nm_subkey: r"HKCU\Software\Tencent\QQBrowser\NativeMessagingHosts",
        detect_reg_keys: &[r"HKCU\Software\Tencent\QQBrowser"],
        detect_local_appdata: &[r"Tencent\QQBrowser\User Data"],
        detect_appdata: &[],
        detect_program_files: &[r"Tencent\QQBrowser\QQBrowser.exe"],
    },
    BrowserTarget {
        _name: "搜狗高速浏览器",
        nm_subkey: r"HKCU\Software\SogouExplorer\NativeMessagingHosts",
        detect_reg_keys: &[r"HKCU\Software\SogouExplorer"],
        detect_local_appdata: &[r"SogouExplorer"],
        detect_appdata: &[r"SogouExplorer"],
        detect_program_files: &[r"SogouExplorer\SogouExplorer.exe"],
    },
    BrowserTarget {
        _name: "百分浏览器 (CentBrowser)",
        nm_subkey: r"HKCU\Software\CentBrowser\NativeMessagingHosts",
        detect_reg_keys: &[r"HKCU\Software\CentBrowser"],
        detect_local_appdata: &[r"CentBrowser\User Data", r"CentBrowser\Application\chrome.exe"],
        detect_appdata: &[],
        detect_program_files: &[r"CentBrowser\Application\chrome.exe"],
    },
    BrowserTarget {
        _name: "夸克浏览器 (PC)",
        nm_subkey: r"HKCU\Software\Quark\NativeMessagingHosts",
        detect_reg_keys: &[r"HKCU\Software\Quark"],
        detect_local_appdata: &[r"Quark\User Data", r"Quark\Application\quark.exe"],
        detect_appdata: &[],
        detect_program_files: &[r"Quark\Application\quark.exe"],
    },
];

#[cfg(target_os = "windows")]
fn run_reg_silent(args: &[&str]) -> bool {
    Command::new("reg")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn any_env_path_exists(var_name: &str, rel_paths: &[&str]) -> bool {
    if rel_paths.is_empty() {
        return false;
    }
    let Some(base) = std::env::var_os(var_name) else {
        return false;
    };
    let base_path = PathBuf::from(base);
    rel_paths.iter().any(|rel| base_path.join(rel).exists())
}

#[cfg(target_os = "windows")]
fn is_browser_installed(target: &BrowserTarget) -> bool {
    if any_env_path_exists("LOCALAPPDATA", target.detect_local_appdata)
        || any_env_path_exists("APPDATA", target.detect_appdata)
        || any_env_path_exists("ProgramFiles", target.detect_program_files)
        || any_env_path_exists("ProgramFiles(x86)", target.detect_program_files)
    {
        return true;
    }
    target
        .detect_reg_keys
        .iter()
        .any(|key| run_reg_silent(&["query", key]))
}

#[cfg(target_os = "windows")]
fn cleanup_legacy_registry() {
    for target in BROWSER_TARGETS {
        let legacy_key = format!(r"{}\{LEGACY_HOST_NAME}", target.nm_subkey);
        let _ = run_reg_silent(&["delete", &legacy_key, "/f"]);
    }
    let _ = run_reg_silent(&["delete", r"HKCU\Software\Classes\tug-web", "/f"]);
}

/// 将 `tug-agent://` 自定义协议与已检测到浏览器的 Native Messaging Host 写入当前用户注册表 (`HKCU`)。
/// 当 `force_registry` 为 `false` 且目标 `ext_id` 已在清单中时直接短路返回，避免重复 I/O。
pub fn install_and_register(ext_id: Option<&str>, force_registry: bool) -> anyhow::Result<PathBuf> {
    let exe_path = std::env::current_exe().context("无法获取当前可执行文件路径")?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| anyhow!("无法获取可执行文件所在目录"))?;
    let manifest_path = exe_dir.join(format!("{HOST_NAME}.json"));

    let mut origins: Vec<String> = Vec::new();
    let mut manifest_existed = false;
    if manifest_path.exists()
        && let Ok(existing_str) = std::fs::read_to_string(&manifest_path)
        && let Ok(val) = serde_json::from_str::<serde_json::Value>(&existing_str)
        && let Some(arr) = val.get("allowed_origins").and_then(|v| v.as_array())
    {
        manifest_existed = true;
        for item in arr {
            if let Some(s) = item.as_str() {
                origins.push(s.to_owned());
            }
        }
    }

    let mut origin_added = false;
    if let Some(id) = ext_id {
        let clean_id = id
            .trim()
            .trim_start_matches("chrome-extension://")
            .trim_matches('/');
        if !clean_id.is_empty() {
            let origin = format!("chrome-extension://{clean_id}/");
            if !origins.contains(&origin) {
                origins.push(origin);
                origin_added = true;
            }
        }
    }

    // 若非强制重装、清单已存在且当前扩展 ID 早已注册，直接返回，不触发任何写盘或注册表命令
    if !force_registry && manifest_existed && !origin_added {
        return Ok(manifest_path);
    }

    let manifest_json = serde_json::json!({
        "name": HOST_NAME,
        "description": "Tug Agent Stateless BitTorrent/DHT Local Agent",
        "path": exe_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": origins,
    });
    std::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest_json)?,
    )?;

    #[cfg(target_os = "windows")]
    if force_registry || !manifest_existed {
        cleanup_legacy_registry();

        let manifest_str = manifest_path.to_string_lossy().into_owned();
        for target in BROWSER_TARGETS {
            if is_browser_installed(target) {
                let key = format!(r"{}\{HOST_NAME}", target.nm_subkey);
                let _ = run_reg_silent(&["add", &key, "/ve", "/t", "REG_SZ", "/d", &manifest_str, "/f"]);
            }
        }

        let proto_root = format!(r"HKCU\Software\Classes\{PROTOCOL_SCHEME}");
        let proto_cmd = format!(r"HKCU\Software\Classes\{PROTOCOL_SCHEME}\shell\open\command");
        let cmd_val = format!("\"{}\" \"%1\"", exe_path.to_string_lossy());
        let _ = run_reg_silent(&[
            "add",
            &proto_root,
            "/ve",
            "/t",
            "REG_SZ",
            "/d",
            "URL:Tug Agent Protocol",
            "/f",
        ]);
        let _ = run_reg_silent(&[
            "add",
            &proto_root,
            "/v",
            "URL Protocol",
            "/t",
            "REG_SZ",
            "/d",
            "",
            "/f",
        ]);
        let _ = run_reg_silent(&["add", &proto_cmd, "/ve", "/t", "REG_SZ", "/d", &cmd_val, "/f"]);
    }

    Ok(manifest_path)
}

/// 解析命令行参数并执行必要的注册表/清单绑定。
/// 返回 `(is_native_messaging, install_only)`。
pub fn parse_cli_and_register() -> (bool, bool) {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut is_native_messaging = false;
    let mut install_only = false;
    let mut ext_id: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--install" {
            install_only = true;
        } else if arg == "--ext-id" && i + 1 < args.len() {
            ext_id = Some(args[i + 1].clone());
            i += 1;
        } else if arg.starts_with("chrome-extension://") {
            is_native_messaging = true;
            ext_id = Some(arg.clone());
        } else if arg.starts_with("tug-agent://") || arg.starts_with("tug-web://") {
            if let Ok(parsed) = url::Url::parse(arg) {
                for (k, v) in parsed.query_pairs() {
                    if k == "extId" || k == "id" {
                        ext_id = Some(v.into_owned());
                    }
                }
            }
        }
        i += 1;
    }

    let _ = install_and_register(ext_id.as_deref(), install_only);
    (is_native_messaging, install_only)
}
