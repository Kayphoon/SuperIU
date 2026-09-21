# 架构方案：全面对齐 Oh My Pi (omp) 原生 Agent Loop 与会话持久化架构规范

## Context
根据指令，SuperIU 将全面深度对齐 **Oh My Pi (omp)** 的工业级核心架构规范：
1. **会话存储采用 omp 原生规范（JSONL 树形追加日志）**：
   - 彻底告别脆弱的单表 SQLite 存储会话；
   - 会话文件采用 `.jsonl` 追加写格式，存储路径为 `.myagent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`；
   - 严格遵循 omp Version 3 协议：首行为 `type: "session"` Header，后续每行为带 `id` 与 `parentId` 的 `SessionEntry`；
   - 支持完整的 Tree & Leaf 状态机语义：通过 `leafId` 追踪当前会话分叉，`/clear` 写入 `reset_boundary` 标记，支持 `buildSessionContext` 动态回溯与上下文重组。
2. **提示词检索库独立持久化（SQLite Prompt History）**：
   - 按照 omp 规范（`omp://session.md`），`HistoryStorage` 采用内置 `node:sqlite`（`.myagent/history.db`）独立承载用户输入命令与 Prompt 历史检索（`history` 表），与会话分叉树解耦。
3. **无界自主循环（Unbounded Autonomous Loop）与沙箱强杀**：
   - `while (true)` 自然收敛，剥离 AI SDK 的 `execute` 劫持，Loop 引擎独占工具调度执行权；
   - Spillover 2000 字符磁盘熔断与工具报错自愈回填；
   - 独立进程组（`detached: true`）与负 PID 强杀。
4. **动态工作站与系统指令装配**：
   - 每轮提示词动态注入 `<workstation>`（OS、Arch、Node、CWD、Git 分支、时间戳）与 `SOUL.md`、`MEMORY.md`、`USER.md`。

---

## 架构全景图 (全面对齐 omp)

```mermaid
flowchart TD
    subgraph SessionStorage [会话存储层 (omp JSONL Tree)]
        JSONLFile[.myagent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl]
        HeaderLine[Line 1: type=session Header]
        EntryLines[Line 2+: SessionEntry id, parentId, type, message...]
        JSONLFile --- HeaderLine
        JSONLFile --- EntryLines
        
        SM[SessionManager: leafId 指针 + 树形索引 Map]
        JSONLFile <-->|追加写与上下文回溯| SM
    end

    subgraph PromptHistory [Prompt 检索层 (SQLite)]
        HDB[(.myagent/history.db)]
        HTable[history 表: prompt, created_at, cwd, session_id]
        HDB --- HTable
    end

    subgraph ContextSystem [动态上下文装配层]
        WS[<workstation>: OS/Arch/CWD/Time/Git] --> Assembler[ContextAssembler]
        Mem[SOUL.md + USER.md + MEMORY.md] --> Assembler
        SM -->|buildSessionContext leafId回溯| RawMsgs[活跃链条消息] --> Assembler
        Assembler -->|即时组装| ModelContext[System Prompt + CoreMessage[]]
    end

    subgraph LoopEngine [无界 Agent Loop 引擎]
        ModelContext --> StepCaller[AiSdkStepAdapter 单步生成]
        StepCaller -->|tool-calls| Dispatcher[Loop 工具调度执行器]
        
        Dispatcher --> BashTool[Bash 沙箱 + detached 进程组]
        Dispatcher --> FsTool[ReadFile / WriteFile + Spillover]
        
        BashTool & FsTool -->|输出/报错自愈| Compactor[ContextCompactor 2000 字符熔断]
        Compactor --> RecordTool[格式化为 toolResult Entry]
        
        RecordTool -->|写入| SM
        RecordTool --> NextIter{有无 tool_call?}
        NextIter -->|有: 自主进入下一步| Assembler
        NextIter -->|无: 任务收敛完成| Done([退出循环])
    end
```

---

## 核心技术规范设计

