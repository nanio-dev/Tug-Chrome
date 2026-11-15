//! Axum HTTP 路由处理器（健康检查、扩展 ID 绑定、BT 会话生命周期管理）与 CORS 工具。

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STD;
use librqbit::api::TorrentIdOrHash;
use librqbit::{AddTorrent, AddTorrentOptions, AddTorrentResponse};
use serde::{Deserialize, Serialize};

use crate::config::{DEFAULT_EXTRA_TRACKERS, DEFAULT_MAGNET_TRACKERS_ENCODED, HOST_NAME};
use crate::registry::{install_and_register, uninstall_self};
use crate::state::{AppState, ManagedSessionEntry, now_secs, rand_u32};

pub fn cors_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Range, Content-Length, Accept-Ranges"),
    );
    headers
}

pub fn with_cors(mut resp: Response) -> Response {
    let h = resp.headers_mut();
    for (k, v) in cors_headers() {
        if let Some(name) = k {
            h.insert(name, v);
        }
    }
    resp
}

pub fn json_error(status: StatusCode, msg: impl Into<String>) -> Response {
    let body = serde_json::json!({
        "ok": false,
        "error": msg.into(),
    });
    with_cors((status, Json(body)).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterPayload {
    pub ext_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionPayload {
    pub url: Option<String>,
    pub torrent_bytes_base64: Option<String>,
    pub trackers: Option<Vec<String>>,
    pub only_files: Option<Vec<usize>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionResponse {
    pub ok: bool,
    pub session_id: String,
    pub info_hash: String,
    pub name: String,
    pub total_bytes: u64,
    pub torrent_bytes_base64: String,
    pub web_seed_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerDto {
    pub addr: String,
    pub state: String,
    pub client: Option<String>,
    pub downloaded_bytes: u64,
    pub uploaded_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerDto {
    pub url: String,
    pub protocol: String,
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPeersResponse {
    pub ok: bool,
    pub state: String,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    pub download_speed_bytes: u64,
    pub upload_speed_bytes: u64,
    pub finished: bool,
    pub error: Option<String>,
    pub peers: Vec<PeerDto>,
    pub trackers: Vec<TrackerDto>,
}

pub async fn handle_options() -> Response {
    with_cors(StatusCode::NO_CONTENT.into_response())
}

pub async fn handle_health(State(state): State<Arc<AppState>>) -> Response {
    let count = state.entries.read().await.len();
    let body = serde_json::json!({
        "ok": true,
        "service": "tug-agent",
        "version": env!("CARGO_PKG_VERSION"),
        "hostName": HOST_NAME,
        "port": state.bound_port,
        "activeSessions": count,
        "protocolVersion": crate::auth::PROTOCOL_VERSION,
        "authRequired": true,
        "btInitialized": state.bt_session.get().is_some(),
        "capabilities": ["torrent", "file_export", "file_operations"],
    });
    with_cors(Json(body).into_response())
}

pub async fn handle_register(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RegisterPayload>,
) -> Response {
    state.touch();
    let ext_id = payload.ext_id.trim();
    if !crate::auth::valid_extension_id(ext_id) {
        return json_error(StatusCode::BAD_REQUEST, "Invalid extension ID");
    }
    match install_and_register(Some(ext_id), false) {
        Ok(manifest_path) => {
            let body = serde_json::json!({
                "ok": true,
                "extId": ext_id,
                "manifestPath": manifest_path.to_string_lossy(),
            });
            with_cors(Json(body).into_response())
        }
        Err(err) => json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn prepare_magnet_with_trackers(url: &str, extra_trackers: &[String]) -> String {
    if !url.to_ascii_lowercase().starts_with("magnet:?") {
        return url.to_owned();
    }
    let mut out = url.to_owned();
    if !out.contains("tr=") {
        for tr in DEFAULT_MAGNET_TRACKERS_ENCODED {
            out.push_str("&tr=");
            out.push_str(tr);
        }
    }
    for tr in extra_trackers {
        let trimmed = tr.trim();
        if trimmed.starts_with("udp://")
            || trimmed.starts_with("http://")
            || trimmed.starts_with("https://")
        {
            let encoded: String =
                url::form_urlencoded::byte_serialize(trimmed.as_bytes()).collect();
            out.push_str("&tr=");
            out.push_str(&encoded);
        }
    }
    out
}

pub async fn handle_start_session(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<StartSessionPayload>,
) -> Response {
    let _operation = state.begin_operation();

    let extra_trackers = payload.trackers.unwrap_or_default();
    let prepared_url: String;
    let add_source = if let Some(b64) = payload
        .torrent_bytes_base64
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        match BASE64_STD.decode(b64) {
            Ok(bytes) => AddTorrent::from_bytes(bytes),
            Err(err) => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    format!("解码 torrentBytesBase64 失败: {err}"),
                );
            }
        }
    } else if let Some(raw_url) = payload
        .url
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        prepared_url = prepare_magnet_with_trackers(raw_url, &extra_trackers);
        match AddTorrent::from_cli_argument(&prepared_url) {
            Ok(src) => src,
            Err(err) => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    format!("无效的种子/磁力来源: {err}"),
                );
            }
        }
    } else {
        return json_error(StatusCode::BAD_REQUEST, "缺少 url 或 torrentBytesBase64");
    };

    let stage_subdir = state
        .stage_root
        .join(format!("s-{}-{}", now_secs(), rand_u32()));
    let _ = std::fs::create_dir_all(&stage_subdir);

    let mut merged_trackers: Vec<String> = DEFAULT_EXTRA_TRACKERS
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    for tr in &extra_trackers {
        let trimmed = tr.trim();
        if (trimmed.starts_with("udp://")
            || trimmed.starts_with("http://")
            || trimmed.starts_with("https://"))
            && !merged_trackers.iter().any(|existing| existing == trimmed)
        {
            merged_trackers.push(trimmed.to_owned());
        }
    }

    let add_opts = AddTorrentOptions {
        overwrite: true,
        only_files: payload.only_files.clone(),
        output_folder: Some(stage_subdir.to_string_lossy().into_owned()),
        trackers: Some(merged_trackers),
        ..Default::default()
    };

    let bt_session = match tokio::time::timeout(Duration::from_secs(15), state.bt_session()).await {
        Ok(Ok(session)) => session,
        Ok(Err(err)) => {
            return json_error(StatusCode::BAD_GATEWAY, format!("BT 初始化失败: {err:#}"));
        }
        Err(_) => return json_error(StatusCode::GATEWAY_TIMEOUT, "BT 初始化超时"),
    };
    let add_resp = match tokio::time::timeout(
        Duration::from_secs(55),
        bt_session.add_torrent(add_source, Some(add_opts)),
    )
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(err)) => {
            let _ = std::fs::remove_dir_all(&stage_subdir);
            return json_error(
                StatusCode::BAD_GATEWAY,
                format!("本地 BT 引擎添加任务失败: {err:#}"),
            );
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&stage_subdir);
            return json_error(
                StatusCode::GATEWAY_TIMEOUT,
                "本地 BT 引擎解析磁力元数据超时（DHT / Tracker 未找到可用节点）",
            );
        }
    };

    let (id, handle) = match add_resp {
        AddTorrentResponse::Added(id, h) | AddTorrentResponse::AlreadyManaged(id, h) => (id, h),
        AddTorrentResponse::ListOnly(_) => {
            let _ = std::fs::remove_dir_all(&stage_subdir);
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Unexpected list-only mode",
            );
        }
    };

    let _ = tokio::time::timeout(Duration::from_secs(15), handle.wait_until_initialized()).await;

    let info_hash = handle.info_hash().as_string();
    let name = handle.name().unwrap_or_else(|| format!("torrent-{id}"));
    let total_bytes = handle.stats().total_bytes;
    let torrent_bytes = handle
        .with_metadata(|m| m.torrent_bytes.to_vec())
        .unwrap_or_default();
    let torrent_bytes_base64 = BASE64_STD.encode(&torrent_bytes);

    state.entries.write().await.insert(
        id,
        ManagedSessionEntry {
            handle: handle.clone(),
            stage_dir: stage_subdir,
        },
    );

    let resp = StartSessionResponse {
        ok: true,
        session_id: id.to_string(),
        info_hash,
        name,
        total_bytes,
        torrent_bytes_base64,
        web_seed_url: format!("http://127.0.0.1:{}/webseed/{id}/", state.bound_port),
    };
    with_cors(Json(resp).into_response())
}

