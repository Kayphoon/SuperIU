---
name: wiki-fix-readline-piped-stdin-20260921
description: |
  Node.js readline 在管道 stdin 下静默丢弃全部输入的根因与修复
  - createInterface 早于 await 时，EOF 会在 await 期间关闭 interface
  - 症状：TTY 交互正常，`printf ... | node cli.js` 无任何输出且立即退出
  - 修复：所有 async 准备完成后才创建 readline interface
  - 验证手法：`console.error` 插桩定位，最小复现脚本比对
---

# readline 管道输入静默丢失 (piped stdin dropped)

## 快速参考

| 项目 | 内容 |
|---|---|
| 症状 | `printf 'cmd\n' \| node dist/index.js` 无输出、立即退出（exit 0）；TTY 下手动交互完全正常 |
| 根因 | `readline.createInterface()` 创建后、`for await` 消费前存在 `await`，管道 EOF 在此期间到达并关闭 interface |
| 修复 | 把所有 async 初始化移到 `createInterface()` **之前** |
| 复现文件 | 见下文最小复现 |
| 首次发现 | `packages/cli/src/index.ts`（`startCli`） |

## 根因分析

管道 stdin 在写入端关闭后立即到达 EOF，**不等待消费方就绪**。若此时存在如下顺序：

```typescript
const rl = readline.createInterface({ input, output });  // 1. 先创建
await resolveMemoryDir();                                 // 2. 再 await
rl.setPrompt('agent> ');
rl.prompt();
for await (const line of rl) { ... }                      // 3. 最后才消费
```

在步骤 2 的 await 期间，`readline` 收到 EOF → `close` 事件 → interface 标记为已关闭。步骤 3 的 `for await` 附着到一个已关闭的异步迭代器，**立即结束且不产出任何行**。

TTY 场景不受影响，因为终端不会自行产生 EOF（EOF 需用户显式 Ctrl+D），所以这个 bug 只在脚本化 / CI / 自动化驱动时暴露。

## 最小复现

```javascript
// rl-probe4.mjs
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as fs from 'node:fs/promises';

const rl = readline.createInterface({ input, output });
await fs.mkdir('/tmp/rl-probe-dir', { recursive: true });   // 异步间隙
rl.setPrompt('agent> ');
rl.prompt();
for await (const line of rl) {
  console.log('GOT', JSON.stringify(line));
}
console.log('END');
```

```bash
printf 'a\nb\n' | node rl-probe4.mjs
# 输出: "agent> " 后直接挂起/退出，GOT 一行都没有
```

对照实验（顺序正确）会正常打印 `GOT "a"` / `GOT "b"`。

## 修复

```typescript
export async function startCli() {
  const runner = new AgentRunner();

  // 所有 async 准备都在创建 readline 之前完成
  const memoryDir = await resolveMemoryDir();

  const rl = readline.createInterface({ input, output });
  process.on('SIGINT', () => { /* ... */ });

  console.log(/* banner */);
  rl.setPrompt('agent> ');
  rl.prompt();

  for await (const line of rl) { /* ... */ }
}
```

注意 `SIGINT` 监听器回调里引用了 `rl`——把它注册在 `createInterface()` 之后即可（回调是延迟执行的，不构成创建顺序约束）。

## 排错手法

1. **插桩定位**：在可疑位置 `console.error`（走 stderr 不干扰 stdout 管道），确认循环体是否执行。
2. **最小复现**：把 CLI 逻辑裁剪到只剩 `createInterface` + `await` + `for await`，逐一增删 async 步骤，二分定位间隙。
3. **对照实验**：把 `await` 去掉，输入立刻恢复——即可确认是创建顺序而非 stdin 重定向本身的问题。

```bash
# 插桩（stderr）不受 stdout 管道影响
printf 'a\n' | node cli-instrumented.js 2>&1
```

## 相关知识

- [[wiki-architecture-one-core-two-shells]] - CLI 外壳层职责与交互边界