### 1. 会话文件与 JSONL 规范 (`packages/core/src/session/`)
对齐 omp 核心规范：
- **目录编码 (`encodeCwd`)**：将工作区绝对路径转义为安全目录名（如 `/Users/kayphoon/SuperIU` 编码为 `-Users-kayphoon-SuperIU`）。
- **文件命名**：`${timestamp}_${sessionId}.jsonl`。
- **Header 结构**：
  ```json
  {
    "type": "session",
    "version": 3,
    "id": "c1f9d2a6b9c0d123",
    "timestamp": "2026-09-21T12:00:00.000Z",
    "cwd": "/Users/kayphoon/SuperIU",
    "title": "Initial Session",
    "titleSource": "auto"
  }
  ```
- **Entry 基础字段**：
  ```json
  {
    "type": "message",
    "id": "8-char-hex",
    "parentId": "previous-id-or-null",
    "timestamp": "2026-09-21T12:00:01.000Z",
    "message": {
      "role": "user" | "assistant" | "toolResult",
      "content": "...",
      "toolCalls": [...],
      "toolResults": [...]
    }
  }
  ```
- **特殊 Entry 类型**：
  - `reset_boundary`：`/clear` 触发时写入，不修改历史行，上下文构建遇到它后仅保留其后的消息。
  - `compaction`：长会话压缩摘要记录。
  - `branch_summary`：分支放弃摘要记录。

### 2. 上下文重组算法 (`buildSessionContext`)
从当前 `leafId` 出发，沿 `parentId` 追溯至根节点，翻转为时间正序：
1. 若遇到 `reset_boundary`，截断此标记前的历史消息；
2. 过滤掉未完成的孤儿调用；
3. 输出线性 `CoreMessage[]` 供模型单步消费。

### 3. Prompt 历史独立存储 (`packages/core/src/storage/history.ts`)
- 采用 `node:sqlite` 操作 `.myagent/history.db`；
- 表结构：
  ```sql
  CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    session_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_cwd ON history(cwd, created_at);
  ```
- 提供 `append(prompt, cwd, sessionId)` 与 `search(cwd, query, limit)`。

### 4. 彻底解决 Tool Execute 双重执行风险
- `AiSdkStepAdapter`: 传入 `streamText` 前过滤掉工具的 `execute` 属性，让 AI SDK 纯粹作为模式声明生成 `tool-call`；
- `AgentLoopEngine`: 拥有唯一的工具执行权力，执行完成后记录到 `SessionManager`（附带 `toolResult`），保证单次执行并记录耗时与报错。

---

## Approach (实施步骤)

### 步骤 1：构建 omp 原生 Session 模块 (`packages/core/src/session/`)
新建 `packages/core/src/session/`：
- `types.ts`:
  - `SessionHeader`: `{ type: 'session', version: 3, id, timestamp, cwd, title, titleSource }`
  - `SessionEntryBase`: `{ id, parentId, timestamp }`
  - `SessionMessageEntry`: `{ type: 'message', message: ContextMessage }`
  - `SessionResetBoundaryEntry`: `{ type: 'reset_boundary' }`
  - `SessionCompactionEntry`: `{ type: 'compaction', summary, firstKeptEntryId }`
  - `SessionEntry` 联合类型。
- `paths.ts`:
  - `encodeCwd(cwd: string): string`: 对齐 omp 路径编码；
  - `getSessionDir(workspaceDir?: string): string`: 解析 `.myagent/sessions/<encoded-cwd>`；
  - `createSessionFilePath(sessionId: string, timestamp: number, workspaceDir?: string): string`。
- `manager.ts` (`SessionManager`):
  - 维护内存索引 `entriesById: Map<string, SessionEntry>`、`children: Map<string | null, SessionEntry[]>`、`leafId: string | null`；
  - 提供方法：
    - `open(filePath: string): SessionManager`
    - `create(workspaceDir?: string, title?: string): SessionManager`
    - `appendEntry(entry: Omit<SessionEntry, 'id' | 'parentId' | 'timestamp'>): SessionEntry`
    - `appendMessage(message: ContextMessage): SessionEntry`
    - `clear(): void`: 追加 `reset_boundary` 标记并更新 `leafId`；
    - `branch(entryId: string): void`: 切换分支 `leafId`；
    - `buildSessionContext(leafId?: string): ContextMessage[]`
    - `flush(): void` / `close(): void`
