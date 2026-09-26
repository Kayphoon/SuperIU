import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pc from 'picocolors';
import { AgentRunner, resolveMemoryDir, type PermissionGate } from '@agent/core';
import { resolveLanguage, t } from './language.js';

export async function startCli() {
  // Async setup must complete BEFORE the readline interface exists (see the
  // piped-stdin note below); the runner is synchronous, so the gate resolves the
  // interface lazily at call time instead of capturing it here.
  const memoryDir = await resolveMemoryDir();
  const language = resolveLanguage();
  const tr = (key: string, params?: Record<string, string | number>) => t(language, key, params);

  let rl: readline.Interface | undefined;

  /** Live approval prompts, cancelled when the turn is interrupted. */
  const cancelPendingApprovals = new Set<() => void>();

  /**
   * `riskLevel`, `reviewedBy` and `mode` are internal enums ('low', 'rule',
   * 'lenient'); they are mapped to words here so a surface never shows a raw
   * token. A value from a newer core than this dictionary knows degrades to a
   * neutral word.
   */
  const riskWordKeys: Record<string, string> = {
    safe: 'cli.approval.riskSafe',
    low: 'cli.approval.riskLow',
    medium: 'cli.approval.riskMedium',
    high: 'cli.approval.riskHigh',
    critical: 'cli.approval.riskCritical',
  };
  const reviewerWordKeys: Record<string, string> = {
    rule: 'cli.approval.reviewerRule',
    model: 'cli.approval.reviewerModel',
  };
  const modeWordKeys: Record<string, string> = {
    lenient: 'cli.status.modeLenient',
    strict: 'cli.status.modeStrict',
  };

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

    const risk = tr(riskWordKeys[review.riskLevel] ?? 'cli.approval.riskUnknown');
    const reviewer = tr(reviewerWordKeys[review.reviewedBy] ?? 'cli.approval.reviewerUnknown');
    output.write(
      `\n${pc.yellow(tr('cli.approval.title'))} ${pc.bold(toolCall.name)} ` +
        `${pc.dim(`(${tr('cli.approval.risk')}: ${risk}, ${tr('cli.approval.by')} ${reviewer})`)}\n`
    );
    output.write(`  ${pc.dim(tr('cli.approval.reason'))} ${review.reason}\n`);
    output.write(`  ${pc.dim(tr('cli.approval.args'))} ${JSON.stringify(toolCall.args)}\n`);

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
      iface.question(pc.bold(tr('cli.approval.question'))).then(
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
      output.write(`\n${pc.red(tr('cli.interrupted'))} ${tr('cli.abortedByUser')}\n`);
      return;
    }

    const now = Date.now();
    if (now - lastSigintTime < 2000) {
      output.write(`\n${pc.dim(tr('cli.goodbye'))}\n`);
      process.exit(0);
    } else {
      lastSigintTime = now;
      output.write(`\n${pc.dim(tr('cli.abortHint'))}\n`);
      rl.prompt();
    }
  });

  // Welcome banner. Deliberately free of filesystem paths — `/status` is the
  // diagnostics surface that reports the memory directory and the session log.
  console.log(pc.bold(pc.cyan(`\n${tr('cli.banner')}`)));
  console.log(pc.dim(tr('cli.mainModel', { model: String(runner.config.modelName) })));
  console.log(
    pc.dim(
      tr('cli.reviewModel', {
        model: runner.reviewer
          ? String(runner.config.reviewModelName)
          : tr('cli.reviewDisabled'),
      })
    )
  );
  console.log(pc.dim(tr('cli.session', { id: runner.getSessionId() })));
  console.log(pc.dim(`${tr('cli.hint')}\n`));

  rl.setPrompt(pc.bold(pc.blue(tr('cli.prompt'))));
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
          console.log(pc.dim(tr('cli.exiting')));
          runner.close();
          rl.close();
          process.exit(0);

        case '/clear':
          runner.reset();
          console.log(pc.green(`${tr('cli.clear.ok')}\n`));
          break;

        case '/status': {
          const status = runner.getStatus();
          const em = runner.emotion;
          const workstation = runner.getWorkstation();
          console.log(pc.bold(`\n${tr('cli.status.header')}`));
          console.log(`  ${tr('cli.status.state')}${pc.cyan(tr(`status.${status.state}`))}`);
          console.log(`  ${tr('cli.status.session')}${pc.cyan(status.sessionId)}`);
          console.log(`  ${tr('cli.status.leaf')}${pc.cyan(status.leafId ?? tr('cli.status.root'))}`);
          const logFile = status.sessionFile ?? tr('cli.inMemory');
          // A draft plans a path without writing it; do not present it as a log.
          console.log(
            `  ${tr('cli.status.logFile')}${logFile}${status.sessionFile && !status.sessionPersisted ? tr('cli.logNotWritten') : ''}`
          );
          console.log(
            `  ${tr('cli.status.messages')}${pc.yellow(String(status.messageCount))}${tr('cli.status.messagesSuffix')}`
          );
          console.log(
            `  ${tr('cli.status.emotion')}${tr('cli.status.valence')}${pc.yellow(em.valence.toFixed(2))}` +
            `${tr('cli.status.emotionSep')}${tr('cli.status.arousal')}${pc.yellow(em.arousal.toFixed(2))}` +
            `${tr('cli.status.emotionSep')}${tr('cli.status.fatigue')}${pc.yellow(em.fatigue.toFixed(2))}`
          );
          console.log(`  ${tr('cli.status.os')}${workstation.os} (${workstation.arch})`);
          console.log(`  ${tr('cli.status.main')}${runner.config.modelName}`);
          console.log(
            `  ${tr('cli.status.review')}${runner.reviewer ? `${runner.config.reviewModelName} (${tr(modeWordKeys[runner.reviewer.mode] ?? 'cli.status.modeUnknown')})` : tr('cli.status.reviewDisabled')}`
          );
          console.log(
            `  ${tr('cli.status.approve')}${runner.permissionGate ? tr('cli.status.approveInteractive') : tr('cli.status.approveNone')}`
          );
          console.log(`  ${tr('cli.status.memory')}${memoryDir}\n`);
          break;
        }

        case '/history': {
          const query = rest.join(' ').trim();
          const entries = runner.getHistory(query || undefined, 20);
          console.log(pc.bold(`\n${tr('cli.history.header', { count: entries.length })}`));
          if (entries.length === 0) {
            console.log(pc.dim(`  ${tr('cli.history.empty')}`));
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
          console.log(pc.bold(`\n${tr('cli.sessions.header', { count: sessions.length })}`));
          for (const session of sessions) {
            const active = session.id === runner.getSessionId() ? pc.green('* ') : '  ';
            const stamp = session.timestamp.slice(0, 19).replace('T', ' ');
            // No file path here: `/status` reports the log of the active session,
            // and a routine listing is about picking a conversation, not a file.
            // An unnamed session carries no title, so a bare `${title ?? ''}`
            // would leave a dangling gap after the timestamp.
            console.log(
              `${active}${pc.cyan(session.id)}  ${pc.dim(stamp)}  ${session.title ?? tr('cli.sessions.untitled')}`
            );
          }
          console.log();
          break;
        }

        case '/load': {
          const reference = rest.join(' ').trim();
          if (!reference) {
            console.log(pc.red(`${tr('cli.load.usage')}\n`));
            break;
          }
          try {
            const session = runner.loadSession(reference);
            console.log(
              pc.green(
                `${tr('cli.load.ok', {
                  id: session.getSessionId(),
                  count: session.buildSessionContext().length,
                })}\n`
              )
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(pc.red(`${tr('cli.load.failed', { message })}\n`));
          }
          break;
        }

        case '/new': {
          const session = runner.createSession(rest.join(' ').trim() || undefined);
          console.log(pc.green(`${tr('cli.new.ok', { id: session.getSessionId() })}\n`));
          break;
        }

        case '/memory': {
          console.log(pc.dim(tr('cli.memory.analyzing')));
          try {
            const result = await runner.extractMemory();
            if (result.summary) {
              console.log(pc.green(`✔ ${result.summary}\n`));
            } else {
              console.log(pc.dim(`  ${tr('cli.memory.none')}\n`));
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(pc.red(`${tr('cli.memory.failed', { message })}\n`));
          }
          break;
        }

        case '/help':
          console.log(pc.bold(`\n${tr('cli.help.header')}`));
          console.log(`  ${pc.cyan('/status')}   - ${tr('cli.help.status')}`);
          console.log(`  ${pc.cyan('/clear')}    - ${tr('cli.help.clear')}`);
          console.log(`  ${pc.cyan('/history')}  - ${tr('cli.help.history')}`);
          console.log(`  ${pc.cyan('/sessions')} - ${tr('cli.help.sessions')}`);
          console.log(`  ${pc.cyan('/load')}     - ${tr('cli.help.load')}`);
          console.log(`  ${pc.cyan('/new')}      - ${tr('cli.help.new')}`);
          console.log(`  ${pc.cyan('/memory')}   - ${tr('cli.help.memory')}`);
          console.log(`  ${pc.cyan('/help')}     - ${tr('cli.help.help')}`);
          console.log(`  ${pc.cyan('/exit')}     - ${tr('cli.help.exit')}\n`);
          break;

        default:
          console.log(pc.red(`${tr('cli.unknownCommand', { cmd })}\n`));
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
            output.write(pc.dim(`\n${tr('cli.thinking')}\n`));
          }
        },
        onChunk: (text) => {
          output.write(text);
        },
        onToolCall: (name, args) => {
          activeToolStartTime = Date.now();
          const argsStr = JSON.stringify(args);
          const preview = argsStr.length > 80 ? `${argsStr.slice(0, 77)}...` : argsStr;
          output.write(`\n${pc.yellow(`${tr('cli.toolCall')} ${name}: ${preview}`)}\n`);
        },
        onToolResult: (name, result, isError) => {
          const duration = activeToolStartTime ? Date.now() - activeToolStartTime : 0;
          const detail = typeof result === 'string' ? result.split('\n')[0] : '';
          if (isError) {
            output.write(`\n${pc.yellow(`${tr('cli.toolBlocked')} ${name}: ${detail}`)}\n`);
          } else {
            output.write(pc.green(`${tr('cli.toolDone')} ${name} (${duration}ms)\n`));
          }
        },
        onError: (err) => {
          output.write(`\n${pc.red(`${tr('cli.error')} ${err.message}`)}\n`);
        }
      });

      output.write('\n\n');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Machine-readable sentinel thrown by @agent/core on user abort — not UI
      // text, so it must never be translated or it will stop matching.
      if (message !== '[Task aborted by user]') {
        output.write(`\n${pc.red(tr('cli.execFailed', { message }))}\n\n`);
      }
    }

    rl.prompt();
  }

  runner.close();
}

// Auto-run when executed directly
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  startCli().catch((err) => {
    // The language is re-resolved here: a failure can happen before startCli's
    // own `language` binding exists.
    const message = err instanceof Error ? err.message : String(err);
    console.error(pc.red(t(resolveLanguage(), 'cli.fatal', { message })));
    process.exit(1);
  });
}
