---
name: wiki-architecture-one-core-two-shells
description: |
  SuperIU "单核双驱" (One Core, Two Shells) 技术架构与核心机制
  - @agent/core 与 @agent/cli 单向依赖与物理隔离
  - 三层记忆模型 (SOUL / USER / MEMORY) 与系统提示词注入
  - Valence-Arousal 情绪半衰期衰减与姿态修饰
  - 2000 字符 Spillover 磁盘熔断与上下文保护
---

# "单核双驱" (One Core, Two Shells) 架构规范

## 快速参考

| 组件 | 对应包 | 职责边界 | 禁止行为 |
|---|---|---|---|
| Core (单核) | `@agent/core` | 状态机流转、模型调用、多步执行循环、三层记忆、情绪模型、工具执行 | 严禁引入终端颜色、键盘监听或 GUI 表现层依赖 |
| CLI (外壳 1) | `@agent/cli` | 终端 REPL、readline 交互、流式打字输出、着色指示器、两级 Ctrl+C 打断、斜杠指令 | 严禁直接侵入工具底层实现，统一通过 `AgentRunner` 交互 |
| Web/Desktop (外壳 2) | 预留扩容 | 桌面端 UI 或 Web 端可视化操作 | 复用 `@agent/core`，不依赖 CLI |

## 核心机制

### 1. 三层记忆体系 (`src/memory/manager.ts`)
- **优先级**: 当前工作区 `.myagent/` > 用户主目录 `~/.myagent/`。
- **三层文件**:
  1. `SOUL.md`: Agent 身份定义、专业务实工程师基调、行为原则。
  2. `USER.md`: 用户环境（OS、Shell、输出风格偏好）。
  3. `MEMORY.md`: 长期跨会话事实知识库。
- **自动初始化**: 文件不存在时由系统自动创建默认模板。

### 2. Valence-Arousal 情绪状态机 (`src/emotion/engine.ts`)
- **三维状态**:
  - `valence`: [-1.0, 1.0]，负向到正向，基线 `0.0`。
  - `arousal`: [0.0, 1.0]，平静到激越，基线 `0.2`。
  - `fatigue`: [0.0, 1.0]，充沛到疲劳，基线 `0.0`。
- **半衰期衰减**: 默认 5 分钟半衰期，向基线指数衰减。
- **Operational Posture 提示词修饰**:
  - `fatigue > 0.7`: 追加极简输出指示，过滤客套废话。
  - `valence < -0.3`: 强化对潜在 Bug 与异常情况的审慎聚焦。
  - `arousal > 0.6`: 驱动主动推进复杂多步逻辑验证。

### 3. Spillover 磁盘熔断机制 (`src/spillover.ts`)
- **阈值**: 单次工具输出超过 2,000 字符触发熔断。
- **落盘**: 写入 `~/.myagent/spillover/spillover-<timestamp>-<id>.log`。
- **摘要**: 向大模型注入头部 800 字符 + 尾部 800 字符预览，附带 `read_file` 针对性读取指引，防止上下文窗口被冗余日志挤爆。

### 4. Agent Loop 与工具体系 (`src/runner.ts` & `src/tools/`)
- **循环机制**: 基于 Vercel AI SDK `streamText`，支持最多 10 步 (`maxSteps: 10`) 自主工具交互。通过 `fullStream` 驱动 `streaming`、`tool_calling` 等状态流转。
- **内置工具集 (3个)**:
  1. `bash`: 基于独立进程组（`detached: true`）与负 PID 强杀的命令执行沙箱。
  2. `read_file`: 基于 1-based 行号切片读取文件，内置 Spillover 保护。
  3. `write_file`: 递归自动创建目录的文件写入工具。

## 相关知识

- [[wiki-execa-process-tree-kill]] - Bash 工具沙箱进程树安全机制
