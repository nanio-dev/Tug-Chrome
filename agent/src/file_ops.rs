//! 本地文件系统辅助接口（零弹窗流式文件落盘、Explorer 目录定位、系统默认程序打开与安全删除）。
//!
//! 设计目的：
//! 1. 解决浏览器 `chrome.downloads.download(blob:...)` 在开启“下载前询问保存位置”时弹出 `blob:chrome-extension://...` 确认框的问题；
//! 2. 解决浏览器沙箱内 `chrome.downloads.open` / `show` 因异步 RPC 丢失 User Gesture 导致点击“打开文件 / 在文件夹中显示”无响应的问题。

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::io::{AsyncWriteExt, BufWriter};

use crate::routes::{json_error, with_cors};
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFilePayload {
    pub action: String, // "open_file" | "reveal_file" | "open_folder"
    pub path: Option<String>,
    pub sub_dir: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFilePayload {
    pub path: String,
}

#[cfg(windows)]
fn windows_downloads_dir() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_Downloads, SHGetKnownFolderPath};
    let mut raw = std::ptr::null_mut();
    // Standard Windows API follows a user's relocated Downloads known folder.
    unsafe {
        if SHGetKnownFolderPath(&FOLDERID_Downloads, 0, std::ptr::null_mut(), &mut raw) < 0
            || raw.is_null()
        {
            return None;
        }
        let mut length = 0;
        while *raw.add(length) != 0 {
            length += 1;
        }
        let path = PathBuf::from(std::ffi::OsString::from_wide(std::slice::from_raw_parts(
            raw, length,
        )));
        CoTaskMemFree(raw.cast());
        path.is_absolute().then_some(path)
    }
}

/// 获取当前用户的系统 `Downloads` 下载目录。
pub fn resolve_downloads_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    if !std::env::args().any(|a| a == "--serve-only" || a == "--isolated-install")
        && let Ok(output) = Command::new("xdg-user-dir").arg("DOWNLOAD").output()
        && output.status.success()
        && let Ok(value) = String::from_utf8(output.stdout)
    {
        let path = PathBuf::from(value.trim_end_matches(['\n', '\r']));
        if path.is_absolute() {
            return path;
        }
    }
    #[cfg(windows)]
    if !std::env::args().any(|a| a == "--serve-only" || a == "--isolated-install")
        && let Some(path) = windows_downloads_dir()
    {
        return path;
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let dl = PathBuf::from(profile).join("Downloads");
        return dl;
    }
    if let Some(home) = std::env::var_os("HOME") {
        let dl = PathBuf::from(home).join("Downloads");
        return dl;
    }
    std::env::temp_dir().join("TugDownloads")
}

/// 清理相对路径中的非法字符与目录穿越片段（`..`、`.`）。
fn sanitize_relative_path(raw: &str) -> Result<PathBuf, &'static str> {
    if raw.starts_with(['/', '\\']) || raw.contains(':') {
        return Err("Only relative paths within Downloads are allowed");
    }
    let mut clean = PathBuf::new();
    for seg in raw.replace('\\', "/").split('/') {
        let trimmed = seg.trim();
        if trimmed == ".." {
            return Err("Parent path components are not allowed");
        }
        if trimmed.is_empty() || trimmed == "." {
            continue;
        }
        let safe_seg: String = trimmed
            .chars()
            .map(|c| match c {
                '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0'..='\u{1f}' => '_',
                _ => c,
            })
            .collect();
        if !safe_seg.is_empty() {
            clean.push(safe_seg);
        }
    }
    if clean.as_os_str().is_empty() {
        clean.push("download");
    }
    Ok(clean)
}

fn inside_root(root: &Path, target: &Path) -> Option<PathBuf> {
    // Canonicalization resolves junctions/symlinks; lexical starts_with is unsafe.
    if target.components().any(|c| c == Component::ParentDir) {
        return None;
    }
    let root = std::fs::canonicalize(root).ok()?;
    let target = std::fs::canonicalize(target).ok()?;
    target.starts_with(&root).then_some(target)
}

