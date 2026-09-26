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
- **用量记账**: 每个 step 的 `StepUsage` 写入 `engine.latestUsage`（公开字段，跨轮次保留）并随 `AgentLoopRunResult.usage` 返回，四个 return 分支（abort / 收敛 / 步数上限 / 步骤内 abort）都带上。`adapter.ts` 把非有限的 `promptTokens`/`completionTokens`/`totalTokens` 归为 `undefined`：OpenAI 兼容 provider 默认 `compatibility: 'compatible'`，**不发送** `stream_options.include_usage`，此时 SDK 的 usage 是 `NaN` 而非缺省——`NaN` 参与算术会污染整条链路，且 JSON 序列化成 `null`，前端会渲染成空白读数。三项全非有限时整个 `usage` 置为 `undefined`，保持「`StepUsage` 存在 = provider 真的计过数」这一语义。反向证明：让 `getContextUsage()` 忽略 provider 计数、或删掉引擎里的 `latestUsage` 赋值，`scripts/smoke-test.ts` 与 `scripts/provider-settings-wire.ts` 分别报错。

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
- **上下文用量表 (`getContextUsage()`)**: 返回 `{ tokens, limit, percent }`。`tokens` 优先取 `engine.latestUsage.promptTokens`（**provider 自报的计数**，已含系统提示词与工具 schema，是唯一诚实的分子），仅在尚未跑过任何 step 时（新建会话、或刚 load 的会话）回落到 `estimateContextTokens(分支消息)`（字符数 / 3.5）。`limit` 来自 `model/metadata.ts` 的能力表，按 `resolveBase('main').model` 取——**用 base 而非 finalize**，因为窗口是模型属性，与推理强度无关。`percent` 为 0-100 整数并**钳位**（provider 可能报出比表内窗口更大的数，>100 会撑爆进度条）。引擎侧 `latestUsage` 是**跨轮次**持有的公开字段（不是 `run()` 的局部量），因为外壳在轮次仍在流式时就要轮询它，此时 `run()` 尚未 resolve；同时随 `AgentLoopRunResult.usage` 一并返回。该计数**绑定在引擎当前所在的会话上**：`bindSession()` 重指 `this.session`/`assembler.session`/`engine.session` 时同步清空 `engine.latestUsage`，`loadSession()`、`createSession()` 与 `reset()`（`/clear` 就地截断分支）都经它走，所以切换会话或 `/clear` 后分子回落到当前分支的字符估算，而不是继续显示上一个会话的数字——`getContextUsage()` 刻意不做会话身份比对，因为 `latestUsage` 与会话的一致性正是 `bindSession()` 维护的不变量，且 `/clear` 不改变会话身份，比对也看不见该情形。

### 9. 外壳 2：Web 与桌面 (`packages/ui/`, `packages/desktop/`)

