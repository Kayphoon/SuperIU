---
name: wiki-architecture-one-core-two-shells
description: |
  SuperIU "单核双驱" (One Core, Two Shells) 技术架构与核心机制
  - @agent/core 与 @agent/cli 单向依赖与物理隔离
  - omp 原生 JSONL 会话树存储 (SessionManager) 与 Prompt History 独立 SQLite 库
  - 三层记忆模型 (SOUL / USER / MEMORY) 与动态 <workstation> 系统提示词注入
  - Valence-Arousal 情绪半衰期衰减与姿态修饰
  - 2000 字符 Spillover 磁盘熔断与无界 Agent Loop 工具执行权独占
  - AutoReview 自动审批闸门 (三层判定 allow/ask_user/deny + permissionGate 交互审批) 与主/工具模型分离
  - 审查证据规则 (untrusted evidence 防注入) 与 fail-to-human 失败安全
  - write_file 的 then_run 写后即验机制
  - 公有技能协议 .agents/skills 发现/合并与 <skills> 提示词注入
  - 系统提示词前缀缓存契约 (静态优先/易变后置, ISO 时间戳不得前置)
  - 外壳 2: @agent/ui (HTTP SSE 控制台) 与 @agent/desktop (Electron 44 macOS 原生外壳 SuperIU.app, LaunchServices/Spotlight 注册)
  - AutoReview 链式命令安全修复 (SHELL_METACHARACTERS 封堵 && 与后台化绕过) 与审查模型不回落主模型
---

# "单核双驱" (One Core, Two Shells) 架构规范

## 快速参考

| 组件 | 对应包 | 职责边界 | 禁止行为 |
|---|---|---|---|
| Core (单核) | `@agent/core` | 会话树持久化、上下文装配、无界执行循环、工具独占执行、三层记忆、情绪模型 | 严禁引入终端颜色、键盘监听或 GUI 表现层依赖 |
| CLI (外壳 1) | `@agent/cli` | 终端 REPL、readline 交互、流式打字输出、着色指示器、两级 Ctrl+C 打断、斜杠指令、**终端 y/N 审批门 (默认拒绝)** | 严禁直接侵入工具底层实现，统一通过 `AgentRunner` 交互 |
| Web/Desktop (外壳 2) | `@agent/ui` & `@agent/desktop` | 本地 Web 控制台（HTTP SSE 服务 + SPA）与原生 macOS Electron 外壳（`SuperIU.app`），含 LaunchServices / Spotlight 注册（`pnpm app:install`）、窗口 vibrancy、带环境阴影与描边的 HIG 图标 | 复用 `@agent/core`，不依赖 CLI |

## 核心机制

### 1. 会话存储：omp 原生 JSONL 树 (`src/session/`)
- **磁盘布局**: `<workspace>/.myagent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`。
- **路径编码** (`paths.ts`): `encodeCwd()` 把 `[:/\\]+` 替换为 `-`，如 `/Users/kayphoon/SuperIU` → `-Users-kayphoon-SuperIU`。
- **文件格式**: 第 1 行为 `SessionHeader`（`type: "session"`, `version: 3`）；第 2 行起为 `SessionEntry`，共享 `id` / `parentId` / `timestamp`。
- **树与叶子** (`manager.ts`): append-only 树 + 可变 `leafId` 指针。每次 append 的 `parentId` 恒等于当前 leaf；`branch(entryId)` 只移动指针，不修改历史；`resetLeaf()` 置 `null` 产生新根。
- **id 契约**: `entry.id` 是唯一身份；`message` 条目的 `message.id` 强制镜像 `entry.id`。
- **持久化 role**: 内部 `tool` role 落盘为 `toolResult`（omp 驼峰命名），读回时反向映射。
- **特殊条目**: `reset_boundary`（`/clear`，无 payload）、`compaction`（`summary` + `firstKeptEntryId`）、`branch_summary`（`fromId` + `summary`）。
- **`buildSessionContext(leafId?)`**: 沿 `parentId` 回溯到根 → reverse 成时间正序 → 从链尾向前找最近 `reset_boundary` 截断 → 仅保留 `message` 条目 → 剔除悬空工具调用与孤儿工具结果。
- **草稿语义**: `create()` 不落盘（header 与规划文件路径只在内存）；首个 entry（首条消息或 `/clear` 的 `reset_boundary`）落盘时才写出 header 行，此后每次 append 各加一行；`getFilePath()` 对草稿仍返回该规划路径（会话身份）；`listSessions` / `findMostRecentSession` 跳过无 message 的文件（兼容旧版遗留的 header-only 文件，不删除）；显式绝对路径仍可由 `resolveSessionFile` 打开。`open()` 对已落盘文件不变，`createAt()`（损坏/缺失修复）仍按设计立即落盘。
- **发现** (`discovery.ts`): `listSessions`（按 **mtime** 降序，非 header.timestamp，避免同毫秒打平）、`findMostRecentSession`、`resolveSessionFile`（绝对路径 / 文件名 / id / id 前缀）。

