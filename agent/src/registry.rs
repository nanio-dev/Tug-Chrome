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
        detect_local_appdata: &[
            r"Google\Chrome\User Data",
            r"Google\Chrome\Application\chrome.exe",
        ],
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
        detect_appdata: &[
            r"Opera Software\Opera Stable",
            r"Opera Software\Opera GX Stable",
        ],
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
        detect_local_appdata: &[
            r"360Chrome\Chrome\User Data",
            r"360Chrome\Chrome\Application\360chrome.exe",
        ],
        detect_appdata: &[],
        detect_program_files: &[r"360\360Chrome\Chrome\Application\360chrome.exe"],
    },
    BrowserTarget {
        _name: "360 极速浏览器 X",
        nm_subkey: r"HKCU\Software\360ChromeX\Chrome\NativeMessagingHosts",
        detect_reg_keys: &[r"HKCU\Software\360ChromeX"],
        detect_local_appdata: &[
            r"360ChromeX\Chrome\User Data",
            r"360ChromeX\Chrome\Application\360chromex.exe",
        ],
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
        detect_local_appdata: &[
            r"CentBrowser\User Data",
            r"CentBrowser\Application\chrome.exe",
        ],
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
        .any(|key| crate::windows_registry::exists(key))
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
    let mut manifest_path_matches = false;
    if manifest_path.exists()
        && let Ok(existing_str) = std::fs::read_to_string(&manifest_path)
        && let Ok(val) = serde_json::from_str::<serde_json::Value>(&existing_str)
        && let Some(arr) = val.get("allowed_origins").and_then(|v| v.as_array())
    {
        manifest_existed = true;
        manifest_path_matches = val
            .get("path")
            .and_then(|v| v.as_str())
            .is_some_and(|p| p.eq_ignore_ascii_case(&exe_path.to_string_lossy()));
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
        if !crate::auth::valid_extension_id(clean_id) {
            return Err(anyhow!("Invalid extension ID"));
        }
        if !clean_id.is_empty() {
            let origin = format!("chrome-extension://{clean_id}/");
            if !origins.contains(&origin) {
                origins.push(origin);
                origin_added = true;
            }
        }
    }

    let manifest_json = serde_json::json!({
        "name": HOST_NAME,
        "description": "Tug Agent Stateless BitTorrent/DHT Local Agent",
        "path": exe_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": origins,
    });
    if force_registry || !manifest_existed || !manifest_path_matches || origin_added {
        use std::io::Write;
        let mut pending = tempfile::NamedTempFile::new_in(exe_dir)?;
        pending.write_all(serde_json::to_string_pretty(&manifest_json)?.as_bytes())?;
        pending.persist(&manifest_path).map_err(|err| err.error)?;
    }

    #[cfg(target_os = "windows")]
    {
        if force_registry {
            cleanup_legacy_registry();
        }

        let manifest_str = manifest_path.to_string_lossy().into_owned();
        for target in BROWSER_TARGETS {
            if is_browser_installed(target) {
                let key = format!(r"{}\{HOST_NAME}", target.nm_subkey);
                if force_registry
                    || crate::windows_registry::string(&key, "").as_deref() != Some(&manifest_str)
                {
                    anyhow::ensure!(
                        run_reg_silent(&[
                            "add",
                            &key,
                            "/ve",
                            "/t",
                            "REG_SZ",
                            "/d",
                            &manifest_str,
                            "/f",
                        ]),
                        "Failed to register Native Messaging host: {key}"
                    );
                }
            }
        }

        let proto_root = format!(r"HKCU\Software\Classes\{PROTOCOL_SCHEME}");
        let proto_cmd = format!(r"HKCU\Software\Classes\{PROTOCOL_SCHEME}\shell\open\command");
        let cmd_val = format!("\"{}\" \"%1\"", exe_path.to_string_lossy());
        for (key, name, value) in [
            (&proto_root, "", "URL:Tug Agent Protocol"),
            (&proto_root, "URL Protocol", ""),
            (&proto_cmd, "", cmd_val.as_str()),
        ] {
            if force_registry
                || crate::windows_registry::string(key, name).as_deref() != Some(value)
            {
                let mut args = vec!["add", key];
                if name.is_empty() {
                    args.push("/ve");
                } else {
                    args.extend(["/v", name]);
                }
                args.extend(["/t", "REG_SZ", "/d", value, "/f"]);
                anyhow::ensure!(run_reg_silent(&args), "Failed to register protocol: {key}");
            }
        }
    }

    Ok(manifest_path)
}

