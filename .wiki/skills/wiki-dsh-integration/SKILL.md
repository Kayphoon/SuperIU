---
name: wiki-dsh-integration
description: SuperIU 的本机 DeepSeek Harness 发现、托管、同源 HTTP/WebSocket 代理与双语页面；环境变量、认证边界、进程关闭和 Node 类型擦除兼容性
---

# 本机 DSH 集成

聊天页顶栏的 DSH 入口打开 `/dsh.html`。该页面调用 `POST /api/dsh/connect`，将真实 DSH Web UI 放进同源 `/dsh/` iframe；`GET /api/dsh/status` 返回状态、托管标志、代理入口或稳定错误码。

## 发现与托管

- 固定依赖为 `@deepseek-ai/dsh@0.2.2-rc.1`，官方仓库是 https://github.com/deepseek-ai/deepseek-harness。
- 默认探测 `127.0.0.1:3080`。`SUPERIU_DSH_PORT` 可更改自动发现端口；非 DSH 服务不会被接管，发现失败后启动托管实例。
- `SUPERIU_DSH_URL` 指定完整的本机 DSH 根地址，受保护实例需带 `?token=...`。只接受真实回环 IP 或 localhost，不接受看似以 `127.` 开头的 DNS 名称。
- 无法取得认证令牌的既有 DSH 不会被当成可用实例；自动发现会回退托管，显式 URL 则返回认证错误。显式 URL 无效或不可用时同样返回错误。
- 托管使用系统 Node.js >=24.9，在空闲回环端口运行 `dsh --profile web --no-open`；`SUPERIU_DSH_NODE` 与 `SUPERIU_DSH_BIN` 可覆盖运行时和 CLI 路径。
- `dsh web: <tokenized URL>` 是 readiness 信号，不以端口打开代替就绪。输出写入工作区 `.superiu/dsh.log`；日志错误不会终止服务。
- 单个 manager 合并并发连接请求。托管实例由 SuperIU 停止，发现的外部实例不会被误杀。

## 代理与认证

HTTP 和 WebSocket 都剥离 `/dsh` 前缀、保留 Host、重写同源 Location 与 Cookie Path。HTTPS 场景为 Cookie 添加 Secure。

DSH 路径受 SuperIU pairing 认证保护。转发前删除 Authorization 和 `superiu_pair`，保留 DSH 自己的 Cookie。upgrade 路由使用固定 URL 基线解析请求路径，不能让畸形 Host 导致新路由崩溃。

托管进程使用独立进程组，关闭时 SIGTERM 后升级 SIGKILL。关闭必须处理 discovery、Node/CLI 解析、spawn 和 readiness 各阶段，并在等待启动结束后再次清理，防止 detached 子进程泄漏。

## 前端与验证

页面复用 `public/i18n.js`，settings Promise 在模块加载后订阅，避免快速设置响应丢失语言更新。iframe load 只有在真实文档标题为 DeepSeek Harness 时才进入可见 ready 状态；错误页面保留重试，聊天页独立可用。

- `packages/ui/test/dsh.test.ts` 验证真实托管、误判拒绝、外部接管、关闭竞争、Cookie/Authorization 边界、Location 和真实 101 upgrade。
- `packages/ui/test/pairing.test.ts` 覆盖 DSH HTTP/WS 鉴权、畸形 Host 以及 loopback 不刷新空 Cookie。
- daemon 测试会直接以 Node 类型擦除模式加载源码。新增类不能使用 TypeScript 构造参数属性；使用普通字段声明和赋值。
- 真实浏览器移动 QA 必须在导航后设置 CDP metrics，回读 CSS 宽度、触摸点及 PNG IHDR，不能只凭图片文件存在宣称移动验收通过。
