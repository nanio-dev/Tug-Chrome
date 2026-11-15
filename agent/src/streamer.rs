//! BEP 19 HTTP WebSeed 协议网关流式接口。
//!
//! 将 `librqbit::ManagedTorrent::stream(file_id)` 包装为支持标准 HTTP Range (`206 Partial Content`)
//! 的异步字节流，供浏览器扩展按需拉取任意 Piece 区间并执行 SHA-1 校验。

use std::io::SeekFrom;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use bytes::Bytes;
use librqbit::ManagedTorrent;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::routes::{cors_headers, json_error};
use crate::state::AppState;

fn normalize_slashes(s: &str) -> String {
    s.replace('\\', "/").trim_matches('/').to_owned()
}

/// 根据 URL 尾路径映射种子内的目标 `file_id`。
pub fn resolve_file_id_from_tail(handle: &Arc<ManagedTorrent>, tail: &str) -> usize {
    let clean_tail = normalize_slashes(tail);
    if let Some(idx_str) = clean_tail.strip_prefix("__file__/")
        && let Ok(idx) = idx_str.parse::<usize>()
    {
        return idx;
    }

    let decoded_segments: Vec<String> = clean_tail
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|seg| {
            url::form_urlencoded::parse(seg.as_bytes())
                .map(|(k, v)| if v.is_empty() { k.into_owned() } else { format!("{k}={v}") })
                .next()
                .unwrap_or_else(|| seg.to_owned())
        })
        .collect();
    let decoded_full = decoded_segments.join("/");
    let decoded_without_root = if decoded_segments.len() > 1 {
        decoded_segments[1..].join("/")
    } else {
        decoded_full.clone()
    };

    handle
        .with_metadata(|meta| {
            if meta.file_infos.len() <= 1 {
                return 0;
            }
            for (idx, fi) in meta.file_infos.iter().enumerate() {
                let rel = normalize_slashes(&fi.relative_filename.to_string_lossy());
                if rel == decoded_without_root
                    || rel == decoded_full
                    || decoded_full.ends_with(&format!("/{rel}"))
                {
                    return idx;
                }
            }
            0
        })
        .unwrap_or(0)
}

/// `GET /webseed/{id}/{*tail}`：按 HTTP Range 流式输出目标文件分片。
pub async fn handle_webseed_stream(
    State(state): State<Arc<AppState>>,
    Path((id, tail)): Path<(usize, String)>,
    headers: HeaderMap,
) -> Response {
    state.touch();
    let handle = {
        let guard = state.entries.read().await;
        match guard.get(&id) {
            Some(entry) => entry.handle.clone(),
            None => return json_error(StatusCode::NOT_FOUND, format!("Session {id} not found")),
        }
    };

    let file_id = resolve_file_id_from_tail(&handle, &tail);
    let mut stream = match handle.clone().stream(file_id).await {
        Ok(s) => s,
        Err(err) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("打开 BT 文件流失败: {err:#}"),
            );
        }
    };

    let file_len = stream.len();
    let range_header = headers.get(header::RANGE);
    let parsed_range = range_header
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| v.split_once('-'))
        .and_then(|(start_s, end_s)| {
            let start = start_s.parse::<u64>().ok()?;
            let end_exclusive = if end_s.is_empty() {
                file_len
            } else {
                end_s.parse::<u64>().ok()?.saturating_add(1).min(file_len)
            };
            Some((start, end_exclusive))
        });

    let mut out_headers = cors_headers();
    out_headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    out_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );

    let (status, reader): (StatusCode, Box<dyn AsyncRead + Send + Unpin>) =
        if let Some((start, end_exclusive)) = parsed_range {
            if start >= file_len || end_exclusive <= start {
                return json_error(StatusCode::RANGE_NOT_SATISFIABLE, "Invalid Range");
            }
            if let Err(err) = stream.seek(SeekFrom::Start(start)).await {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Seek 失败: {err}"),
                );
            }
            let to_take = end_exclusive - start;
            out_headers.insert(
                header::CONTENT_LENGTH,
                HeaderValue::from_maybe_shared(Bytes::from(to_take.to_string())).unwrap(),
            );
            out_headers.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_maybe_shared(Bytes::from(format!(
                    "bytes {}-{}/{}",
                    start,
                    end_exclusive.saturating_sub(1),
                    file_len
                )))
                .unwrap(),
            );
            (StatusCode::PARTIAL_CONTENT, Box::new(stream.take(to_take)))
        } else {
            out_headers.insert(
                header::CONTENT_LENGTH,
                HeaderValue::from_maybe_shared(Bytes::from(file_len.to_string())).unwrap(),
            );
            (StatusCode::OK, Box::new(stream))
        };

    let body_stream = ReaderStream::with_capacity(reader, 64 * 1024);
    let mut resp = Response::new(Body::from_stream(body_stream));
    *resp.status_mut() = status;
    *resp.headers_mut() = out_headers;
    resp
}