fn resolve_in_root(root: &Path, raw: &str, sub_dir: Option<&str>) -> Option<PathBuf> {
    let path = PathBuf::from(raw.trim());
    if path.is_absolute() {
        return inside_root(root, &path);
    }
    let rel = sanitize_relative_path(raw).ok()?;
    inside_root(root, &root.join(&rel)).or_else(|| {
        let sub = sanitize_relative_path(sub_dir?).ok()?;
        inside_root(root, &root.join(sub).join(rel))
    })
}

/// 当目标文件已存在时，自动生成不冲突的文件路径（例如 `file (1).ext`）。
fn uniquify_target_path(base_path: &Path) -> PathBuf {
    if !base_path.exists() {
        return base_path.to_path_buf();
    }
    let parent = base_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = base_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download");
    let ext = base_path.extension().and_then(|s| s.to_str()).unwrap_or("");

    for i in 1..=9999 {
        let candidate_name = if ext.is_empty() {
            format!("{stem} ({i})")
        } else {
            format!("{stem} ({i}).{ext}")
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem}-{}", crate::state::now_secs()))
}

/// 根据传入的绝对或相对路径，在系统 `Downloads` 目录中定位实际文件。
fn resolve_existing_target(raw_path: &str, sub_dir: Option<&str>) -> Option<PathBuf> {
    if raw_path.trim().is_empty() {
        return None;
    }
    resolve_in_root(&resolve_downloads_dir(), raw_path, sub_dir)
}

fn export_parent(root: &Path, relative: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(root)?;
    let root = std::fs::canonicalize(root)?;
    let mut current = root.clone();
    for component in relative.parent().unwrap_or(Path::new("")).components() {
        let Component::Normal(name) = component else {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        };
        current.push(name);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err(std::io::ErrorKind::PermissionDenied.into());
                    }
                }
                if meta.file_type().is_symlink() || !meta.is_dir() {
                    return Err(std::io::ErrorKind::PermissionDenied.into());
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)?
            }
            Err(err) => return Err(err),
        }
        if !std::fs::canonicalize(&current)?.starts_with(&root) {
            return Err(std::io::ErrorKind::PermissionDenied.into());
        }
    }
    Ok(current)
}

#[derive(Deserialize, Default)]
pub struct ExportQuery {
    pub path: Option<String>,
}

/// 解码 `encodeURIComponent` 生成的百分号编码 UTF-8 字符串（不拆分 `&` / `=`，不将 `+` 替换为空格）。
fn decode_uri_component(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            )
        {
            out.push(((h << 4) | l) as u8);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_owned())
}

/// `POST /fs/export`：将插件 OPFS 中的已完成文件流式直接写入系统 `Downloads` 目录，免除浏览器 `blob:` 确认弹窗。
pub async fn handle_fs_export(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ExportQuery>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let _operation = state.begin_operation();

    let decoded_rel = if let Some(h) = headers.get("x-relative-path").and_then(|v| v.to_str().ok())
    {
        decode_uri_component(h)
    } else if let Some(q) = query.path.as_deref() {
        q.to_owned()
    } else {
        "download".to_owned()
    };

    let rel_path = match sanitize_relative_path(&decoded_rel) {
        Ok(p) => p,
        Err(err) => return json_error(StatusCode::BAD_REQUEST, err),
    };
    let dl_root = resolve_downloads_dir();
    let parent = match export_parent(&dl_root, &rel_path) {
        Ok(p) => p,
        Err(err) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                format!("下载目录不安全或不可写: {err}"),
            );
        }
    };
    let desired_path = parent.join(rel_path.file_name().unwrap());
    let temp = match tempfile::NamedTempFile::new_in(&parent) {
        Ok(f) => f,
        Err(err) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };
    let file = match temp.reopen() {
        Ok(f) => tokio::fs::File::from_std(f),
        Err(err) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    };
    let mut writer = BufWriter::with_capacity(256 * 1024, file);
    let mut stream = body.into_data_stream();

    while let Some(chunk_res) = stream.next().await {
        match chunk_res {
            Ok(chunk) => {
                state.touch();
                if let Err(err) = writer.write_all(&chunk).await {
                    drop(writer);
                    return json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("写入下载文件失败: {err}"),
                    );
                }
            }
            Err(err) => {
                drop(writer);
                return json_error(StatusCode::BAD_REQUEST, format!("读取文件流中断: {err}"));
            }
        }
    }

    if let Err(err) = writer.flush().await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("刷盘失败: {err}"),
        );
    }
    if let Err(err) = writer.get_ref().sync_all().await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("同步文件失败: {err}"),
        );
    }
    drop(writer);
    // Persist without clobbering an existing output, including concurrent exports.
    let mut pending = temp;
    let mut collisions = 0;
    let final_path = loop {
        if collisions >= 64 {
            return json_error(StatusCode::CONFLICT, "Too many conflicting export names");
        }
        collisions += 1;
        let path = uniquify_target_path(&desired_path);
        match pending.persist_noclobber(&path) {
            Ok(_) => break path,
            Err(err) if err.error.kind() == std::io::ErrorKind::AlreadyExists => pending = err.file,
            Err(err) => {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, err.error.to_string());
            }
        }
    };

    let resp = serde_json::json!({
        "ok": true,
        "savedPath": final_path.to_string_lossy(),
    });
    with_cors(Json(resp).into_response())
}