pub async fn handle_session_peers(
    State(state): State<Arc<AppState>>,
    Path(id): Path<usize>,
) -> Response {
    state.touch();
    let handle = {
        let guard = state.entries.read().await;
        match guard.get(&id) {
            Some(entry) => entry.handle.clone(),
            None => return json_error(StatusCode::NOT_FOUND, format!("Session {id} not found")),
        }
    };

    let stats = handle.stats();
    let (download_speed_bytes, upload_speed_bytes) = stats.live.as_ref().map_or((0, 0), |live| {
        (live.download_speed.as_bytes(), live.upload_speed.as_bytes())
    });

    let mut peers = handle
        .live()
        .map(|live| {
            let snapshot = live.per_peer_stats_snapshot(Default::default());
            snapshot
                .peers
                .into_iter()
                .map(|(address, peer)| PeerDto {
                    addr: address,
                    state: peer.state.to_owned(),
                    client: peer.client_name,
                    downloaded_bytes: peer.counters.fetched_bytes,
                    uploaded_bytes: peer.counters.uploaded_bytes,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    peers.sort_by_key(|p| std::cmp::Reverse(p.downloaded_bytes));

    let trackers = handle
        .shared()
        .trackers
        .iter()
        .map(|u| {
            let s = u.to_string();
            let proto = if s.starts_with("udp://") {
                "udp"
            } else if s.starts_with("https://") {
                "https"
            } else {
                "http"
            };
            TrackerDto {
                url: s,
                protocol: proto.to_owned(),
                status: "active".to_owned(),
            }
        })
        .collect::<Vec<_>>();

    let resp = SessionPeersResponse {
        ok: true,
        state: stats.state.to_string(),
        progress_bytes: stats.progress_bytes,
        total_bytes: stats.total_bytes,
        download_speed_bytes,
        upload_speed_bytes,
        finished: stats.finished,
        error: stats.error,
        peers,
        trackers,
    };
    with_cors(Json(resp).into_response())
}

pub async fn handle_stop_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<usize>,
) -> Response {
    state.touch();
    let removed = state.entries.write().await.remove(&id);
    if let Some(session) = state.bt_session.get() {
        let _ = session.delete(TorrentIdOrHash::Id(id), true).await;
    }
    if let Some(entry) = removed {
        let _ = std::fs::remove_dir_all(&entry.stage_dir);
    }
    let body = serde_json::json!({
        "ok": true,
        "sessionId": id.to_string(),
    });
    with_cors(Json(body).into_response())
}

pub async fn handle_uninstall(State(state): State<Arc<AppState>>) -> Response {
    if state
        .shutting_down
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return json_error(StatusCode::CONFLICT, "Agent is shutting down");
    }
    {
        let mut entries = state.entries.write().await;
        let ids: Vec<usize> = entries.keys().copied().collect();
        for id in ids {
            if let Some(session) = state.bt_session.get() {
                let _ = session.delete(TorrentIdOrHash::Id(id), true).await;
            }
            entries.remove(&id);
        }
    }
    if let Err(err) = uninstall_self() {
        state
            .shutting_down
            .store(false, std::sync::atomic::Ordering::SeqCst);
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("卸载未完成: {err:#}"),
        );
    }
    crate::auth::remove_token();
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(250)).await;
        std::process::exit(0);
    });
    with_cors(Json(serde_json::json!({ "ok": true })).into_response())
}
