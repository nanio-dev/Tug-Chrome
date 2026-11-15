# 验证与性能测试

## 必需检查

```powershell
npm ci
npm run check
npm test
npm run build
cargo test --manifest-path agent/Cargo.toml --offline
cargo clippy --manifest-path agent/Cargo.toml --offline --all-targets -- -D warnings
```

`--offline` 使用已有 Cargo 缓存；初次安装依赖可去掉该参数。

Node 测试覆盖解析、Range 队列、正确下载、忽略/错位 Range、资源验证器变化、短流重试、写盘/同步/Worker 故障、超时、空文件与增量 SHA-256、限速与取消、旧检查点、命名、保存阶段、队列暂停、IndexedDB 故障、BT 跨文件选择和导出重试。合成数据与本地服务器不依赖公网 BT 资源。

## 真实浏览器

```powershell
npm run test:browser
```

使用本机 Playwright Chromium 缓存，或设置 `TUG_TEST_BROWSER` 为 Chromium 可执行文件。脚本不会自动下载浏览器。测试使用独立临时扩展和用户配置，结束后清理。

覆盖：OPFS reset/preserve、检查点前/后销毁引擎上下文、并行分片稀疏文件恢复、真实 RPC 暂停/继续和浏览器导出，以及 760px/420px 布局。另验证本地 HTTPS/HTTP/2 的 32 工作者复用，使用临时自签名证书（需要 OpenSSL，会探测 Git 附带版本；缺失时只跳过该项）。最终输出核对 SHA-256；截图保存在 `test-results/browser/`。

此项模拟上下文销毁，不等价于整机断电测试。

## 真实 Agent

```powershell
npm run test:agent
```

构建开发版 Agent，使用隔离 USERPROFILE、LOCALAPPDATA 与临时目录，以 `--serve-only --native-stdio --port=0` 启动，不迁移、不注册主机、不写注册表，不启用 BT 网络。

通过原生 stdio 读取协议 2 凭据，验证无凭据/网页来源被拒绝、health 不泄漏凭据、目录穿越被拒绝、并发导出不覆盖以及中断上传不发布最终文件。仅操作测试自己的文件。

## HTTP 基准

```powershell
npm run bench:http -- --connections=8,32 --repeats=3 --mib=128
```

使用本地 HTTP/1.1 服务器，比较不限速与每连接限速的 OPFS 下载。记录总时间、有效工作者、请求数、重试、网络接收字节和服务端响应字节，所有样本核对哈希。结果为 `test-results/http-benchmark.json`。writeMs 是各工作者等待写入的累计时间，不能与墙钟时间直接相减。

比较改动前后时可使用 `--baseline=<commit>`：从 Git 只读提取旧版引擎，在同一配置中交替运行旧版/当前工作区，不切换或覆盖工作区源码，结果为 `test-results/http-benchmark-ab.json`。通过 `TUG_TEST_TMPDIR` 指定同一磁盘上的测试目录，避免把不同磁盘的成绩直接比较。

可通过 `TUG_NATIVE_BENCHMARK` 指定外部原生对照驱动。驱动参数为 URL、输出目录、连接数；输出 JSON `{ "ms": number, "bytes": number }`，文件名为 native-bench.bin。项目不依赖某个 Desktop 工作区绝对路径。

支持 `--scenario=fast --checksum=true --mib=1024 --repeats=1` 验证 1 GiB 下载及增量校验；数据源循环使用有限缓冲，浏览器校验也不读取整文件到内存。

本机基准不能外推到公网 HTTPS、HTTP/2/3、CDN 或代理。已验证本地 HTTP/2 复用与 1 GiB 校验；更大的多 GB、HTTP/3 和真实网络压力仍属于后续专项验证。

## 手动验收

加载 dist 扩展，分别验证独立模式和协议 2 Agent；检查登录下载/Referer、右键接管、防循环、磁力与多文件选择、打开/定位/删除、取消保存后继续、深浅色和双语。升级前已有未完成任务可能需要一次重新下载，见 [兼容性说明](implementation-notes.md)。

## Agent 启动与完整 HTTP 链路

浏览器用例覆盖初次启动取得凭据、协议不匹配、未配对、会话状态恢复、明确授权入口与原生端口保留/释放；其 Native Messaging 端口经过模拟，真实系统注册和协议确认仍需手动验收。真实 Agent 集成测试另验证 stdio 凭据、按需 BT 初始化、HTTP 鉴权与原子导出。

`npm run bench:agent-http` 使用独立 Agent 目录与临时用户数据，测量浏览器 HTTP/OPFS 下载、Agent 导出与总耗时，并校验实际系统输出的 SHA-256；默认 128 MiB、8/32 配置各 3 次。需要先构建 agent/tug-agent.exe。大文件可运行 `node scripts/benchmark-agent-http.mjs --mib=1024 --repeats=1 --output=agent-http-benchmark-1024.json`。

Agent 生命周期用例 tests/agent-lifecycle.test.mjs 在隔离用户目录验证旧进程替换、AppData 迁移与原文件清理，以及保持原生 stdin/健康轮询时的空闲退出。测试使用 --isolated-install 跳过真实注册表，只匹配隔离目录的进程；--idle-timeout 仅对隔离/serve-only 模式生效，正式值仍为 120 秒。
