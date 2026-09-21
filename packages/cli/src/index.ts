import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pc from 'picocolors';
import { AgentRunner, resolveMemoryDir } from '@agent/core';

export async function startCli() {
  const runner = new AgentRunner();
  const rl = readline.createInterface({ input, output });

  let lastSigintTime = 0;

  // Intercept SIGINT for two-level interruption
  process.on('SIGINT', () => {
    if (runner.status !== 'idle') {
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
  const memoryDir = await resolveMemoryDir();
  console.log(pc.bold(pc.cyan('\n=== SuperIU Autonomous Agent CLI ===')));
  console.log(pc.dim(`Memory directory: ${memoryDir}`));
  console.log(pc.dim(`Model: ${process.env.OPENAI_MODEL_NAME || 'gpt-4o'}`));
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
      const [cmd] = inputLine.split(/\s+/);
      switch (cmd.toLowerCase()) {
        case '/exit':
        case '/quit':
          console.log(pc.dim('Exiting...'));
          rl.close();
          process.exit(0);

        case '/clear':
          console.clear();
          runner.reset();
          console.log(pc.green('✔ Session history and emotion state reset.\n'));
          break;

        case '/status': {
          const em = runner.emotion;
          console.log(pc.bold('\nAgent Status:'));
          console.log(`  State:    ${pc.cyan(runner.status)}`);
          console.log(
            `  Emotion:  Valence: ${pc.yellow(em.valence.toFixed(2))}, ` +
            `Arousal: ${pc.yellow(em.arousal.toFixed(2))}, ` +
            `Fatigue: ${pc.yellow(em.fatigue.toFixed(2))}`
          );
          console.log(`  History:  ${runner.messages.length} messages in context`);
          console.log(`  Memory:   ${memoryDir}\n`);
          break;
        }

        case '/help':
          console.log(pc.bold('\nAvailable Slash Commands:'));
          console.log(`  ${pc.cyan('/status')} - Show agent state, emotion, and message context`);
          console.log(`  ${pc.cyan('/clear')}  - Clear screen and reset conversation history`);
          console.log(`  ${pc.cyan('/help')}   - Display this help message`);
          console.log(`  ${pc.cyan('/exit')}   - Exit CLI\n`);
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
        onToolResult: (name) => {
          const duration = activeToolStartTime ? Date.now() - activeToolStartTime : 0;
          output.write(pc.green(`✔ [Done] ${name} (${duration}ms)\n`));
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
}

// Auto-run when executed directly
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  startCli().catch((err) => {
    console.error(pc.red('Fatal CLI Error:'), err);
    process.exit(1);
  });
}
