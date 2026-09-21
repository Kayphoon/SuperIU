import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pc from 'picocolors';
import { AgentRunner, resolveMemoryDir, type PermissionGate } from '@agent/core';

export async function startCli() {
  // Async setup must complete BEFORE the readline interface exists (see the
  // piped-stdin note below); the runner is synchronous, so the gate resolves the
  // interface lazily at call time instead of capturing it here.
  const memoryDir = await resolveMemoryDir();

  let rl: readline.Interface | undefined;

  /** Live approval prompts, cancelled when the turn is interrupted. */
  const cancelPendingApprovals = new Set<() => void>();

  /**
   * Terminal approval card. Anything AutoReview escalates (`ask_user`) lands
   * here: the developer sees the exact command and rationale, and decides.
   * Defaults to NO — an unanswered, closed, or non-interactive prompt must never
   * silently grant permission.
   */
  const permissionGate: PermissionGate = async (toolCall, review) => {
    const iface = rl;
    if (!iface) {
      return false;
    }

    output.write(
      `\n${pc.yellow('⚠ [Approval Required]')} ${pc.bold(toolCall.name)} ` +
        `${pc.dim(`(risk: ${review.riskLevel}, by ${review.reviewedBy})`)}\n`
    );
    output.write(`  ${pc.dim('reason:')} ${review.reason}\n`);
    output.write(`  ${pc.dim('args:  ')} ${JSON.stringify(toolCall.args)}\n`);

    return new Promise<boolean>((resolve) => {
      let settled = false;

      const finish = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        cancelPendingApprovals.delete(cancel);
        resolve(approved);
      };

      const cancel = (): void => finish(false);
      cancelPendingApprovals.add(cancel);

      // `readline/promises` rejects a pending question when the interface closes
      // (Ctrl+D, disconnect, aborted turn), so the rejection handler is the one
      // and only fail-closed path. A separate 'close' listener would race the
      // answer on piped stdin and could reject an approval the user just gave.
      iface.question(pc.bold('Approve this command? [y/N] ')).then(
        (answer) => finish(/^y(es)?$/i.test(answer.trim())),
        () => finish(false)
      );
    });
  };

  const runner = new AgentRunner({ permissionGate });

  let lastSigintTime = 0;
  rl = readline.createInterface({ input, output });

  // Intercept SIGINT for two-level interruption
  process.on('SIGINT', () => {
    if (runner.status !== 'idle') {
      // An in-flight approval prompt has no answer coming: cancel it first so
      // the loop can observe the abort instead of waiting forever.
      for (const cancel of [...cancelPendingApprovals]) {
        cancel();
      }
      runner.abort();
      output.write(`\n${pc.red('[Interrupted]')} Task aborted by user.\n`);
      return;
    }

    const now = Date.now();
    if (now - lastSigintTime < 2000) {
      output.write(`\n${pc.dim('Goodbye!')}\n`);
      process.exit(0);
    } else {
      lastSigintTime = now;
      output.write(`\n${pc.dim('Press Ctrl+C again or type /exit to quit.')}\n`);
      rl.prompt();
    }
  });

  // Welcome banner
  console.log(pc.bold(pc.cyan('\n=== SuperIU Autonomous Agent CLI ===')));
  console.log(pc.dim(`Memory directory: ${memoryDir}`));
  console.log(pc.dim(`Main model: ${runner.config.modelName}`));
  console.log(
    pc.dim(
      `Review model: ${runner.reviewer ? runner.config.reviewModelName : '(auto-review disabled)'}`
    )
  );
  console.log(pc.dim(`Session: ${runner.getSessionId()}`));
  console.log(pc.dim(`Log: ${runner.getSessionFile() ?? '(in-memory)'}`));
  console.log(pc.dim('Type /help for slash commands, or enter your task to begin.\n'));

  rl.setPrompt(pc.bold(pc.blue('agent> ')));
  rl.prompt();

  for await (const line of rl) {
    const inputLine = line.trim();
    if (!inputLine) {
      rl.prompt();
      continue;
    }

    // Slash command dispatch
    if (inputLine.startsWith('/')) {
      const [cmd, ...rest] = inputLine.split(/\s+/);
      switch (cmd.toLowerCase()) {
        case '/exit':
        case '/quit':
          console.log(pc.dim('Exiting...'));
          runner.close();
          rl.close();
          process.exit(0);

        case '/clear':
          runner.reset();
          console.log(pc.green('✔ reset_boundary appended; context truncated to empty.\n'));
          break;

        case '/status': {
          const status = runner.getStatus();
          const em = runner.emotion;
          const workstation = runner.getWorkstation();
          console.log(pc.bold('\nAgent Status:'));
          console.log(`  State:    ${pc.cyan(status.state)}`);
          console.log(`  Session:  ${pc.cyan(status.sessionId)}`);
          console.log(`  Leaf ID:  ${pc.cyan(status.leafId ?? '(root)')}`);
          console.log(`  Log file: ${status.sessionFile ?? '(in-memory)'}`);
          console.log(`  Messages: ${pc.yellow(String(status.messageCount))} in active branch`);
          console.log(
            `  Emotion:  Valence: ${pc.yellow(em.valence.toFixed(2))}, ` +
            `Arousal: ${pc.yellow(em.arousal.toFixed(2))}, ` +
            `Fatigue: ${pc.yellow(em.fatigue.toFixed(2))}`
          );
          console.log(`  OS:       ${workstation.os} (${workstation.arch})`);
          console.log(`  Main:     ${runner.config.modelName}`);
          console.log(
            `  Review:   ${runner.reviewer ? `${runner.config.reviewModelName} (${runner.reviewer.mode})` : 'disabled'}`
          );
          console.log(`  Approve:  ${runner.permissionGate ? 'interactive (this terminal)' : 'none'}`);
          console.log(`  Memory:   ${memoryDir}\n`);
          break;
        }

        case '/history': {
          const query = rest.join(' ').trim();
          const entries = runner.getHistory(query || undefined, 20);
          console.log(pc.bold(`\nPrompt History (${entries.length}):`));
          if (entries.length === 0) {
            console.log(pc.dim('  (empty)'));
          }
          for (const entry of entries) {
            const stamp = new Date(entry.createdAt).toISOString().slice(0, 19).replace('T', ' ');
            const preview = entry.prompt.length > 100 ? `${entry.prompt.slice(0, 97)}...` : entry.prompt;
            console.log(`  ${pc.dim(stamp)}  ${preview}`);
          }
          console.log();
          break;
        }

        case '/sessions': {
          const sessions = runner.listSessions();
          console.log(pc.bold(`\nSessions (${sessions.length}):`));
          for (const session of sessions) {
            const active = session.id === runner.getSessionId() ? pc.green('* ') : '  ';
            const stamp = session.timestamp.slice(0, 19).replace('T', ' ');
            console.log(`${active}${pc.cyan(session.id)}  ${pc.dim(stamp)}  ${session.title ?? ''}`);
            console.log(`    ${pc.dim(session.filePath)}`);
          }
          console.log();
          break;
        }

        case '/load': {
          const reference = rest.join(' ').trim();
          if (!reference) {
            console.log(pc.red('Usage: /load <session-id|file-name|path>\n'));
            break;
          }
          try {
            const session = runner.loadSession(reference);
            console.log(
              pc.green(`✔ Loaded session ${session.getSessionId()} (${session.buildSessionContext().length} messages)\n`)
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(pc.red(`✖ ${message}\n`));
          }
          break;
        }

        case '/new': {
          const session = runner.createSession(rest.join(' ').trim() || undefined);
          console.log(pc.green(`✔ New session ${session.getSessionId()}\n`));
          console.log(pc.dim(`  ${session.getFilePath() ?? '(in-memory)'}\n`));
          break;
        }

        case '/memory': {
          console.log(pc.dim('Analyzing the active conversation for durable facts...'));
          try {
            const result = await runner.extractMemory();
            if (result.summary) {
              console.log(pc.green(`✔ ${result.summary}\n`));
            } else {
              console.log(pc.dim('  Nothing new to remember.\n'));
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(pc.red(`✖ Memory extraction failed: ${message}\n`));
          }
          break;
        }

        case '/help':
          console.log(pc.bold('\nAvailable Slash Commands:'));
          console.log(`  ${pc.cyan('/status')}   - Show state, session id, JSONL path, leaf id, branch length`);
          console.log(`  ${pc.cyan('/clear')}    - Append reset_boundary and truncate the active context`);
          console.log(`  ${pc.cyan('/history')}  - Show recent prompt history (optionally filtered)`);
          console.log(`  ${pc.cyan('/sessions')} - List JSONL sessions for this workspace`);
          console.log(`  ${pc.cyan('/load')}     - Load a session by id, file name, or path`);
          console.log(`  ${pc.cyan('/new')}      - Start a fresh JSONL session`);
          console.log(
            `  ${pc.cyan('/memory')}   - Extract durable facts from this conversation into MEMORY.md / USER.md`
          );
          console.log(`  ${pc.cyan('/help')}     - Display this help message`);
          console.log(`  ${pc.cyan('/exit')}     - Exit CLI\n`);
          break;

        default:
          console.log(pc.red(`Unknown command: ${cmd}. Type /help for available commands.\n`));
      }

      rl.prompt();
      continue;
    }

    // Agent task execution
    try {
      let activeToolStartTime = 0;

      await runner.run(inputLine, {
        onStatusChange: (status) => {
          if (status === 'thinking') {
            output.write(pc.dim('\nThinking...\n'));
          }
        },
        onChunk: (text) => {
          output.write(text);
        },
        onToolCall: (name, args) => {
          activeToolStartTime = Date.now();
          const argsStr = JSON.stringify(args);
          const preview = argsStr.length > 80 ? `${argsStr.slice(0, 77)}...` : argsStr;
          output.write(`\n${pc.yellow(`⚙ [Tool] ${name}: ${preview}`)}\n`);
        },
        onToolResult: (name, result, isError) => {
          const duration = activeToolStartTime ? Date.now() - activeToolStartTime : 0;
          const detail = typeof result === 'string' ? result.split('\n')[0] : '';
          if (isError) {
            output.write(`\n${pc.yellow(`⚠ [Blocked] ${name}: ${detail}`)}\n`);
          } else {
            output.write(pc.green(`✔ [Done] ${name} (${duration}ms)\n`));
          }
        },
        onError: (err) => {
          output.write(`\n${pc.red(`✖ [Error] ${err.message}`)}\n`);
        }
      });

      output.write('\n\n');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== '[Task aborted by user]') {
        output.write(`\n${pc.red(`Execution failed: ${message}`)}\n\n`);
      }
    }

    rl.prompt();
  }

  runner.close();
}

// Auto-run when executed directly
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  startCli().catch((err) => {
    console.error(pc.red(`Fatal error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  });
}
