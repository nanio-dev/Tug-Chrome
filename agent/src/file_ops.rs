//! 本地文件系统辅助接口（零弹窗流式文件落盘、Explorer 目录定位、系统默认程序打开与安全删除）。
//!
//! 设计目的：
//! 1. 解决浏览器 `chrome.downloads.download(blob:...)` 在开启“下载前询问保存位置”时弹出 `blob:chrome-extension://...` 确认框的问题；
//! 2. 解决浏览器沙箱内 `chrome.downloads.open` / `show` 因异步 RPC 丢失 User Gesture 导致点击“打开文件 / 在文件夹中显示”无响应的问题。

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
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

#[cfg(target_os = "windows")]
use crate::config::CREATE_NO_WINDOW;
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

/// 获取当前用户的系统 `Downloads` 下载目录。
pub fn resolve_downloads_dir() -> PathBuf {
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let dl = PathBuf::from(profile).join("Downloads");
        if dl.exists() {
            return dl;
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let dl = PathBuf::from(home).join("Downloads");
        if dl.exists() {
            return dl;
        }
    }
    std::env::temp_dir()
}

/// 清理相对路径中的非法字符与目录穿越片段（`..`、`.`）。
fn sanitize_relative_path(raw: &str) -> PathBuf {
    let mut clean = PathBuf::new();
    for seg in raw.replace('\\', "/").split('/') {
        let trimmed = seg.trim();
        if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
            continue;
        }
        let safe_seg: String = trimmed
            .chars()
            .map(|c| match c {
                '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0' => '_',
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
    clean
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
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return None;
    }

    let direct = PathBuf::from(trimmed);
    if direct.is_absolute() && direct.exists() {
        return Some(direct);
    }

    let dl_root = resolve_downloads_dir();
    let rel = sanitize_relative_path(trimmed);
    let in_root = dl_root.join(&rel);
    if in_root.exists() {
        return Some(in_root);
    }

    if let Some(sub) = sub_dir {
        let clean_sub = sanitize_relative_path(sub);
        let in_sub = dl_root.join(clean_sub).join(&rel);
        if in_sub.exists() {
            return Some(in_sub);
        }
    }

    if let Some(file_name) = rel.file_name() {
        let flat = dl_root.join(file_name);
        if flat.exists() {
            return Some(flat);
        }
    }

    if direct.is_absolute() {
        Some(direct)
    } else {
        Some(in_root)
    }
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
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
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
    state.touch();

    let decoded_rel = if let Some(h) = headers.get("x-relative-path").and_then(|v| v.to_str().ok()) {
        decode_uri_component(h)
    } else if let Some(q) = query.path.as_deref() {
        q.to_owned()
    } else {
        "download".to_owned()
    };

    let rel_path = sanitize_relative_path(&decoded_rel);
    let dl_root = resolve_downloads_dir();
    let desired_path = dl_root.join(rel_path);

    if let Some(parent) = desired_path.parent()
        && let Err(err) = tokio::fs::create_dir_all(parent).await
    {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("创建下载目录失败: {err}"),
        );
    }

    let final_path = uniquify_target_path(&desired_path);
    let file = match tokio::fs::File::create(&final_path).await {
        Ok(f) => f,
        Err(err) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("创建目标文件失败: {err}"),
            );
        }
    };

    let mut writer = BufWriter::with_capacity(256 * 1024, file);
    let mut stream = body.into_data_stream();

    while let Some(chunk_res) = stream.next().await {
        match chunk_res {
            Ok(chunk) => {
                if let Err(err) = writer.write_all(&chunk).await {
                    let _ = tokio::fs::remove_file(&final_path).await;
                    return json_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("写入下载文件失败: {err}"),
                    );
                }
            }
            Err(err) => {
                let _ = tokio::fs::remove_file(&final_path).await;
                return json_error(
                    StatusCode::BAD_REQUEST,
                    format!("读取文件流中断: {err}"),
                );
            }
        }
    }

    if let Err(err) = writer.flush().await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("刷盘失败: {err}"),
        );
    }

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
                let sub_path = dl_root.join(sanitize_relative_path(sub));
                if sub_path.exists() { sub_path } else { dl_root }
            } else {
                dl_root
            };
            open_folder_in_os(&folder);
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
                    reveal_file_in_os(&path);
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
                    open_folder_in_os(parent);
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

            open_folder_in_os(&dl_root);
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
                open_file_in_os(&path);
                return with_cors(
                    Json(serde_json::json!({
                        "ok": true,
                        "opened": true,
                        "path": path.to_string_lossy(),
                    }))
                    .into_response(),
                );
            }

            open_folder_in_os(&dl_root);
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
        && target.starts_with(&dl_root)
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

fn open_folder_in_os(folder: &Path) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("explorer.exe").arg(folder).spawn();
    }
}

fn reveal_file_in_os(file_path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let canonical = dunce_norm(file_path);
        let _ = Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", canonical))
            .spawn();
    }
}

fn open_file_in_os(file_path: &Path) {
    #[cfg(target_os = "windows")]
    {
        let canonical = dunce_norm(file_path);
        let _ = Command::new("cmd.exe")
            .arg("/C")
            .raw_arg(format!("start \"\" \"{}\"", canonical))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
}

#[cfg(target_os = "windows")]
fn dunce_norm(p: &Path) -> String {
    p.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('/', r"\")
}
