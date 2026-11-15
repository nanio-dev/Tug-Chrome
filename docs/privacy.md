# 隐私与本机接口边界

Tug Web 没有账号系统、云端中转或分析 SDK。任务与下载数据保存在本机。

## 存储

- IndexedDB 保存任务 URL、自定义请求头、来源地址、校验值、检查点、文件选择和导出结果。
- chrome.storage.local 保存设置与有限条诊断日志。
- OPFS 保存下载中的字节；完成持久化导出或删除任务后清理。
- Agent 的 BT 缓冲使用本地临时目录，没有任务数据库。授权凭据放在当前用户应用目录，继承该目录的系统访问权限；插件侧只保存在 storage.session，不写入诊断日志。

URL 和自定义请求头本身可能包含登录或签名信息，清理任务可移除其本地记录。诊断日志不应作为凭据传输通道。

## 权限用途

| 权限 | 用途 |
|---|---|
| downloads / downloads.open | 接管、保存、打开文件与目录 |
| offscreen | 后台引擎宿主 |
| storage | 设置、诊断与会话凭据 |
| contextMenus | 链接/媒体快捷下载 |
| declarativeNetRequestWithHostAccess | 任务所需的 Referer/UA 等请求头 |
| notifications | 下载结果与 Agent 安装提示 |
| tabs / alarms | 管理面板、自定义协议与引擎保活 |
| nativeMessaging | 与安装在本机的 Agent 配对 |
| all_urls | 用户指定下载来源与页面链接识别 |

## 网络请求

开启 carryCookies 时，fetch 按浏览器 Cookie 规则向下载目标发送登录态；插件不读取 Cookie 明文。carryReferer 控制来源地址。HTTP 请求由浏览器发起，Agent 当前不接收 HTTP 下载 Cookie。

BT/WebTorrent 会接触配置中的 Tracker、WebSeed、STUN 和对端；这些服务可观察到用户 IP 与种子信息。可在设置关闭 WebRTC、修改 Tracker 列表，或启用纯浏览器模式停止 Agent 检测和调用。清空自定义 Tracker 列表不再悄悄恢复 HTTP/UDP 默认列表；WebTorrent 的 WebSocket 引导列表仍属于内置浏览器发现机制。

## Agent

仅绑定回环；除只读 health 外需要 Native Messaging 能力凭据。HTTP 不返回凭据，网页 CORS 来源被拒绝。文件打开/删除先解析实际路径并验证位于 Downloads，拒绝目录穿越；导出还拒绝链接/重解析目录，防止写出根目录。

这是同一用户会话内的本机辅助程序，不试图隔离同一系统用户运行的其他程序。系统用户本身、恶意本机进程或被篡改的扩展代码不属于浏览器来源授权所能隔离的边界。
