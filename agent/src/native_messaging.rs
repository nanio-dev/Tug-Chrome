//! Chrome / Edge Native Messaging 标准输入输出（4 字节小端长度前缀 + JSON 负载）协议循环。

use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::registry::install_and_register;
use crate::state::AppState;

/// 向 `stdout` 写入一帧符合 Chrome Native Messaging 规范的 JSON 消息。
pub fn write_native_messaging_frame(msg: &serde_json::Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(msg)?;
    let len = bytes.len() as u32;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&len.to_le_bytes())?;
    stdout.write_all(&bytes)?;
    stdout.flush()
}

/// 启动后台线程监听来自浏览器 `connectNative` 的 `stdin` 消息帧并响应 `ready` / `pong`。
pub fn spawn_native_messaging_stdio_loop(state: Arc<AppState>) {
    std::thread::spawn(move || {
        state.native_stdin_active.store(true, Ordering::Relaxed);
        let ready = serde_json::json!({
            "ok": true,
            "type": "ready",
            "baseUrl": format!("http://127.0.0.1:{}", state.bound_port),
            "port": state.bound_port,
            "version": env!("CARGO_PKG_VERSION"),
            "protocolVersion": crate::auth::PROTOCOL_VERSION,
            "token": crate::auth::native_token().ok(),
        });
        let _ = write_native_messaging_frame(&ready);

        let mut stdin = std::io::stdin().lock();
        let mut len_buf = [0u8; 4];
        while stdin.read_exact(&mut len_buf).is_ok() {
            if state.shutting_down.load(Ordering::Relaxed) {
                break;
            }
            state.touch();
            let msg_len = u32::from_le_bytes(len_buf) as usize;
            if msg_len == 0 || msg_len > 4 * 1024 * 1024 {
                break;
            }
            let mut payload = vec![0u8; msg_len];
            if stdin.read_exact(&mut payload).is_err() {
                break;
            }
            if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&payload)
                && let Some(ext_id) = json.get("extId").and_then(|v| v.as_str())
            {
                let _ = install_and_register(Some(ext_id), false);
            }
            if state.shutting_down.load(Ordering::Relaxed) {
                break;
            }
            let pong = serde_json::json!({
                "ok": true,
                "type": "pong",
                "baseUrl": format!("http://127.0.0.1:{}", state.bound_port),
                "port": state.bound_port,
                "protocolVersion": crate::auth::PROTOCOL_VERSION,
                "token": crate::auth::native_token().ok(),
            });
            let _ = write_native_messaging_frame(&pong);
        }
        state.native_stdin_active.store(false, Ordering::Relaxed);
    });
}