/// `POST /fs/open`：使用操作系统原生资源管理器打开文件、高亮定位文件所在目录或打开下载文件夹。
pub async fn handle_fs_open(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<OpenFilePayload>,
) -> Response {
    state.touch();
    let dl_root = resolve_downloads_dir();

    match payload.action.as_str() {
        "open_folder" => {
            let folder = if let Some(sub) = payload.sub_dir.as_deref()
                && !sub.trim().is_empty()
            {
                resolve_in_root(&dl_root, sub, None)
                    .filter(|p| p.is_dir())
                    .unwrap_or(dl_root)
            } else {
                dl_root
            };
            if let Err(err) = open_folder_in_os(&folder) {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
            }
            with_cors(
                Json(serde_json::json!({
                    "ok": true,
                    "opened": true,
                    "path": folder.to_string_lossy(),
                }))
                .into_response(),
            )
        }
        "reveal_file" => {
            let target = payload
                .path
                .as_deref()
                .and_then(|p| resolve_existing_target(p, payload.sub_dir.as_deref()));

            if let Some(path) = target {
                if path.exists() {
                    if let Err(err) = reveal_file_in_os(&path) {
                        return json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
                    }
                    return with_cors(
                        Json(serde_json::json!({
                            "ok": true,
                            "revealed": true,
                            "path": path.to_string_lossy(),
                        }))
                        .into_response(),
                    );
                } else if let Some(parent) = path.parent()
                    && parent.exists()
                {
                    if let Err(err) = open_folder_in_os(parent) {
                        return json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
                    }
                    return with_cors(
                        Json(serde_json::json!({
                            "ok": true,
                            "revealed": true,
                            "path": parent.to_string_lossy(),
                        }))
                        .into_response(),
                    );
                }
            }

            if let Err(err) = open_folder_in_os(&dl_root) {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
            }
            with_cors(
                Json(serde_json::json!({
                    "ok": true,
                    "revealed": false,
                    "path": dl_root.to_string_lossy(),
                }))
                .into_response(),
            )
        }
        "open_file" => {
            let target = payload
                .path
                .as_deref()
                .and_then(|p| resolve_existing_target(p, payload.sub_dir.as_deref()));

            if let Some(path) = target
                && path.exists()
            {
                if let Err(err) = open_file_in_os(&path) {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
                }
                return with_cors(
                    Json(serde_json::json!({
                        "ok": true,
                        "opened": true,
                        "path": path.to_string_lossy(),
                    }))
                    .into_response(),
                );
            }

            if let Err(err) = open_folder_in_os(&dl_root) {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
            }
            with_cors(
                Json(serde_json::json!({
                    "ok": true,
                    "opened": false,
                    "path": dl_root.to_string_lossy(),
                }))
                .into_response(),
            )
        }
        other => json_error(StatusCode::BAD_REQUEST, format!("未知的 action: {other}")),
    }
}