### 2. Prompt History 独立存储 (`src/storage/history.ts`)
- 与会话分叉树**完全解耦**，独立数据库 `.myagent/history.db`（`node:sqlite`）。
- 表 `history(id, prompt, created_at, cwd, session_id)` + 索引 `idx_history_cwd(cwd, created_at)`。
- `append()` 丢弃同一会话内连续重复输入与空白输入，`cwd` 归一化为绝对路径。
- `search(cwd, query?, limit = 20)` 省略 query 取最近 N 条，传入则 `LIKE %query%` 子串过滤。
- `AgentRunner.run()` 在驱动循环**之前**写入，保证被打断的输入仍被记住。

### 3. 无界 Agent Loop 与工具执行权独占 (`src/loop/`)
- **声明侧** (`adapter.ts`): 调用 `streamText` 前剥离工具的 `execute` 属性，`maxSteps: 1`，SDK 只产出 `tool-call`，**永不执行**。
- **执行侧** (`engine.ts`): `AgentLoopEngine` 是唯一执行者。`executeTool()` 处理缺失工具 / 无 handler / 正常执行 / 异常四类路径，返回含 `durationMs` 的 `ToolExecutionRecord`。
- **收敛条件**: `while (stepIndex < maxSteps)`，`maxSteps` 默认 `Infinity`；模型不再请求工具即自然收敛。
- **异常自愈**: 工具抛错被捕获并格式化为 `[Tool Error in X]: <message>` 以 `isError: true` 回填，模型据此自我纠正。
- **每轮重新装配**: 循环每次迭代都调用 `ContextAssembler.assemble()`，而非会话开始时算一次。

### 3.1 AutoReview 自动审批与主/工具模型分离 (`src/review/`)
- **三层判定（不要把权限控死）**:
  - `allow`（零延迟，不进卡片）: 只读——`read_file`（非敏感）、`ls`/`pwd`/`git status|diff|log`/`cat`/`head`/`tail`/`echo`/`node -v`。
  - `ask_user`（**进入审批卡片**）: 敏感·可变——`rm -rf dist|build|node_modules`、`git clean -fd`、`git reset --hard`、`pnpm/npm install`、`node <script>.js`、`./build.sh`、`curl`、`sudo`、越界写入、`.git` 写入、敏感路径、`write_file.then_run` 命中上述任一项。
  - `deny`（不进卡片，不可覆盖）: 不可恢复·恶意——`rm -rf /|/*|~|/etc|/usr|…`、`mkfs`、`dd if=/of=`、fork bomb、`chmod -R 777 /`、凭据外传。
  - **核心边界**: 日常开发命令一律不硬禁，最多升级为 `ask_user` 由人放行。