- `discovery.ts`:
  - `listSessions(workspaceDir?: string): SessionHeader[]`
  - `findMostRecentSession(workspaceDir?: string): string | null`

### 步骤 2：实现独立 Prompt History 存储 (`packages/core/src/storage/history.ts`)
- 新建 `packages/core/src/storage/history.ts` (`PromptHistoryStorage`):
  - 使用 `node:sqlite` 连接 `.myagent/history.db`；
  - 记录用户输入并支持历史检索。

### 步骤 3：重构 ContextAssembler 与 AgentLoopEngine 接入 SessionManager
- `packages/core/src/context/assembler.ts`:
  - 接收 `SessionManager`，调用 `sessionManager.buildSessionContext()` 获取当前活跃分支消息；
  - 注入 `<w。
- `packages/core/src/loop/engine.ts`:
  - 协调 `SessionManager`；
  - 剥离工具 `execute` 传入 `AiSdkStepAdapter`；
  - 独占调度工具执行，捕获异常进行自愈回填，并将结果追加至 JSONL 会话流。

### 步骤 4：重构 AgentRunner 与 Core 统一导出
- `packages/core/src/runner.ts`:
  - 持有 `SessionManager` 与 `PromptHistoryStorage`；
  - 支持 `loadSession(sessionIdOrPath)`、`createSession()`、`reset()` (`/clear`)；
  - `run(prompt, callbacks)` 写入 Prompt History，并驱动 `AgentLoopEngine`。
- `packages/core/src/index.ts`:
  - 导出 `SessionManager`、`PromptHistoryStorage`、`AgentLoopEngine`、`AiSdkStepAdapter` 等核心类。

### 步骤 5：升级 CLI 交互层 (`packages/cli/src/index.ts`)
- 接入 omp 风格的会话管理：
  - 启动时自动恢复或创建针对当前工作区的 JSONL 会话文件；
  - `/status`: 显示 Session ID、JSONL 文件路径、Leaf ID、消息链条长度；
  - `/clear`: 追加 `reset_boundary`，清空当前上下文；
  - `/history`: 打印最近 Prompt 检索历史。

### 步骤 6：更新自动化冒烟测试集 (`scripts/smoke-test.ts`)
- 验证 JSONL 文件持久化格式与 Header 规范；
- 验证 `parentId` 与 `leafId` 树形链路；
- 验证 `/clear` 写入 `reset_boundary` 后 `buildSessionContext` 正确截断历史；
- 验证工具单次执行无重复；
- 验证多步自主收敛与工具报错自愈；
- 验证 SQLite Prompt History 读写。

### 步骤 7：撰写高人类可读性全景架构技术白皮书 (`docs/agent-loop-and-context-architecture.md`)
- 撰写图文并茂的白皮书，覆盖：
  1. omp 架构演进与设计哲学；
  2. JSONL 会话树模型与 Leaf 指针状态机；
  3. `while (true)` 无界循环与工具执行权独占设计；
  4. `<workstation>` 动态感知与三层记忆上下文；
  5. 开发者 API 实战指南与时序流转图。

---

## Critical Files & Anchors
1. `packages/core/src/session/manager.ts`: omp 规范的 `SessionManager`，负责 JSONL 追加写与 `buildSessionContext` 回溯。
2. `packages/core/src/session/types.ts`: SessionHeader 与 SessionEntry 契约定义。
3. `packages/core/src/storage/history.ts`: 基于 `node:sqlite` 的独立 Prompt 检索数据库。
4. `packages/core/src/loop/engine.ts`: 无界循环引擎与独占工具执行器。
5. `packages/core/src/runner.ts`: 顶层 Agent 运行外观。
6. `docs/agent-loop-and-context-architecture.md`: 全景技术白皮书。

---

## Verification
1. **类型检查**：`pnpm -r typecheck`，0 类型错误。
2. **构建输出**：`pnpm -r build`，编译成功。
3. **自动化冒烟**：执行 `node scripts/smoke-test.ts`，全量验证 JSONL 存储、树形链路、reset_boundary 隔离、工具独占执行与报错自愈。
4. **CLI 交互验证**：运行 `node packages/cli/dist/index.js`，运行多步任务并在 `.myagent/sessions/` 中查看实际生成的 `.jsonl` 内容。