/// `POST /fs/delete`：当用户在插件中勾选“同时删除系统下载目录中的已下载文件”时安全清理目标文件。
pub async fn handle_fs_delete(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<DeleteFilePayload>,
) -> Response {
    state.touch();
    let dl_root = resolve_downloads_dir();
    let mut deleted = false;

    if let Some(target) = resolve_existing_target(&payload.path, None)
        && target.exists()
        && target.is_file()
        && inside_root(&dl_root, &target).is_some()
    {
        deleted = tokio::fs::remove_file(&target).await.is_ok();
    }

    with_cors(
        Json(serde_json::json!({
            "ok": true,
            "deleted": deleted,
        }))
        .into_response(),
    )
}

fn open_folder_in_os(folder: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe").arg(folder).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open").arg(folder).spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(folder).spawn()?;
    }
    Ok(())
}

fn reveal_file_in_os(file_path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let canonical = dunce_norm(file_path);
        Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", canonical))
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg("-R")
            .arg(file_path)
            .spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        let uri = url::Url::from_file_path(file_path)
            .map_err(|_| std::io::Error::other("Invalid file URI"))?;
        let selected = Command::new("dbus-send")
            .args([
                "--session",
                "--print-reply",
                "--reply-timeout=1000",
                "--dest=org.freedesktop.FileManager1",
                "/org/freedesktop/FileManager1",
                "org.freedesktop.FileManager1.ShowItems",
                &format!("array:string:{uri}"),
                "string:",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if !selected.is_ok_and(|s| s.success()) {
            open_folder_in_os(file_path.parent().unwrap_or(file_path))?;
        }
    }
    Ok(())
}

fn open_file_in_os(file_path: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let canonical = dunce_norm(file_path);
        Command::new("explorer.exe").arg(canonical).spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open").arg(file_path).spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(file_path).spawn()?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn dunce_norm(p: &Path) -> String {
    p.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', r"\")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_absolute_escapes_and_sibling_prefixes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Downloads");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("good.txt"), "good").unwrap();
        let outside = temp.path().join("outside.txt");
        std::fs::write(&outside, "sentinel").unwrap();
        let sibling = temp.path().join("Downloads-other");
        std::fs::create_dir(&sibling).unwrap();
        std::fs::write(sibling.join("outside.txt"), "sentinel").unwrap();
        assert!(resolve_in_root(&root, "../outside.txt", None).is_none());
        assert!(
            resolve_in_root(
                &root,
                &root.join("..").join("outside.txt").to_string_lossy(),
                None
            )
            .is_none()
        );
        assert!(resolve_in_root(&root, &outside.to_string_lossy(), None).is_none());
        assert!(
            resolve_in_root(&root, &sibling.join("outside.txt").to_string_lossy(), None).is_none()
        );
        assert_eq!(
            resolve_in_root(&root, "good.txt", None),
            Some(std::fs::canonicalize(root.join("good.txt")).unwrap())
        );
        assert!(outside.exists());
    }

    #[test]
    fn rejects_encoded_traversal_and_creates_only_safe_export_parents() {
        for path in [
            "../escape.bin",
            "a/../escape.bin",
            "a\\..\\escape.bin",
            "C:\\escape.bin",
            "/escape.bin",
            "\\\\server\\share\\escape.bin",
        ] {
            assert!(sanitize_relative_path(path).is_err(), "{path}");
        }
        assert!(sanitize_relative_path(&decode_uri_component("%2e%2e%2fescape.bin")).is_err());
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Downloads");
        let path = sanitize_relative_path("Tug/files/movie.bin").unwrap();
        let parent = export_parent(&root, &path).unwrap();
        assert!(parent.starts_with(std::fs::canonicalize(&root).unwrap()));
        assert!(parent.is_dir());
        std::fs::write(root.join("blocked"), "not a directory").unwrap();
        assert!(export_parent(&root, Path::new("blocked/file.bin")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_links_outside_downloads() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Downloads");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("sentinel"), "sentinel").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(resolve_in_root(&root, "link/sentinel", None).is_none());
        assert!(export_parent(&root, Path::new("link/export.bin")).is_err());
    }
}