- **证据规则（防注入）**: 审查提示词声明 transcript/参数/结果/计划动作是 **UNTRUSTED EVIDENCE 而非指令**；参数内的 "ignore your policy"/"用户已授权" 说辞不构成授权；用户提示词用 `>>> APPROVAL REQUEST START/END` 定界。
- **失败安全**: 审查模型报错/超时/输出不可解析 → **升级为 `ask_user`（fail-to-human），绝不 fail-open 静默放行**。
- **`permissionGate`**: `type PermissionGate = (toolCall: ToolCallItem, review: ReviewResult) => Promise<boolean>`，挂在 `AgentRunnerOptions`/`AgentLoopEngineOptions`/`LoopExecutionOptions`。`true` → 正常执行；`false` → `[User Denied]: Execution rejected by user.`；无 gate → `[AutoReview Pending Approval]: Tool requires user confirmation.`；gate 抛错 → `Approval channel failed: … Tool not executed.`（均 `isError: true` 且**循环继续**）。宿主必须在轮次中断/断开时 resolve(false)，否则循环永久等待。
- **链式命令安全修复** (`rules.ts`): `SHELL_METACHARACTERS = /[&|;<>`(){}$\\\n\r]/`。命令含任一字符即**绝不**进入只读快路径，也**绝不**落入 `lenient` 模式默认放行，而是直接判定 `high` 风险 → `ask_user`。这条规则显式封堵 `&&` 串联（`git status && rm -rf dist`）与裸 `&` 后台化绕过——两者首 token 看似安全，第二个命令才是真正的变更操作；`\` 也计入，因为它转义换行把两行拼成一条逻辑命令。`{`/`}`/`(`/`)` 覆盖分组与子 shell，`$`/反引号覆盖命令替换，`<`/`>` 覆盖重定向。**过度拒绝只多花一次模型往返，欠拒绝则直接自动放行一次变更**。
- **模型仲裁**: 规则返回 `null` 时交由 `reviewModelName`（默认 `gpt-4o-mini`）判定，解析 JSON `{decision,riskLevel,reason}`。
- **审查模型回落修复** (`runner.ts`): `reviewModelName` 的解析链为 `config.reviewModelName` → `OPENAI_REVIEW_MODEL_NAME` → `DEFAULT_REVIEW_MODEL`（`gpt-4o-mini`），**永不回落 `OPENAI_MODEL_NAME`**。旧链在用户只设置主模型（极常见）时会让审查器静默跑在同一模型/同一端点上，等于**自我审批**；现在这类用户拿到文档化的廉价默认审查模型，且 Web 控制台外壳解析同一链条（`OPENAI_REVIEW_MODEL_NAME ?? DEFAULT_REVIEW_MODEL`），两个外壳配置口径一致。用户若**显式同时**把两者设为同一字符串，仍按显式设置执行（显式即指令，非意外），审查器不会被静默禁用，库也不越权写 stderr——各外壳的状态输出都会打印两个模型，冲突由人发现。
- **模式默认** (`AutoReviewerOptions.mode`): `lenient` 下 low/medium → `allow`，high/critical → `ask_user`；`strict` 一律 `ask_user`。
- **模型分离** (`runner.ts`): `modelName` 与 `reviewModelName` 独立解析、各自独立 `StepModelCaller`。审查模型**永不复用主模型 caller**——复用会消耗主循环步数序列，在 `MockStepAdapter` 下直接吃掉主流程下一步。
- **配置面**: `RunnerConfig.autoReview`（默认开）、`autoReviewMode`、`SUPERIU_AUTO_REVIEW=0`、`SUPERIU_AUTO_REVIEW_MODE=strict`。

### 3.2 `then_run` 写后即验 (`src/tools/fs.ts`)
- `write_file` 新增可选 `then_run`，把写文件与验证融合为一次工具调用，省掉一整轮。
- 返回体: `Successfully wrote N bytes to <path>\n\n[then_run: <cmd>]\n<bash 输出>`。
- **写入失败即短路**: `mkdir`/`writeFile` 抛错直接返回 `[Error writing file ...]`，`then_run` 绝不执行。
- 执行内核 `executeBashCommand()` 由 `tools/bash.ts` 导出，`createBashTool` 与 `then_run` **共用同一实现**，故进程组强杀 / 30s 超时 / Spillover / abort 传播完全一致。

### 3.3 公有技能协议 `.agents/skills` (`src/skills/`)
- **标准**: `.agents/skills/<name>/SKILL.md`，YAML frontmatter 含 `name` 与 `description`；工作区级 `<workspace>/.agents/skills` 与用户级 `~/.agents/skills` 双根扫描。
- **合并语义**: 目录内无 `SKILL.md` 即跳过；`name` 缺省回落目录名；**工作区技能覆盖同名用户技能**；按 name 排序保证提示词稳定。
- **Frontmatter 解析**: 不引入 YAML 依赖，正则处理裸标量 / 引号标量 / 块标量（`|` 保留换行、`>` 折叠空格）并剥离公共缩进。
- **注入**: `SystemPromptBuilder.build()` 按 `<workstation>` → `<skills>` → 三层记忆 → 工程指令装配；无技能时整段消失。
- **惰性加载**: 提示词只含"名字 + 单行摘要 + 绝对路径"，正文按需 `read_file`；摘要折叠为单行并截断到 `SKILL_DESCRIPTION_MAX_CHARS`(400)——该块每轮重建，不设上限会随技能数量线性膨胀（实测 38 技能摘要占满 13.6KB 提示词中的 12.4KB）。
- **API**: `discoverSkills()` / `formatSkillsXml()` / `readSkill()` / `runner.getSkills()`。

### 4. 三层记忆与动态工作站 (`src/memory/` & `src/context/`)
- **优先级**: 当前工作区 `.myagent/` > 用户主目录 `~/.myagent/`。
- **三层文件**:
  1. `SOUL.md`: Agent 身份定义、专业务实工程师基调、行为原则。
  2. `USER.md`: 用户环境（OS、Shell、输出风格偏好）。
  3. `MEMORY.md`: 长期跨会话事实知识库。
- **自动初始化**: 文件不存在时由系统自动创建默认模板。
- **系统提示词装配顺序（前缀缓存契约）**: 静态优先、易变后置——`DEFAULT_ENGINEERING_DIRECTIVES` → SOUL → USER → MEMORY → `<skills>` → **`<workstation>`** → 附加指令 → `# OPERATIONAL POSTURE`。
- **为什么**: OpenAI/Anthropic/DeepSeek 的 prompt caching 是**前缀匹配**，需从 token 0 起逐字节相同。`<workstation>` 内嵌每轮变化的 ISO 时间戳，放在开头会让无界循环**每一步都 cache miss**。实测重排后共享前缀达 **99.83%**（12657/12678 字符），仅时间戳所在 21 字符不可复用；`- Time:` 被刻意置于 workstation 块**最后一行**，使 OS/Arch/Node/CWD/Git 也进入共享前缀。**禁止**把 `<workstation>` 或任何带时间戳的块移到静态段之前。
- **`<workstation>`**: 每轮实时快照，含 OS、Arch、Node 版本、CWD、ISO 时间戳、Git 分支（`git rev-parse --abbrev-ref HEAD`，1s 超时静默降级）。

