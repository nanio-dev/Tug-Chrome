#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

//! `tug-agent` (`Tug Agent`) —— Tug Web 浏览器插件专属的无状态本地协议代理服务。
//!
//! 模块划分：
//! - `config`: 端口、空闲超时、Host 名称、DHT 引导节点与公共 Tracker 常量
//! - `state`: 进程级共享状态 (`AppState`) 与 `librqbit::Session` 初始化
//! - `registry`: Windows `HKCU` 注册表按需检测浏览器并静默安装（Native Messaging Host + `tug-agent://` 协议）
//! - `native_messaging`: Chrome/Edge Native Messaging 标准输入输出（4 字节小端帧）循环
//! - `routes`: `/health`、`/register`、`/session/*` 等控制面 HTTP 路由
//! - `streamer`: `/webseed/{id}/{*tail}` BEP 19 HTTP Range (`206 Partial Content`) 分片流式读取
//! - `file_ops`: `/fs/export`、`/fs/open`、`/fs/delete` 零弹窗文件落盘与资源管理器交互

mod auth;
mod config;
mod file_ops;
mod native_messaging;
mod registry;
mod routes;
mod state;
mod streamer;
#[cfg(windows)]
mod windows_registry;

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use tokio::sync::{OnceCell, RwLock};

#[cfg(target_os = "windows")]
use crate::config::CREATE_NO_WINDOW;
use crate::config::{DEFAULT_PORT, IDLE_TIMEOUT_SECS};
use crate::file_ops::{handle_fs_delete, handle_fs_export, handle_fs_open};
use crate::native_messaging::{spawn_native_messaging_stdio_loop, write_native_messaging_frame};
use crate::registry::{maybe_migrate_to_app_dir, parse_cli_and_register};
use crate::routes::{
    handle_health, handle_options, handle_register, handle_session_peers, handle_start_session,
    handle_stop_session, handle_uninstall, json_error, with_cors,
};
use crate::state::{AppState, now_secs};
use crate::streamer::handle_webseed_stream;

fn startup_log(message: &str) {
    use std::io::Write;
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        let dir = std::path::PathBuf::from(base).join("TugAgent");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("startup.log");
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > 128 * 1024) {
            let _ = std::fs::remove_file(&path);
        }
        if let Ok(mut log) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(log, "[{}] {}", now_secs(), message);
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        startup_log(&format!("Startup failed: {err:#}"));
        if std::env::args().any(|a| a.starts_with("chrome-extension://") || a == "--native-stdio") {
            let _ = write_native_messaging_frame(
                &serde_json::json!({"ok": false, "type": "error", "message": format!("{err:#}")}),
            );
        }
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    let startup = std::time::Instant::now();
    startup_log(&format!(
        "Starting protocol {} from {}",
        auth::PROTOCOL_VERSION,
        std::env::current_exe()?.display()
    ));
    let args: Vec<String> = std::env::args().skip(1).collect();
    // A foreground service mode enables isolated integration tests/development,
    // without installing a host, migrating the binary, or changing the registry.
    let serve_only = args.iter().any(|a| a == "--serve-only");
    let isolated_install = args.iter().any(|a| a == "--isolated-install");
    if !serve_only && maybe_migrate_to_app_dir()? {
        return Ok(());
    }
    let (is_native_messaging, install_only) = if serve_only {
        (args.iter().any(|a| a == "--native-stdio"), false)
    } else {
        parse_cli_and_register()?
    };
    if install_only {
        if let Ok(exe_path) = std::env::current_exe() {
            let mut cmd = Command::new(exe_path);
            cmd.arg("--daemon");
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.spawn();
        }
        return Ok(());
    }
    let token = auth::native_token()?;

    // 检查 127.0.0.1:16899 是否已经有正在运行的 helper 实例
    let port = if serve_only || isolated_install {
        args.iter()
            .find_map(|a| a.strip_prefix("--port="))
            .map(str::parse::<u16>)
            .transpose()?
            .unwrap_or(DEFAULT_PORT)
    } else {
        DEFAULT_PORT
    };
    let target_addr = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port);
    let listener = match tokio::net::TcpListener::bind(target_addr).await {
        Ok(l) => l,
        Err(_) => {
            if is_native_messaging {
                let ready = serde_json::json!({
                    "ok": true,
                    "type": "ready",
                    "baseUrl": format!("http://127.0.0.1:{port}"),
                    "port": port,
                    "version": env!("CARGO_PKG_VERSION"),
                    "protocolVersion": auth::PROTOCOL_VERSION,
                    "token": token,
                });
                let _ = write_native_messaging_frame(&ready);
            }
            return Ok(());
        }
    };

    let bound_port = listener.local_addr()?.port();
    let stage_root = std::env::temp_dir().join("tug-agent-stage");
    let _ = std::fs::remove_dir_all(&stage_root);
    std::fs::create_dir_all(&stage_root)?;

    let state = Arc::new(AppState {
        bt_session: OnceCell::new(),
        bt_networking: !serve_only && !isolated_install,
        stage_root: stage_root.clone(),
        entries: RwLock::new(HashMap::new()),
        last_activity_secs: AtomicU64::new(now_secs()),
        native_stdin_active: AtomicBool::new(false),
        shutting_down: AtomicBool::new(false),
        active_operations: AtomicU64::new(0),
        bound_port,
    });

    if is_native_messaging {
        spawn_native_messaging_stdio_loop(state.clone());
    }

    let idle_timeout = if serve_only || isolated_install {
        args.iter()
            .find_map(|a| a.strip_prefix("--idle-timeout="))
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(IDLE_TIMEOUT_SECS)
    } else {
        IDLE_TIMEOUT_SECS
    };
    // 空闲自动退出巡检协程：当无活跃种子且超过 120 秒无请求时自动清理临时目录并退出进程
    let idle_state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let active_count = idle_state.entries.read().await.len();
            if active_count > 0 || idle_state.active_operations.load(Ordering::Relaxed) > 0 {
                idle_state.touch();
                continue;
            }
            let elapsed =
                now_secs().saturating_sub(idle_state.last_activity_secs.load(Ordering::Relaxed));
            if elapsed >= idle_timeout {
                let _ = std::fs::remove_dir_all(&idle_state.stage_root);
                std::process::exit(0);
            }
        }
    });

    let app = Router::new()
        .route("/health", get(handle_health).options(handle_options))
        .route("/register", post(handle_register).options(handle_options))
        .route(
            "/session/start",
            post(handle_start_session).options(handle_options),
        )
        .route(
            "/session/{id}/peers",
            get(handle_session_peers).options(handle_options),
        )
        .route(
            "/session/{id}/stop",
            post(handle_stop_session).options(handle_options),
        )
        .route(
            "/webseed/{id}/{*tail}",
            get(handle_webseed_stream).options(handle_options),
        )
        .route("/fs/export", post(handle_fs_export).options(handle_options))
        .route("/fs/open", post(handle_fs_open).options(handle_options))
        .route("/fs/delete", post(handle_fs_delete).options(handle_options))
        .route("/uninstall", post(handle_uninstall).options(handle_options))
        .fallback(|method: Method| async move {
            if method == Method::OPTIONS {
                with_cors(StatusCode::NO_CONTENT.into_response())
            } else {
                json_error(StatusCode::NOT_FOUND, "Not found")
            }
        })
        .with_state(state)
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(auth::Authorization::new(token)),
            auth::authorize,
        ));

    startup_log(&format!(
        "Listening on {bound_port}, ready in {} ms; BT initializes on demand",
        startup.elapsed().as_millis()
    ));
    axum::serve(listener, app).await?;
    Ok(())
}
