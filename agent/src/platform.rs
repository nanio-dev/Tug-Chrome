//! Per-user system directories and Unix installation. No browser preferences are read.
use std::path::PathBuf;

pub fn app_dir() -> anyhow::Result<PathBuf> {
    #[cfg(windows)]
    let path = PathBuf::from(
        std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| anyhow::anyhow!("LOCALAPPDATA is missing"))?,
    )
    .join("TugAgent");
    #[cfg(target_os = "macos")]
    let path = home()?.join("Library/Application Support/TugAgent");
    #[cfg(target_os = "linux")]
    let path = absolute_env("XDG_DATA_HOME")
        .unwrap_or(home()?.join(".local/share"))
        .join("tug-agent");
    anyhow::ensure!(path.is_absolute(), "Agent directory must be absolute");
    Ok(path)
}

#[cfg(unix)]
pub fn home() -> anyhow::Result<PathBuf> {
    let path =
        PathBuf::from(std::env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("HOME is missing"))?);
    anyhow::ensure!(path.is_absolute(), "HOME must be absolute");
    Ok(path)
}

#[cfg(target_os = "linux")]
fn absolute_env(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

#[cfg(unix)]
pub fn native_manifest_paths() -> anyhow::Result<Vec<PathBuf>> {
    #[cfg(target_os = "macos")]
    let (base, browsers) = (
        home()?.join("Library/Application Support"),
        &[
            "Google/Chrome",
            "Google/Chrome Beta",
            "Google/Chrome Dev",
            "Google/Chrome Canary",
            "Google/ChromeForTesting",
            "Chromium",
            "Microsoft Edge",
            "Microsoft Edge Beta",
            "BraveSoftware/Brave-Browser",
            "Vivaldi",
            "com.operasoftware.Opera",
            "Yandex/YandexBrowser",
        ][..],
    );
    #[cfg(target_os = "linux")]
    let (base, browsers) = (
        absolute_env("XDG_CONFIG_HOME").unwrap_or(home()?.join(".config")),
        &[
            "google-chrome",
            "google-chrome-beta",
            "google-chrome-unstable",
            "google-chrome-for-testing",
            "chromium",
            "microsoft-edge",
            "microsoft-edge-beta",
            "BraveSoftware/Brave-Browser",
            "vivaldi",
            "opera",
            "yandex-browser",
        ][..],
    );
    Ok(browsers
        .iter()
        .map(|b| base.join(b))
        .filter(|p| p.is_dir())
        .map(|p| {
            p.join("NativeMessagingHosts")
                .join(format!("{}.json", crate::config::HOST_NAME))
        })
        .collect())
}

#[cfg(unix)]
pub fn register_manifests(manifest: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    for path in native_manifest_paths()? {
        if std::fs::read(&path).ok().as_deref() == Some(manifest) {
            continue;
        }
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent)?;
        let mut pending = tempfile::NamedTempFile::new_in(parent)?;
        pending.write_all(manifest)?;
        pending.persist(&path).map_err(|e| e.error)?;
    }
    Ok(())
}

#[cfg(unix)]
fn is_installed_process(pid: u32, binary: &std::path::Path) -> bool {
    if pid <= 1 || pid == std::process::id() {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/exe")).is_ok_and(|p| {
            let text = p.to_string_lossy();
            text.trim_end_matches(" (deleted)") == binary.to_string_lossy()
        })
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .is_ok_and(|o| {
                o.status.success()
                    && String::from_utf8_lossy(&o.stdout).trim() == binary.to_string_lossy()
            })
    }
}

#[cfg(unix)]
pub fn install_current() -> anyhow::Result<bool> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| {
        a.starts_with("chrome-extension://")
            || [
                "--native-stdio",
                "--daemon",
                "--no-migrate",
                "--isolated-install",
            ]
            .contains(&a.as_str())
    }) {
        return Ok(false);
    }
    let dir = app_dir()?;
    if let Ok(meta) = std::fs::symlink_metadata(&dir) {
        anyhow::ensure!(!meta.file_type().is_symlink(), "Redirected Agent directory");
    }
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    let target = dir.join("tug-agent");
    let current = std::env::current_exe()?;
    if current == target {
        return Ok(false);
    }
    if let Ok(pid) = std::fs::read_to_string(dir.join("agent.pid"))
        && let Ok(pid) = pid.trim().parse::<u32>()
        && is_installed_process(pid, &target)
    {
        let status = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()?;
        anyhow::ensure!(status.success(), "Cannot stop previous Agent");
        for _ in 0..30 {
            if !is_installed_process(pid, &target) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        anyhow::ensure!(
            !is_installed_process(pid, &target),
            "Previous Agent did not stop"
        );
    }
    // Replace the inode atomically: never truncate a running Unix executable.
    let mut pending = tempfile::NamedTempFile::new_in(&dir)?;
    pending.write_all(&std::fs::read(&current)?)?;
    pending
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o700))?;
    pending.persist(&target).map_err(|e| e.error)?;
    crate::registry::install_manifest_for(&target, None, true)?;
    let mut cmd = std::process::Command::new(target);
    cmd.arg("--daemon")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.spawn()?;
    Ok(true)
}

#[cfg(unix)]
pub fn uninstall() -> anyhow::Result<()> {
    let dir = app_dir()?;
    if let Ok(meta) = std::fs::symlink_metadata(&dir) {
        anyhow::ensure!(!meta.file_type().is_symlink(), "Redirected Agent directory");
    }
    for path in native_manifest_paths()? {
        if let Ok(text) = std::fs::read_to_string(&path)
            && let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
            && value
                .get("path")
                .and_then(|v| v.as_str())
                .is_some_and(|p| std::path::Path::new(p).starts_with(&dir))
        {
            std::fs::remove_file(path)?;
        }
    }
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn rejects_other_processes_and_nonabsolute_paths() {
        assert!(!super::is_installed_process(
            std::process::id(),
            std::path::Path::new("/tmp/other")
        ));
        assert!(!super::is_installed_process(
            0,
            std::path::Path::new("/tmp/other")
        ));
        assert!(super::app_dir().unwrap().is_absolute());
    }
}