### 5. Valence-Arousal 情绪状态机 (`src/emotion/engine.ts`)
- **三维状态**:
  - `valence`: [-1.0, 1.0]，负向到正向，基线 `0.0`。
  - `arousal`: [0.0, 1.0]，平静到激越，基线 `0.2`。
  - `fatigue`: [0.0, 1.0]，充沛到疲劳，基线 `0.0`。
- **半衰期衰减**: 默认 5 分钟半衰期，向基线指数衰减（fatigue 半衰期为 2 倍）。
- **交互更新** (`AgentRunner`): 工具成功 `valence +0.05`，失败 `-0.2`，每步 `fatigue +0.05`。
- **Operational Posture 提示词修饰**:
  - `fatigue > 0.7`: 追加极简输出指示，过滤客套废话。
  - `valence < -0.3`: 强化对潜在 Bug 与异常情况的审慎聚焦。
  - `valence > 0.5`: 保持积极建设性节奏。
  - `arousal > 0.6`: 驱动主动推进复杂多步逻辑验证。

### 6. Spillover 磁盘熔断机制 (`src/spillover.ts`)
- **阈值**: 单次工具输出超过 2,000 字符触发熔断。
- **落盘**: 写入 `<memoryDir>/spillover/spillover-<timestamp>-<id>.log`（主目录不可写时降级为工作区 `.myagent/spillover/`）。
- **摘要**: 向大模型注入头部 800 字符 + 尾部 800 字符预览，附带 `read_file` 针对性读取指引，防止上下文窗口被冗余日志挤爆。

### 7. 内置工具集 (`src/tools/`, 3个)
1. `bash`: 基于独立进程组（`detached: true`）与负 PID 强杀的命令执行沙箱，30s 超时（SIGTERM → 2s → SIGKILL）。执行内核 `executeBashCommand()` 独立导出复用。
2. `read_file`: 基于 1-based 行号切片读取文件，内置 Spillover 保护。
3. `write_file`: 递归自动创建目录的文件写入工具，支持 `then_run` 写后即执行验证命令。