/// 解析命令行参数并执行必要的注册表/清单绑定。
/// 返回 `(is_native_messaging, install_only)`。
pub fn parse_cli_and_register() -> anyhow::Result<(bool, bool)> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut is_native_messaging = false;
    let mut install_only = false;
    let mut ext_id: Option<String> = None;
    let mut migrated_from: Option<PathBuf> = None;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--install" {
            install_only = true;
        } else if arg == "--ext-id" && i + 1 < args.len() {
            ext_id = Some(args[i + 1].clone());
            i += 1;
        } else if arg == "--migrated-from" && i + 1 < args.len() {
            migrated_from = Some(PathBuf::from(&args[i + 1]));
            i += 1;
        } else if arg.starts_with("chrome-extension://") {
            is_native_messaging = true;
            ext_id = Some(arg.clone());
        } else if (arg.starts_with("tug-agent://") || arg.starts_with("tug-web://"))
            && let Ok(parsed) = url::Url::parse(arg)
        {
            for (k, v) in parsed.query_pairs() {
                if k == "extId" || k == "id" {
                    ext_id = Some(v.into_owned());
                }
            }
        }
        i += 1;
    }

    if let Some(old_path) = migrated_from {
        std::thread::spawn(move || {
            for _ in 0..8 {
                std::thread::sleep(std::time::Duration::from_millis(350));
                if !old_path.exists() || std::fs::remove_file(&old_path).is_ok() {
                    break;
                }
            }
        });
    }

    if !args.iter().any(|a| a == "--isolated-install") {
        install_and_register(ext_id.as_deref(), install_only)?;
    }
    Ok((is_native_messaging, install_only))
}

#[cfg(target_os = "windows")]
fn resolve_persistent_agent_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|local| PathBuf::from(local).join("TugAgent"))
}

/// 若当前是从下载目录等临时位置初次运行，则将自身复制到 `%LOCALAPPDATA%\TugAgent\tug-agent.exe`
/// 并拉起新实例（无脚本、无 taskkill），随后当前进程正常退出。返回 `true` 表示已触发迁移。
pub fn maybe_migrate_to_app_dir() -> anyhow::Result<bool> {
    #[cfg(not(windows))]
    {
        Ok(false)
    }
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        // Native Messaging is a wake/handshake, not an install or replacement.
        if args.iter().any(|a| {
            a.starts_with("chrome-extension://")
                || a == "--migrated-from"
                || a == "--daemon"
                || a == "--no-migrate"
        }) {
            return Ok(false);
        }
        let current = std::env::current_exe()?;
        stop_old_agents()?;
        let target_dir =
            resolve_persistent_agent_dir().ok_or_else(|| anyhow!("LOCALAPPDATA is missing"))?;
        std::fs::create_dir_all(&target_dir)?;
        let target = target_dir.join("tug-agent.exe");
        if current
            .to_string_lossy()
            .eq_ignore_ascii_case(&target.to_string_lossy())
        {
            return Ok(false);
        }
        // Stop old processes first: Windows cannot overwrite a running image.
        std::fs::copy(&current, &target).context("无法将 Agent 安装到 AppData")?;
        let mut cmd = Command::new(&target);
        cmd.args(&args);
        cmd.arg("--migrated-from").arg(&current);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn().context("无法启动 AppData 中的 Agent")?;
        Ok(true)
    }
}

#[cfg(windows)]
fn stop_old_agents() -> anyhow::Result<()> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        anyhow::ensure!(
            snapshot != INVALID_HANDLE_VALUE,
            "Cannot enumerate Agent processes"
        );
        let mut known = vec![
            std::env::current_exe()?,
            resolve_persistent_agent_dir()
                .ok_or_else(|| anyhow!("Missing LOCALAPPDATA"))?
                .join("tug-agent.exe"),
        ];
        if !std::env::args().any(|a| a == "--isolated-install") {
            for browser in BROWSER_TARGETS {
                let key = format!(r"{}\{HOST_NAME}", browser.nm_subkey);
                if let Some(manifest) = crate::windows_registry::string(&key, "")
                    && let Ok(text) = std::fs::read_to_string(manifest)
                    && let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
                    && let Some(path) = value.get("path").and_then(|v| v.as_str())
                {
                    known.push(PathBuf::from(path));
                }
            }
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = Process32FirstW(snapshot, &mut entry);
        while found != 0 {
            let name = String::from_utf16_lossy(
                &entry.szExeFile[..entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len())],
            );
            if entry.th32ProcessID != std::process::id()
                && name.eq_ignore_ascii_case("tug-agent.exe")
            {
                let process = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                    0,
                    entry.th32ProcessID,
                );
                if !process.is_null() {
                    let mut path = vec![0u16; 32768];
                    let mut length = path.len() as u32;
                    if QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length) != 0 {
                        let image = String::from_utf16_lossy(&path[..length as usize]);
                        let known_agent = known
                            .iter()
                            .any(|p| p.to_string_lossy().eq_ignore_ascii_case(&image));
                        if known_agent && TerminateProcess(process, 0) != 0 {
                            WaitForSingleObject(process, 5000);
                        }
                    }
                    CloseHandle(process);
                }
            }
            found = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
    }
    Ok(())
}

