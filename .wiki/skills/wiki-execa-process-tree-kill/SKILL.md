---
name: wiki-execa-process-tree-kill
description: |
  execa v9 在 shell 模式下的孤儿进程泄漏与进程组强杀方案
  - execa cancelSignal/timeout 仅杀主进程的缺陷
  - detached 独立进程组与负 PID 信号广播
  - SIGTERM/SIGKILL 优雅升级与超时清理
---

# execa v9 进程树强杀与孤儿泄漏防护

## 快速参考

| 配置项 / 操作 | 正确做法 | 错误 / 陷阱做法 |
|---|---|---|
| 进程组独立 | `detached: process.platform !== 'win32'` | 默认或 `detached: false`（导致子进程属于父进程组） |
| 信号广播 | `process.kill(-pid, 'SIGKILL')` | `subprocess.kill()` 或 `execa.cancel()`（仅杀 shell 外壳） |
| gracefulCancel | 避免在硬超时或打断时开启 | `gracefulCancel: true` 会一直等待子进程自然退出 |

## 核心机制与陷阱分析

### 1. 根因分析
在 Node.js 中使用 `execa(command, { shell: true })` 时，系统底层会启动外层 Shell（如 `/bin/sh -c "<command>"`）。
- 若仅针对外层 Shell 触发终止信号（或使用 execa 的 `cancelSignal` / `timeout`），仅会杀死 `sh` 进程。
- 派生的子进程（如 `sleep`、编译任务或后台长连接服务）会脱壳成为孤儿进程，并继续持有 `stdout` / `stderr` 文件描述符。
- 这会导致 Node.js 的管道处于打开状态，Promise 持续挂起，造成伪卡死或资源泄漏。

### 2. 标准防御实现

在 `@agent/core/src/tools/bash.ts` 中采用以下安全模式：

```typescript
const subprocess = execa(command, {
  shell: true,
  cwd,
  detached: process.platform !== 'win32',
  reject: false
});

const killTree = (sig: NodeJS.Signals = 'SIGKILL') => {
  const pid = subprocess.pid;
  if (typeof pid === 'number' && pid > 0) {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, sig); // 负 PID 向整个进程组广播
        return;
      } catch {
        // ESRCH (已退出) 忽略
      }
    }
    try {
      process.kill(pid, sig);
    } catch {}
  }
  try {
    subprocess.kill(sig);
  } catch {}
};
```

### 3. 超时与取消绑定
- **主动打断 (AbortSignal)**: 收到 `abort` 事件直接触发 `killTree('SIGKILL')`。
- **超时保护 (30s)**: 计时器触发时先发送 `killTree('SIGTERM')`，并在 2 秒后强制升级为 `killTree('SIGKILL')`。
- **资源清理**: 必须在 `finally` 块中调用 `clearTimeout` 并移除事件监听器。

## 相关知识

- [[wiki-architecture-one-core-two-shells]] - Agent Core 架构与工具沙箱