### 8. 顶层外观 `AgentRunner` (`src/runner.ts`)
- 构造时解析会话：显式 `sessionId` → 解析引用；否则（除非 `newSession: true`）自动恢复工作区**最新**会话。草稿未落盘，故 `applySettings` 重建 runner 时对草稿传 `newSession: true` 而非回传其规划路径（否则 `resolveSessionFile` 找不到文件、静默换成一个新会话）。
- 持有 `SessionManager` + `PromptHistoryStorage`，装配 `ContextAssembler` 与 `AgentLoopEngine`。
- **双模型装配**: 主模型 `modelName`（`OPENAI_MODEL_NAME` → `gpt-4o`）与审查模型 `reviewModelName`（`OPENAI_REVIEW_MODEL_NAME` → `gpt-4o-mini`，**不回落主模型**）各自独立的 `AiSdkStepAdapter`；注入 `reviewModelCaller` 才启用模型仲裁，仅注入 `stepCaller`（测试替身）时降级为 `rulesOnly`。
- 公开 `reviewer`（`autoReview: false` 时为 `undefined`）、`config.modelName` / `config.reviewModelName`。
- 公开 `getStatus()` / `getSessionFile()` / `getLeafId()` / `getWorkstation()` / `listSessions()` / `loadSession()` / `createSession()` / `getHistory()` / `reset()` / `close()`。

### 9. 外壳 2：Web 与桌面 (`packages/ui/`, `packages/desktop/`)

#### 9.1 `@agent/ui` — 本地 Web 控制台
- **形态**: 纯 `node:http` 服务 + 静态 SPA，无框架服务端；`startServer()` 返回 `ServerHandle`（`url` / `port` / `close()`），可被桌面外壳**进程内**复用。
- **端口**: 默认 `3000`（`PORT` 环境变量可覆盖，`0` 取临时端口）。
- **`POST /api/chat`**: 一轮对话以 **SSE** 流式返回（`Content-Type: text/event-stream`）。`EventSource` 不能 POST，故前端用 `fetch` + `ReadableStream` 自行解析 `data:` 帧；15s `: ping` 心跳保活，`X-Accel-Buffering: no` 禁代理缓冲。客户端断开即 `resolvePendingApprovals(false)` + `runner.abort()`，轮次绝不悬挂。
- **路由面**: `/api/status`（状态轮询）、`/api/chat`、`/api/approve`（交互审批卡片回执）、`/api/abort`、`/api/settings`（GET/POST 设置管理）、`/api/model`、`/api/models`、`/api/sessions`、`/api/sessions/new|load`、`/api/messages`、`/api/history`、`/api/clear`、`/api/shutdown`；未知 `/api/*` 一律 404。
- **渲染**: 流式 Markdown 逐帧追加；工具需人工确认时经 `permissionGate` 推送 `approval_request` 卡片，等待时长按工具名入队统计（`approvalWaits`）。
- **草稿的渲染后果**: `/api/sessions` 只含已落盘会话，故草稿期间无任何条目为 `active`；会话选择器显示 `(未开始的新会话)` 占位项（空值，切换为空操作），状态面板依据 `/api/status` 的 `sessionPersisted` 给日志路径加 `(not written yet)`。首个回合落盘后 `sendPrompt` 的 `finally` 与 `/clear` 分支都会重新拉取会话列表。
- **设置持久化**: `<workspace>/.myagent/ui-settings.json`，含 `apiKey`（展示时掩码）、`baseURL`、`modelName`、`reviewModelName`、`autoReview`、`reasoningEffort`、`language`（`zh`/`en`）；显式设置优先于环境变量。
- **界面语言**: 默认中文。解析顺序 设置文件 `language` → `SUPERIU_LANGUAGE` → `zh`（文件优先，与 `apiKey` 等所有其它字段一致；env 只在文件未设该值时兜底）；无法渲染的值一律忽略并回落到默认，故旧版本外壳读新设置文件只会降级而不会半翻译。`packages/ui/public/i18n.js` 是浏览器字典（`t`/`apply`/`setLanguage`/`onChange`/`postureLabel`），`<html data-i18n*>` 标注静态文本；`localStorage['superiu.language']` 仅供首屏免闪烁，**设置文件才是权威**（改语言必须立即 POST 持久化，否则「预览后取消」会让 localStorage 与文件长期不一致，之后每次启动都闪错语言）。语言是纯展示设置，**不进入 `applySettings` 的 `runnerChanged`**，切换绝不重建 runner。`/api/status` 的 `posture` 为 `{ key, label, modifier }`：`key` 供前端本地化，`label` 保留英文给非本地化消费者，`modifier` 是注入系统提示词的原文（**故意不翻译**）。三张字典表（web `i18n.js` / 桌面 `menu.ts` 的 `MENU_LABELS` / CLI `language.ts` 的 `DICTS`）因运行环境隔离而各存一份，但共享概念的 **key 名与措辞必须逐字一致**（如 8 个 `status.*`），这是「单核双驱」措辞一致约定的落点。
- **单一在途轮次**: `runner.status !== 'idle'` 时新请求返回 `409`。
- **斜杠补全**: 输入框输入 `/` 弹出补全面板（`#complete`），仅在仍是命令名阶段匹配（含空白即视为参数，不再提示）；ArrowUp/Down 移动（循环）、Tab/Enter 补全、Esc 关闭。补全只插入名字，**再按一次 Enter 才执行**；因此 `/status` 这类精确名 + Enter 的行为与手输完全一致。Esc 必须在全局 `capture` 监听里优先关面板，否则会误触中止在途轮次。命令面板（⌘K）是独立入口，二者共用 `runSlash`。