#### 9.1 `@agent/ui` — 本地 Web 控制台
- **形态**: 纯 `node:http` 服务 + 静态 SPA，无框架服务端；`startServer()` 返回 `ServerHandle`（`url` / `port` / `close()`），可被桌面外壳**进程内**复用。
- **端口**: 默认 `3000`（`PORT` 环境变量可覆盖，`0` 取临时端口）。
- **`POST /api/chat`**: 一轮对话以 **SSE** 流式返回（`Content-Type: text/event-stream`）。`EventSource` 不能 POST，故前端用 `fetch` + `ReadableStream` 自行解析 `data:` 帧；15s `: ping` 心跳保活，`X-Accel-Buffering: no` 禁代理缓冲。客户端断开即 `resolvePendingApprovals(false)` + `runner.abort()`，轮次绝不悬挂。
- **路由面**: `/api/status`（状态轮询）、`/api/chat`、`/api/approve`（交互审批卡片回执）、`/api/abort`、`/api/settings`（GET/POST 设置管理，含 `activeProviderId` 与 `providers[]`）、`/api/models/fetch`（POST 实时探查端点的 `GET /models`）、`/api/model`、`/api/models`、`/api/sessions`、`/api/sessions/new|load`、`/api/messages`、`/api/history`、`/api/clear`、`/api/shutdown`；未知 `/api/*` 一律 404。
- **渲染**: 流式 Markdown 逐帧追加；工具需人工确认时经 `permissionGate` 推送 `approval_request` 卡片，等待时长按工具名入队统计（`approvalWaits`）。
- **草稿的渲染后果**: `/api/sessions` 只含已落盘会话，故草稿期间无任何条目为 `active`；会话选择器显示 `(未开始的新会话)` 占位项（空值，切换为空操作），状态面板依据 `/api/status` 的 `sessionPersisted` 给日志文件名加 `(not written yet)`。首个回合落盘后 `sendPrompt` 的 `finally` 与 `/clear` 分支都会重新拉取会话列表。
- **设置持久化**: `<workspace>/.myagent/ui-settings.json`，含 `apiKey`（展示时掩码）、`baseURL`、`modelName`、`reviewModelName`、`autoReview`、`reasoningEffort`、`language`（`zh`/`en`）、`theme`（`system`/`dark`/`light`）、`activeProviderId` 与 `providers[]`；显式设置优先于环境变量。
- **多服务商模型（模型配置子菜单）**: 设置弹窗为三分栏偏好窗口——**通用**（语言/推理强度/AutoReview/通知）、**模型配置**（主从双栏：左为服务商列表 + 过滤 + 添加，右为选中服务商的名称/启用开关/API Key/Base URL/模型网格）、**关于**（产品信息与本地存储说明）。`providers[]` 每项为 `{ id, name, enabled, apiKey, baseURL, models[], description, helpUrl, custom }`，视图另带 `presetName`（该 id 的预设默认名，custom 槽为 `''`）——渲染层只在 `name === presetName` 时才用字典本地化，故「未改名的预设被翻译」与「用户改名后显示自己的名字」同时成立。内置预设只有公开厂商：OpenAI / Anthropic / Google Gemini / DeepSeek，加一个 **custom** 槽位；**私有中转网关绝不进内置表**（会把他人的个人端点写进产品源码，且主机名一改就失效），未命中预设的端点一律落入 custom。`createDefaultProviders()` 按当前 `baseURL` 的 host 匹配决定哪个预设为 `enabled`。**恰好一个服务商处于启用态**，顶层 `apiKey`/`baseURL` 是它的**纯投影（无条件赋值，绝不合并）**：切到自身无密钥的服务商 = 应用未配置（请求以明确鉴权错误失败），而**不是**沿用上一家的密钥——后者会把 A 家的密钥发往 B 家的端点。每个 provider 条目只持有自己的凭据，故切回即恢复，绝不做「把活跃密钥写回活跃条目」的回写（那会把一份密钥复制进多个条目，用户轮换后留下静默生效的陈旧副本）。删除当前活跃的服务商后，`activeProviderId` 回落到 `providers[0]?.id ?? ''`，不留悬空 id。`POST /api/models/fetch` 实时拉取端点 `GET /models`；**未显式传 apiKey 时按端点反查凭据**：找出 baseURL 与目标端点规范化（去尾斜杠 + 小写）后相等的那个 provider，用**它自己的** `apiKey`；仅当端点等于顶层 `settings.baseURL` 时才用 `settings.apiKey`。**绝不能用 `providerId` 提示去取键**——那会把活跃 provider 的密钥发往另一家的主机。未知端点发**匿名探测**（不带 Authorization），这既是无键可泄的证明，也是 Ollama 这类尚未保存的无密钥本地端点能用的前提。控制台无鉴权，故任何 caller 自选的 baseURL 都拿不到别人的凭据。失败一律返回 `200 { ok: false, error }`。服务端**不下发** provider 描述文案（否则英文界面渲染出中文），描述由前端按 `settings.providers.desc.<id>` 计算键取字典，只有用户自己填的描述才原样显示。**设置弹窗的焦点**：`openModal('settings')` 聚焦当前激活的 nav 标签（`#settings-nav .siu-nav-item[aria-selected="true"]`），**绝不**聚焦 `#set-api-key`——该输入框位于 `#settings-pane-providers`，默认 pane 为 general（`display:none`），对隐藏元素 `focus()` 静默失败，焦点会停在 `<body>`，键盘用户失去可见焦点指示。
- **凭据线上守卫 (`scripts/provider-settings-wire.ts`，已接入 `pnpm test`)**: 断言全部落在**真正离开进程的字节**上——探针端点记录的 `Authorization` 头，以及服务端持久化的设置文件。断言响应体无法区分「凭据外泄」与「探测成功」，而这正是本面板两类缺陷的形态。探针按路径记录每个请求的 `authorization`，因此能证明**哪一把密钥到了哪一台主机**；全局不变式「没有任何请求收到不属于它的凭据」覆盖整个请求面，仅豁免 caller 显式传入 apiKey 的那一次（那是密钥抵达非归属端点的唯一合法途径）。反向证明：把 `models/fetch` 改回旧的回退逻辑、把投影改回 truthy 守卫、或删掉悬空 id 兜底，该脚本分别报错——三处守卫都是**承重**的。同一脚本另跑**用量链路**：探针额外应答 `/chat/completions` 并回报固定的 `prompt_tokens`，于是该数字必须**原样**出现在 `/api/status` 与 SSE `done` 帧上——只断言任一跳都证明不了链路。要驱动真实轮次，必须先用 `seedProbeProvider()` 把**活跃服务商**的 `baseURL` 指向探针（runner 的凭据/端点是活跃条目的投影）；否则请求会发往真实主机，用量表回落到估算，断言会**空转通过**。反向证明：从 `done` 帧删掉 `contextTokens`、让 `getContextUsage()` 忽略 provider 计数、或改坏 metadata 的 Gemini 家族窗口，分别有 2/3/2 条断言失败。
- **界面主题 (Appearance)**: 设置弹窗「通用」栏内，紧邻界面语言。取值 `system`/`dark`/`light`，持久化于 `ui-settings.json` 的 `theme`，并镜像到 `localStorage['superiu.theme']`。**预绘制脚本**（`<head>` 内阻塞脚本）在首屏前解析该键：存储值为 `dark`/`light` 就直接用，否则读 `matchMedia('(prefers-color-scheme: dark)')`；**这是唯一能在首屏前运行的代码**，所以 localStorage 与设置文件不会各说各话。`system` 实时跟随系统（`matchMedia` 的 `change` 立即重绘，无需刷新），`dark`/`light` 钉住并**刻意忽略**系统切换。主题与语言一样是**纯展示设置**：`applySettings()` 不把它计入 `runnerChanged`，`POST /api/settings` 的 `presentationOnly` 白名单含 `theme`，故在途轮次中改主题不会 409、不会重启 runner、不会丢会话（含 `theme` 与其它键的混合 patch 仍照常 409）。`applyColorScheme()` 跳过同值写入——预绘制脚本通常已写对，重复赋值仍会触发样式重算。桌面外壳把偏好镜像到 Electron `nativeTheme.themeSource`（窗口边框/菜单/`under-window` 材质随之切换）；实测 `themeSource` **只在真正变化时**异步发 `updated`，故 `installThemeSync()` 只挂该事件转发 `superiu:theme`，IPC handler 里**不再重复广播**。
- **界面语言**: 默认中文。解析顺序 设置文件 `language` → `SUPERIU_LANGUAGE` → `zh`（文件优先，与 `apiKey` 等所有其它字段一致；env 只在文件未设该值时兜底）；无法渲染的值一律忽略并回落到默认，故旧版本外壳读新设置文件只会降级而不会半翻译。`packages/ui/public/i18n.js` 是浏览器字典（`t`/`apply`/`setLanguage`/`onChange`/`postureLabel`），`<html data-i18n*>` 标注静态文本；`localStorage['superiu.language']` 仅供首屏免闪烁，**设置文件才是权威**（改语言必须立即 POST 持久化，否则「预览后取消」会让 localStorage 与文件长期不一致，之后每次启动都闪错语言）。语言是纯展示设置，**不进入 `applySettings` 的 `runnerChanged`**，切换绝不重建 runner。`/api/status` 的 `posture` 为 `{ key, label, modifier }`：`key` 供前端本地化，`label` 保留英文给非本地化消费者，`modifier` 是注入系统提示词的原文（**故意不翻译**）。三张字典表（web `i18n.js` / 桌面 `menu.ts` 的 `MENU_LABELS` / CLI `language.ts` 的 `DICTS`）因运行环境隔离而各存一份，但共享概念的 **key 名与措辞必须逐字一致**（如 8 个 `status.*`），这是「单核双驱」措辞一致约定的落点。
- **字典一致性守卫 (`scripts/check-dict-parity.mjs`，已接入 `pnpm test`)**: 补上该约定此前**只有文档、没有守卫**的空档——`check-ui-i18n.mjs` 只读 web 外壳，CLI 表里被改坏的共享词它**看不见**（两脚本并存，各管一段）。每张表按**字面前缀切片**后再取键（整文件取键得到的是 zh/en 两表**并集**，会让「只缺一种语言」的键结构性地隐形——正是本地化守卫踩过的坑），并处理双引号值（含撇号必须双引号，否则该键被静默丢掉并误报为缺键）与转义解码（卡片标签带 `\u3000` 内边距，会改变字节比较）。三类检查：(1) **表内对齐**——zh/en 键集完全相同、无重复键；(2) **跨表共享概念**——key 名 join 加人工推导的 `SHARED_CONCEPTS` 映射，断言共享概念**逐字一致**（豁免：各外壳自己的列内边距 `normalize: 'trim'`、会话文件模板的 `{path}` 占位 `stripPathPlaceholder`）；其中最要紧的是 **8 个 `status.*` 状态词**：两外壳都用 `'status.' + state` **动态**拼键、取自 core 的 `AgentStatus` 联合类型，故一侧改名既不报编译错也不报任何现有守卫，只会运行时静默查不到；(3) **枚举词表完整性**——`ENUM_WORD_MAPS`（`RiskLevel` / `reviewedBy` / `AutoReviewMode`）要求 CLI 渲染进用户可见字符串的每个 core 枚举值都有词映射，故 `lenient` 这类裸 token 无法漏出；被 pin 的映射**删除/改名/清空**都是硬 FAIL（清空绝不能被读成「无物可映射」）。真实未修的差异进 `ALLOWED_DIVERGENCES`（逐条带理由），**以 INFO 打印**故始终可见，新增差异一律 FAIL；条目**钉死到实测值**，形状一变即视为新差异，因此不会腐化成「万能借口」，两侧最终统一时报 STALE 而非静默保留。另有**非空下限**与文件内**自测**。反向证明：改坏任一侧的共享词、删掉某表的一个键、或清空被 pin 的词表，分别报 FAIL，且自测对三类各有一例。
- **本地化守卫 (`scripts/check-ui-i18n.mjs`，已接入 `pnpm test`)**: 内联 SPA 的模块体 `tsc` 不解析，故硬编码文案只能靠脚本兜住。已知两类缺陷——(1) 硬编码中文；(2) **硬编码英文**拼接进 DOM（`apiKeyMasked + ' (unchanged)'`，纯 ASCII，只查 CJK 的扫描看不见，中文界面里直接漏出英文）。守卫按**函数名大括号匹配**把模块体切成一组**具名区域**（设置面板与服务商主从、输入框工具栏、会话/状态渲染、转录/审批渲染、chrome/命令面板/历史渲染），**随新渲染器出现而增补，不锁死数量**——现为 5 区（`REGIONS` 各带 `minLines`），实测各区 200 行以上，会话/状态区植入缺陷即报 FAIL；第三、四、五区**当初缺席的原因不是豁免过期，而是这些渲染器从未被加进受保护函数名单**——**那是遗漏，不是一项仍然有效的豁免**（当时守卫头部注释记的豁免对象是 About 面板的 env dump 与 console 诊断，`none of which are user-visible copy`，从未提到状态面板标签；`runSlash`/`renderStatus` 最初也不在名单里）；持久教训是**豁免范围由其所覆盖的代码推导，代码变了必须重新推导，不能继承**。**值判定器的误报面（已识别、未修）**：`looksLikeCopy()` 只按字面量**值**分类，故任何不在封闭词表集合内的裸小写 token 都会被判为硬编码英文——`if (mode === 'deferred')` 这类**纯比较**即被报出（守卫自测以 `'deferred'` 作值轴对照，正是这一行为的可复现证据），外层 `dataset` 写入同理；根因是值轴**刻意的 position-blind**：它不知道字面量会落在哪里。值轴 `scanRegion` 把 `stringLiterals()` 过 `looksLikeCopy()`、过滤后报出，只看字面**值**；位置轴 `displayPositionLiterals()` 只报**同时**满足两条件的字面量：落在展示窗（`DISPLAY_PROPERTIES` / `DISPLAY_ATTRIBUTES` / `DISPLAY_CALLS` / `el()` 第 3 参）**且** `looksLikeCopy()` **拒绝**。故两轴对字面量**分区、不重叠**。**位置轴已随守卫交付**（`displayPositionLiterals()` 已接入 `scanRegion`，并有自测）；**被否决、未实施的是另一个变体：让值轴也跳过展示位字面量**——`' (unchanged)'` 恰被 `looksLikeCopy()` **接受**（故位置轴本就跳过它），若值轴也更进一步跳过展示位，则该类文案**两轴都不报**，是净减检测面的盲区而非修法；把否决与理由记在此处，防后人重提。**安全修法**：把 token 加进词表（`ENUM_TOKENS` 或相应集合）。值轴随之静默，该 token **移交给位置轴**，位置轴在其**全部**展示汇（`textContent`/`innerHTML`/`placeholder`/`title`、4 个 `DISPLAY_ATTRIBUTES`、3 个 `DISPLAY_CALLS`、`el()` 第 3 参）报出，而对比较、`dataset` 写入、`filter()` 谓词保持静默；因两轴分区，**扩词表必不产生盲区**——这是本条最重要、最不显然的不变量。**逃生舱仍不存在**：穷举 grep 确认无内联指令、无导出白名单（无 `export`/`module.exports`）、无配置文件，接受新 token 的唯一办法就是改守卫自己的词表。自测的**值盲缺口已识别并补齐**：位置轴负向对照只用 `'none'`（一个被值谓词拒绝的 token）断言 `displayPosition.length === 0`，故只见位置轴、观察不到紧邻的值轴，于是另加 `VOCABULARY_MISS_TOKEN`（`'deferred'`，不在任何词表集合内）作值轴专用对照，断言值轴在**非展示位**也报出它——一个无法在它所声称的轴上失败的测试什么都证明不了。**本次不提出任何检测改动**：上述补齐只作用于自测覆盖，不改任何检测规则本身；两轴并存于工作树（值轴 `scanRegion` + 位置轴 `displayPositionLiterals`），位置轴只报值谓词拒绝者。每个区域**独立提取、独立计行**，各有自己的**行数下限**（`minLines`：提取器落空时若不计行，所有字面量检查都会空转全绿，故低于下限即报错）外加一条并集下限；检查标签**带区域名**（`the ${label} region`），失败直接指出是哪个区而不是一个不透明的整体。`self-test` **对每个区域各跑一遍**同一套流水线（提取 → 去注释 → 字面量匹配 → 检测）：分别植入硬编码英文后缀（`' (unchanged)'`）与硬编码中文字面量并断言两者都被报出，另有一条负向对照断言合法的 CSS 类名/属性名/HTTP 路径/等级 token/分隔符**不**被当作文案——只测检测器本身证明不了「提取器真的到达了该区域」，把区域从列表里删掉或改名都会让整体检查悄悄变小却依旧全绿，只有按区重建 stub 才拦得住。检测器已重建为**负向定义**（一个字符串除非能被解释为键名/类名/DOM id/属性/标签/枚举 token/**ARIA role**/路径/单位/字形串/数字，否则即为文案；`ARIA_ROLE_NAMES` 收全 82 个封闭 role 名并与 `ENUM_TOKENS` 同列参与 `looksLikeCopy()` 的否决），且**刻意不再要求空白**——`'(root)'`/`'OK'`/`'Send'` 都是文案，旧的空白测试恰是它们漏网的原因；另有**静态标记扫描**：静态 HTML 里未带对应 `data-i18n*` 标注的文本节点与 `placeholder`/`title`/`aria-label` 属性值一律报错，仅 3 条真实例外进白名单（`SuperIU` 产品名、`sk-…` 凭据占位符、`https://api.openai.com/v1` 示例 URL，守卫各发一条 INFO）。**模块体仍不做全文件散文启发式**：全量扫描会把状态面板标签与诊断串一并报成噪音，逼人加白名单或越界 i18n 化。判定要点：zh/en 两张表按字面前缀**分别切片**后再取键（整文件取键得到的是两表并集，会放过「en 有而 zh 无」这类最高频缺陷）；`notify.*` 四个标题**故意双语**（macOS 通知横幅在页面语言上下文之外渲染），已在 en 表 CJK 检查中显式豁免。
- **单一在途轮次**: `runner.status !== 'idle'` 时新请求返回 `409`。
- **上下文用量表**: `/api/status` 带 `contextTokens` / `contextLimit` / `contextPercent`（0-100 整数，钳位）与 `reasoningEffort`（主路由**实际生效**的强度，模型不接受该参数时为 `''`——`o3-mini`、`gpt-6-*`、`gemini-3.8-flash`、`gemini-2.5-*`、`deepseek-flash`、`deepseek-v4-pro` 配 `high` 报 `high`；`gemini-1.5-*`、`gemini-2.0-*`、`gpt-4o` 与已下线的 `deepseek-chat`/`deepseek-reasoner` 仍报 `''`，因为 `supportsReasoningEffort()` 的白名单会摘掉它。白名单见 `model/router.ts` 的 `REASONING_MODEL_PATTERNS`，证据为各家官方文档：Gemini 的 OpenAI 兼容层把 `reasoning_effort` 映射到 `thinking_level`/`thinking_budget`，DeepSeek 的 OpenAI 格式面直接接受该参数）；`/api/chat` 的 `done` 帧带同样三个 `context*` 字段，在**最后一个 step 之后**读取，故反映轮次结束时的真实上下文大小。`/api/settings` 带 `modelMetadata`：按模型 id 索引的 `{ vision, tools, contextLimit, formattedContext }`，覆盖 `modelChoices` ∪ 每个 provider 的 `models[]` ∪ 当前两个已配置模型——手输的模型 id 也必须有窗口，否则用量表只能拿默认值当除数。`POST /api/model`（运行时切模型）**保留**引擎已测得的用量，只换除数；`POST /api/settings`（重建 runner）则清掉用量并回落到分支估算——两条路径都已在 `provider-settings-wire.ts` 中分别断言。
- **输入框工具栏（推理强度 · 主模型 · 上下文环）**: 输入框左下角三个状态控件，由 `renderStatus()` 末尾的 `renderComposerControls(status)` **单点写入**（状态轮询、语言切换、本地选择三处不会各说各话）。前两个是 `<button aria-haspopup aria-expanded>`，第三个是 `<span role="img">` 的**只读仪表**——没有可展开的东西，做成按钮就是谎称可操作，故无点击处理、不进 tab 序。两个 popover 一律**向上**展开（输入框钉在窗口底部，向下展开会把列表顶出屏外）。模型面板的 `renderModelPopover()` 每次打开与每次击键重建：分组顺序为 **当前**（仅当生效模型不被任何 provider 的 `models[]` 收录时才钉住——手改设置文件、或模型被移出 provider 都会留下这个缺口，不钉住就等于把正在跑的模型藏起来，选别的即失联）、**收藏**（`localStorage['superiu.favoriteModels']`，去重；解析失败按空处理，列表只是便利功能）、以及每个有模型的 provider；行内徽章取 `modelMetadata` 的 `vision`/`tools`/`formattedContext`；星标是行内嵌套按钮并 `stopPropagation()`——**行负责切换、星只负责书签**，否则收藏一个模型会顺手切过去。选中一行发**一次** `POST /api/settings`，同时带 `modelName` 与（仅当模型真的变了才带）`activeProviderId`：投影由两者共同算出，只发模型会让二者不一致；而**已生效模型那一行绝不带 provider**——从 `providers[].models` 反查出来的往往是**另一家**（恰好收录同一 id 的内置预设），发出去就静默切走了用户自己的网关与凭据（实测 custom → deepseek，baseURL 与 key 双丢），故渲染侧也在「当前 provider 收录该模型」时优先它。推理强度面板四行固定为 `''`/`low`/`medium`/`high`，每次打开重建（标签是字典查找，语言切换必须重解析）。**药丸与勾选行读两个不同的源，这是本节最要紧的一条**：药丸读 `/api/status.reasoningEffort`（主路由**实际生效**的等级，模型不接受该参数时为 `''`），勾选行读 `/api/settings.reasoningEffort`（**已存偏好**）。`POST /api/settings` 只校验取值能否解析、从不校验模型，重建 runner 也照常成功，故 **2xx 不能作为「已生效」的证据**，药丸绝不能因它移动；存储值仍然保留，因为切到可推理模型后它会生效——药丸把这段延迟写进 title（`已保存 —— 切换到支持推理的模型后生效`），面板在行下重复一条 hint。同理 `''` 那一行**不是「关闭」**：它是服务端的「派生」值，router 会给所有接受 `reasoning_effort` 的模型补上 `defaultReasoningEffort`（默认 `medium`，可被 `OPENAI_REASONING_EFFORT` 覆盖），而完全不接受该参数的模型什么都不补——标成「关闭」等于承诺静默却交付默认值，故沿用设置面板的措辞「未设置 —— 使用模型默认值」。上下文环的分子取 provider 自报的 `prompt_tokens`（最后一次 step），尚无 step 时回落到分支字符估算（≈3.5 字符/token），分母取 metadata 能力表；**因为工具栏的两种选择都走 `POST /api/settings`，而 `modelName` 或 `reasoningEffort` 真的变化时 `runnerChanged` 为真、会重建 runner，故一次生效的选择会让用量暂时回落到分支估算，直到下一步带回真实计数**（对比 `/api/model` 的运行时切换不重建 runner，因此保留已测得的用量）——这正是上文「两条路径分别断言」的另一面。环从 12 点方向填充，60% 转琥珀、85% 转红（长轮次开始压缩、下一步可能溢出的位置），并在 `/api/chat` 的 `done` 帧上就地重绘（该帧带同样三个 `context*` 字段），省掉一次额外往返。Esc 在全局 `capture` 监听里按层序关闭：先斜杠补全面板、再工具栏 popover、最后才是中止在途轮次——关掉一个模型列表绝不能杀掉本轮；面板内 ArrowUp/Down 循环移动 roving focus，Enter/Space 激活，选择后焦点回到触发器（光标原本在已隐藏的面板里），外部点击则不回焦（那是用户在主动移动焦点）。
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
