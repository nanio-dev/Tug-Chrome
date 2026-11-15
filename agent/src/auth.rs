//! The capability token is delivered over browser-validated Native Messaging only.
//! HTTP never returns it. The file is per-user, shared with short-lived native hosts.
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const TOKEN_HEADER: &str = "x-tug-agent-token";
pub const PROTOCOL_VERSION: u32 = 2;

pub fn valid_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}
fn extension_origin(origin: &str) -> bool {
    origin
        .strip_prefix("chrome-extension://")
        .is_some_and(valid_extension_id)
}
fn token_path() -> anyhow::Result<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| anyhow::anyhow!("Missing per-user application directory"))?;
    Ok(PathBuf::from(base).join("TugAgent").join("auth-token"))
}
pub fn native_token() -> anyhow::Result<String> {
    token_at(&token_path()?)
}
fn read_token(path: &Path) -> anyhow::Result<String> {
    let token = std::fs::read_to_string(path)?;
    anyhow::ensure!(
        token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid Agent authorization file"
    );
    Ok(token)
}
fn token_at(path: &Path) -> anyhow::Result<String> {
    if path.exists() {
        return read_token(path);
    }
    std::fs::create_dir_all(path.parent().unwrap())?;
    let mut random = [0u8; 32];
    getrandom::fill(&mut random)
        .map_err(|err| anyhow::anyhow!("OS randomness unavailable: {err}"))?;
    let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
    // Publish a complete capability atomically. A concurrent native host either
    // wins publication or reads the winner; no process observes a partial token.
    let mut pending = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    pending.write_all(token.as_bytes())?;
    pending.as_file().sync_all()?;
    match pending.persist_noclobber(path) {
        Ok(_) => Ok(token),
        Err(err) if err.error.kind() == std::io::ErrorKind::AlreadyExists => read_token(path),
        Err(err) => Err(err.error.into()),
    }
}
pub fn remove_token() {
    if let Ok(path) = token_path() {
        let _ = std::fs::remove_file(path);
    }
}

pub struct Authorization {
    pub token: String,
}
impl Authorization {
    pub fn new(token: String) -> Self {
        Self { token }
    }
    fn accepts(&self, value: &str) -> bool {
        // Do not expose token contents or distinguish the first differing byte.
        value.len() == self.token.len()
            && value
                .bytes()
                .zip(self.token.bytes())
                .fold(0u8, |d, (a, b)| d | (a ^ b))
                == 0
    }
}

pub async fn authorize(
    State(auth): State<Arc<Authorization>>,
    request: Request,
    next: Next,
) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned);
    if origin.as_deref().is_some_and(|o| !extension_origin(o)) {
        return (StatusCode::FORBIDDEN, "Extension origin required").into_response();
    }
    let preflight = request.method() == Method::OPTIONS;
    let supplied = request
        .headers()
        .get(TOKEN_HEADER)
        .and_then(|h| h.to_str().ok());
    let health = request.uri().path() == "/health" && request.method() == Method::GET;
    let denied =
        !preflight && (!health || supplied.is_some()) && !supplied.is_some_and(|t| auth.accepts(t));
    let mut response = if denied {
        (
            StatusCode::UNAUTHORIZED,
            "Native Messaging authorization required",
        )
            .into_response()
    } else if preflight {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    if let Some(origin) = origin {
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_str(&origin).unwrap(),
        );
    }
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "Content-Type, Range, If-Range, X-Relative-Path, X-Tug-Agent-Token",
        ),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Range, Content-Length, Accept-Ranges"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, middleware, routing::get};
    use tower::ServiceExt;
    #[test]
    fn native_hosts_share_one_complete_random_capability() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("auth-token");
        let hosts: Vec<_> = (0..16)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || token_at(&path).unwrap())
            })
            .collect();
        let tokens: Vec<_> = hosts.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(tokens.iter().all(|token| token == &tokens[0]));
        assert_eq!(tokens[0].len(), 64);
        assert_eq!(read_token(&path).unwrap(), tokens[0]);
    }
    fn app() -> Router {
        Router::new()
            .route("/health", get(|| async { "healthy" }))
            .route("/fs/delete", axum::routing::post(|| async { "deleted" }))
            .layer(middleware::from_fn_with_state(
                Arc::new(Authorization::new("test-secret".into())),
                authorize,
            ))
    }
    #[tokio::test]
    async fn denies_web_pages_missing_tokens_and_wrong_tokens() {
        for (origin, token, expected) in [
            ("https://evil.test", "test-secret", StatusCode::FORBIDDEN),
            ("null", "test-secret", StatusCode::FORBIDDEN),
            (
                "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "",
                StatusCode::UNAUTHORIZED,
            ),
            (
                "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "wrong",
                StatusCode::UNAUTHORIZED,
            ),
        ] {
            let req = Request::builder()
                .method("POST")
                .uri("/fs/delete")
                .header("Origin", origin)
                .header(TOKEN_HEADER, token)
                .body(Body::empty())
                .unwrap();
            assert_eq!(app().oneshot(req).await.unwrap().status(), expected);
        }
    }
    #[tokio::test]
    async fn authorizes_paired_extensions_and_restricts_cors() {
        let origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let req = Request::builder()
            .method("POST")
            .uri("/fs/delete")
            .header("Origin", origin)
            .header(TOKEN_HEADER, "test-secret")
            .body(Body::empty())
            .unwrap();
        let resp = app().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], origin);
        let req = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();
        let resp = app().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(!resp.headers().contains_key(TOKEN_HEADER));
        assert!(
            !resp
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
        );
    }
}