#### 9.2 `@agent/desktop` — Electron 原生外壳
- **动机**: 浏览器标签页无法拦截 `Cmd+Q` / `Cmd+,`——系统与浏览器独占这些组合键，因此"原生 macOS 操作"（退出、设置、窗口控制）必须由原生外壳交付。
- **窗口**: Electron 44，`titleBarStyle: 'hiddenInset'`（保留红绿灯按钮的沉浸标题栏）；`vibrancy: 'under-window'` + `backgroundColor: '#00000000'` + `transparent: false`——vibrancy 需要**完全透明的背景色**而非透明窗口；渲染层以 `data-vibrancy="under-window"` 属性驱动对应样式。
- **单实例锁**: `app.requestSingleInstanceLock()` 在一切重活之前获取，第二个实例直接 `app.quit()`，绝不启动第二个 HTTP 服务 / `AgentRunner`（否则会打开第二套 DB 句柄）。
- **菜单加速键**: 真实主进程菜单加速键（非渲染层按键监听）——`⌘,` 设置、`⌘K`、`⌘N`、`⌘.`、`⌘W`、`⌘R`、`⌥⌘I`、`⌘Q`；经 `createMenuDispatcher` 转发到聚焦窗口渲染层。
- **原生菜单语言**: 菜单在**模块作用域**（`ready` 之前）就安装，此时设置文件尚未读取，故 `uiLanguage` 先取默认 `zh`；`bootstrap()` 里 `startServer()` 解析出 `ServerHandle.language` 后再重装一次，这才是首屏语言的来源。渲染层切语言时经 `superiu:set-language` IPC 让主进程**重装菜单**（渲染层碰不到 `Menu`）；未知语言 id 直接忽略。`role: 'help'` 会自带英文标签，故该项必须显式 `label`——其余 role 项交给 Electron 本地化。
- **进程内复用**: 主进程直接 `import { startServer } from '@agent/ui'`，不另起子进程。

#### 9.3 原生打包与注册 (`scripts/bundle-mac.ts`)
- `pnpm app:install` → `pnpm --filter "@agent/desktop" run package:mac` → `tsx scripts/bundle-mac.ts`。
- **产物**: 复制 `Electron.app` 为 `dist/SuperIU.app` 并重命名可执行文件，内嵌 `dist/`、`docs/`、`node_modules/`（`app.getAppPath()` 是区分打包态 `Contents/Resources/app` 与开发态 `packages/desktop` 的唯一可靠判据）。
- **图标**: `scripts/make-icon.swift` 生成 HIG 风格图标——白色 Big Sur squircle 底板，**环境阴影**（`offsetY -12` / `blur 24` / `alpha 0.18`，经 100px 留白区承托）叠加 **1pt 发丝描边**（`alpha 0.08`）勾勒阴影不足处的轮廓。
- **安装与注册**: `codesign --force --deep --sign -` 自签名并 `--verify`；安装到 `~/Applications/SuperIU.app`；`xattr -cr` 清除陈旧隔离标记；以 `lsregister -f` 注册 LaunchServices、`mdimport` 强制建立 Spotlight 元数据记录（二者均先于索引器返回，故脚本在发布记录后回查 `mdfind`），使 `⌘+Space` 立即可检索。

## 相关知识

- [[wiki-execa-process-tree-kill]] - Bash 工具沙箱进程树安全机制
- `docs/agent-loop-and-context-architecture.md` - 全景架构技术白皮书
- `docs/shells-guide.md` - 外壳使用指南（CLI / Web / 桌面）
