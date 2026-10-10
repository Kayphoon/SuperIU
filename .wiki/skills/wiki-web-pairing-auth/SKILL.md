---
name: wiki-web-pairing-auth
description: |
  Web 控制台配对鉴权层 (opencode pairing 模式) 与弱网容错
  - 鉴权启用谓词: SUPERIU_WEB_AUTH=1/0 强制, 缺省 AUTO = 非回环绑定 OR pairing.json 已有 key/code; 回环绑定无 key 保持开放 (pnpm ui / 桌面本地 / SSH 隧道不受影响)
  - 回环对端 (127.0.0.1/::1/::ffff:127.0.0.1 及 Unix domain socket / remoteAddress === undefined) 在鉴权开启时也豁免 — 桌面 remote 模式经 SSH 隧道加载远端 SPA 依赖这条信任边界; X-Forwarded-For 永不信任
  - 一次性 code: base64url(randomBytes(24)), 5 分钟过期, 单次消费即换发长期 key (64-hex, randomBytes(32)); GET /auth/connect/:code 302 到 / 或 /?pair_error=invalid
  - 滑动过期 (用户需求): key 有效 iff now - max(lastUsedAt, createdAt) <= TTL; TTL 默认 30 天, SUPERIU_PAIRING_TTL_DAYS 覆盖 (非法值回落 30)
  - markUsed 落盘节流每小时每 key 一次 (内存时间戳始终最新); cookie Max-Age 同步每小时重发一次
  - 存储只存 sha256 哈希: .superiu/pairing.json (0600, 临时文件+rename 原子写), id = 哈希前 12 hex 供展示/吊销; 铸造后原始 key/code 永不落日志
  - mtime 读穿缓存: daemon 内存态 + CLI 离线铸造共存 — verify/consumeCode 前若文件 mtime 变化则重读合并, superiu-server pair 在 daemon 运行中铸造的链接无需重启即生效
  - 401 一律 JSON {"error":"unauthorized"}, 仅 sec-fetch-mode: navigate 的请求才带 WWW-Authenticate (避免 fetch 弹原生 Basic 框卡死在 Loading — opencode PR #50972 的教训)
  - 失败限流: 每内存计数每 IP 20 次/分钟 → 429 (回环豁免)
  - SPA 侧: /api/* 401 → 连接屏 (粘贴一次性链接或裸 key, POST /api/pair); api() 包装器 10s 超时 + GET 指数退避重试 + online→degraded→offline 状态机 + 离线横幅 + "保持旧数据不清空" (stale-not-blank)
  - 设置第 8 面板 (auth 门控): 设备列表/吊销/为他机发码 (5:00 倒计时); 当前设备靠 localStorage['superiu.pairId'] 标记
---

# Web 控制台配对鉴权

## 为什么是这套形状

对标 opencode v2 pairing: `opencode pair` 打印一次性链接 → 浏览器打开即 Set-Cookie 进 UI。
弱网不卡的根源不是鉴权而是**快照 + 增量事件 + 本地渲染**——SPA 全部交互零网络往返,
服务端只推 delta。SuperIU 浏览器路径本次补的是鉴权与容错层, 事件化 (seqId/catch_up) 已在
WS gateway 侧存在, 浏览器路径仍为 REST+SSE (见 event_hub.ts 的已知缺口)。

## 关键文件

- `packages/ui/src/auth/store.ts` — PairingStore (滑动 TTL、一次性 code、原子写、mtime 读穿)
- `packages/ui/src/auth/middleware.ts` — AuthLayer (启用谓词、回环豁免、cookie/Bearer、限流)
- `packages/ui/src/auth/routes.ts` — /auth/connect/:code、/api/pair、/api/pairing*
- `packages/ui/src/daemon.ts` — `superiu-server pair [--url|--list|--revoke <id>|--name <label>|--rename <id>]` 离线铸造与命名
- `packages/ui/public/index.html` — 连接屏（支持设备命名）、api() 容错层、设置配对面板（发码指定设备名、设备列表支持重命名）
- 测试: `packages/ui/test/pairing.test.ts` (滑动过期、设备命名与重命名)

## 踩过的坑

- **外部服务地址 (advertiseUrl) 优先注入**: 解决 SSH 隧道模式下因回环转发请求导致生成的一次性配对链接以 `http://127.0.0.1:<port>` 为基准、无法在外部手机/浏览器打开的痛点。AuthLayer、routes.ts 及 UI 设置面板支持配置与持久化 `advertiseUrl`（公网 IP、反向代理域名、Cloudflare Tunnel 等），生成配对码时自动作为前缀覆盖 `req.headers.host`。
- **首次向导三卡片 Tab 选择器**: Desktop 首次运行向导 (`onboarding.html`) 采用横向三卡片切换布局（本地单机模式 / SSH 远程连接 / 自定义服务地址），支持免 SSH 隧道的 Custom URL 直连与 Token 交换，各面板平级切换。
- **Unix 域套接字 peerAddress undefined**: 桌面 remote 模式经 SSH 隧道转发至远端 daemon 绑定的 socket 时，Node.js HTTP 连接的 remoteAddress 为 undefined。若仅校验 IP 字符串会导致 SSH 远程连接被误判为外网连接并报 401，进而弹出 Web 配对屏锁死 Desktop。必须将 req.socket.remoteAddress === undefined (AF_UNIX) 同样作为 loopback peer 豁免。
- **Desktop 端永远不可被配对屏死锁**: 桌面端自带 SSH 与本地单机双轨制。配对屏在 window.superiuDesktop 存在时不得隐藏主 UI (.siu-app)，必须提供关闭按钮、使用 SSH 远程连接快捷入口（直达设置）以及返回本地模式按钮，支持 Esc/蒙层退出。
- **CLI 铸造与 daemon 内存态竞态**: daemon 无控制 socket (status/stop 走 server.json+信号),
  pair 子命令直接离线写文件, 依赖 mtime 读穿让运行中的 daemon 生效——铸造后立即提交可能
  落在重读窗口内被 401, 属预期竞态, 重试即好; e2e 验证时需等 CLI 返回后再提交。
- **静态 i18n 兜底文本必须与字典同步**: `data-i18n` 元素的静态文本改了字典不改标记 (或反之),
  check-ui-i18n 的 "element text is empty or its own dictionary value" 立即 FAIL——两处要一起改。
- **浏览器测试断言要留足时间**: 本环境请求耗时 1.4~3.2s, 600ms 后读 DOM 会把"渲染未完成"
  误判成缺陷 (字典占位符 {days} 未插值、列表为空)。先确认 fetch 已结算再下结论。