/// 彻底卸载 Tug Agent：清理注册表、清单文件、临时目录，并在退出后删除常驻目录中的自身文件。
pub fn uninstall_self() -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        let app_dir =
            resolve_persistent_agent_dir().ok_or_else(|| anyhow!("Missing LOCALAPPDATA"))?;
        if app_dir.exists() {
            use std::os::windows::fs::MetadataExt;
            anyhow::ensure!(
                std::fs::symlink_metadata(&app_dir)?.file_attributes() & 0x400 == 0,
                "Refusing to uninstall a redirected Agent directory"
            );
            let parent = std::fs::canonicalize(app_dir.parent().unwrap())?;
            anyhow::ensure!(
                std::fs::canonicalize(&app_dir)?
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&parent.join("TugAgent").to_string_lossy()),
                "Unexpected Agent directory"
            );
            let exe = std::env::current_exe()?;
            let moved = if exe.parent().is_some_and(|p| {
                p.to_string_lossy()
                    .eq_ignore_ascii_case(&app_dir.to_string_lossy())
            }) {
                let trash = app_dir
                    .parent()
                    .unwrap()
                    .join(format!(".TugAgent-remove-{}", std::process::id()));
                std::fs::create_dir_all(&trash)?;
                let moved_exe = trash.join("tug-agent.exe");
                std::fs::rename(&exe, &moved_exe).context("无法移出正在运行的 Agent 文件")?;
                let script = r#"
$agentOwnerPid = [int]$env:TUG_REMOVE_PID
$agentTrash = [IO.Path]::GetFullPath($env:TUG_REMOVE_ROOT)
$agentExpected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA ('.TugAgent-remove-' + $agentOwnerPid)))
if ($agentTrash -ne $agentExpected) { exit 1 }
Wait-Process -Id $agentOwnerPid -Timeout 20 -ErrorAction SilentlyContinue
for ($agentAttempt = 0; $agentAttempt -lt 40; $agentAttempt++) {
  Remove-Item -LiteralPath (Join-Path $agentTrash 'tug-agent.exe') -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath (Join-Path $agentTrash 'tug-agent.exe'))) { break }
  Start-Sleep -Milliseconds 250
}
Remove-Item -LiteralPath $agentTrash -ErrorAction SilentlyContinue
"#;
                let mut cleanup = Command::new("powershell.exe");
                cleanup.args(["-NoProfile", "-NonInteractive", "-Command", script]);
                cleanup
                    .env("TUG_REMOVE_PID", std::process::id().to_string())
                    .env("TUG_REMOVE_ROOT", &trash);
                // The cleanup must survive termination of a browser-owned native host.
                cleanup.creation_flags(CREATE_NO_WINDOW | 0x01000000);
                if let Err(err) = cleanup.spawn() {
                    let _ = std::fs::rename(&moved_exe, &exe);
                    return Err(err).context("无法启动 Agent 清理程序");
                }
                Some((moved_exe, exe))
            } else {
                None
            };
            if let Err(err) = std::fs::remove_dir_all(&app_dir) {
                if let Some((moved_exe, original)) = moved {
                    let _ = std::fs::create_dir_all(&app_dir);
                    let _ = std::fs::rename(moved_exe, original);
                }
                return Err(err).context("Agent 常驻目录清理失败");
            }
            anyhow::ensure!(!app_dir.exists(), "Agent directory still exists");
        }
        // Tests exercise actual executable deletion without touching user registry entries.
        if !std::env::args().any(|a| a == "--serve-only" || a == "--isolated-install") {
            for proto in [PROTOCOL_SCHEME, "tug-web"] {
                let key = format!(r"HKCU\Software\Classes\{proto}");
                let _ = run_reg_silent(&["delete", &key, "/f"]);
                anyhow::ensure!(
                    !crate::windows_registry::exists(&key),
                    "Protocol registry cleanup failed: {key}"
                );
            }
            for target in BROWSER_TARGETS {
                for host in [HOST_NAME, LEGACY_HOST_NAME] {
                    let key = format!(r"{}\{host}", target.nm_subkey);
                    let _ = run_reg_silent(&["delete", &key, "/f"]);
                    anyhow::ensure!(
                        !crate::windows_registry::exists(&key),
                        "Native host registry cleanup failed: {key}"
                    );
                }
            }
        }
    }
    Ok(())
}
