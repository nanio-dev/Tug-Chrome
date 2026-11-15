//! 全局常量与默认网络配置（端口、超时、Host 标识、DHT 与公共 Tracker 列表）。

/// Chrome / Edge Native Messaging Host 唯一注册名（对齐 nanio.cc 域名）。
pub const HOST_NAME: &str = "cc.nanio.tug.agent";

/// 自定义 URL 协议名称（tug-agent://）。
pub const PROTOCOL_SCHEME: &str = "tug-agent";

/// 本地无状态 HTTP 网关默认监听端口。
pub const DEFAULT_PORT: u16 = 16899;

/// 当无活跃 BT 会话且超过该秒数无 HTTP 请求时，进程自动清理临时目录并退出。
pub const IDLE_TIMEOUT_SECS: u64 = 120;

/// Windows `CREATE_NO_WINDOW` 进程创建标志，防止调用系统子命令（如 `reg.exe` / `cmd.exe`）时弹出黑框。
#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// DHT 引导节点列表（对齐 Tug Desktop `tug-torrent` 配置）。
pub const DHT_BOOTSTRAP: &[&str] = &[
    "dht.transmissionbt.com:6881",
    "dht.libtorrent.org:25401",
    "router.bittorrent.com:6881",
    "router.utorrent.com:6881",
    "dht.aelitis.com:6881",
];

/// 磁力链接缺少 `tr=` 参数时自动追加的预编码公共 UDP Tracker。
pub const DEFAULT_MAGNET_TRACKERS_ENCODED: &[&str] = &[
    "udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce",
    "udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce",
    "udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce",
    "udp%3A%2F%2Ftracker.openbittorrent.com%3A6969%2Fannounce",
];

/// 为 `.torrent` 或磁力会话默认合并的公共 UDP Tracker 列表。
pub const DEFAULT_EXTRA_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://exodus.desync.com:6969/announce",
];
