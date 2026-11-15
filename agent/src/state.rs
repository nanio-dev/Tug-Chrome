//! 全局运行时状态与 `librqbit` 会话初始化。

use std::collections::HashMap;
use std::net::{Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use librqbit::{DhtSessionConfig, ListenerOptions, ManagedTorrent, Session, SessionOptions};
use tokio::sync::{OnceCell, RwLock};

use crate::config::DHT_BOOTSTRAP;

/// 单个活跃的受管 BT 临时会话条目。
pub struct ManagedSessionEntry {
    pub handle: Arc<ManagedTorrent>,
    pub stage_dir: PathBuf,
}

/// 进程级共享状态，供 Axum 路由与后台空闲巡检任务访问。
pub struct AppState {
    pub bt_session: OnceCell<Arc<Session>>,
    pub bt_networking: bool,
    pub stage_root: PathBuf,
    pub entries: RwLock<HashMap<usize, ManagedSessionEntry>>,
    pub last_activity_secs: AtomicU64,
    pub native_stdin_active: AtomicBool,
    pub shutting_down: AtomicBool,
    pub active_operations: AtomicU64,
    pub bound_port: u16,
}

pub struct ActiveOperation<'a>(&'a AtomicU64);
impl Drop for ActiveOperation<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

impl AppState {
    pub fn begin_operation(&self) -> ActiveOperation<'_> {
        self.touch();
        self.active_operations.fetch_add(1, Ordering::Relaxed);
        ActiveOperation(&self.active_operations)
    }
    pub async fn bt_session(&self) -> anyhow::Result<&Arc<Session>> {
        self.bt_session
            .get_or_try_init(|| init_bt_session(self.stage_root.clone(), self.bt_networking))
            .await
    }

    /// 刷新最近一次请求活跃时间，重置空闲自动退出计时器。
    pub fn touch(&self) {
        self.last_activity_secs.store(now_secs(), Ordering::Relaxed);
    }
}

/// 获取当前 Unix 秒级时间戳。
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 生成简单的伪随机无符号整数，用于临时缓存子目录命名。
pub fn rand_u32() -> u32 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(12345);
    nanos.wrapping_mul(1664525).wrapping_add(1013904223)
}

/// 创建无状态 `librqbit::Session`（禁用持久化与 UPnP 阻塞，启用 DHT 与 TCP/uTP 监听）。
pub async fn init_bt_session(
    stage_root: PathBuf,
    networking: bool,
) -> anyhow::Result<Arc<Session>> {
    let session_opts = SessionOptions {
        fastresume: false,
        persistence: None,
        dht: networking.then(|| DhtSessionConfig {
            bootstrap_addrs: Some(DHT_BOOTSTRAP.iter().map(|s| (*s).to_owned()).collect()),
            ..Default::default()
        }),
        listen: networking.then(|| ListenerOptions {
            listen_addr: SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), 0),
            enable_upnp_port_forwarding: false,
            ..Default::default()
        }),
        peer_limit: Some(150),
        disable_trackers: !networking,
        disable_local_service_discovery: !networking,
        client_name_and_version: Some(format!("TugAgent/{}", env!("CARGO_PKG_VERSION"))),
        ..Default::default()
    };

    Session::new_with_opts(stage_root, session_opts)
        .await
        .context("初始化 librqbit 会话失败")
}
