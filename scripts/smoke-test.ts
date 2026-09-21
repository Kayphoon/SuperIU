import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  handleSpillover,
  createBashTool,
  createInitialEmotion,
  decayEmotion,
  updateEmotionOnInteraction,
  loadLayeredMemory,
  ensureMemoryFiles
} from '../packages/core/dist/index.js';

async function runSmokeTests() {
  console.log('=== Starting Smoke Verification ===\n');

  // Test 1: Spillover Truncation
  console.log('▶ Testing Spillover Truncation...');
  const largeData = 'A'.repeat(6000);
  const testSpillDir = path.resolve('.test-spillover');
  const spillResult = await handleSpillover(largeData, testSpillDir, 2000);

  if (!spillResult.spilled) {
    throw new Error('Spillover failed: expected spilled to be true');
  }
  if (spillResult.content.length >= 2000) {
    throw new Error(`Spillover failed: truncated length ${spillResult.content.length} exceeds limit`);
  }
  if (!spillResult.filePath) {
    throw new Error('Spillover failed: missing filePath');
  }

  const savedFileContent = await fs.readFile(spillResult.filePath, 'utf-8');
  if (savedFileContent.length !== 6000) {
    throw new Error(`Spillover failed: saved file length ${savedFileContent.length} !== 6000`);
  }
  console.log('  ✔ Spillover truncation verified successfully.\n');

  // Clean up test spillover dir
  await fs.rm(testSpillDir, { recursive: true, force: true });

  // Test 2: Bash Sandbox Tool Execution
  console.log('▶ Testing Bash Sandbox (echo)...');
  const bashTool = createBashTool();
  const echoResult = await bashTool.execute({ command: 'echo "hello agent sandbox"' }, { toolCallId: 'test-1', messages: [] });
  if (typeof echoResult !== 'string' || !echoResult.includes('hello agent sandbox')) {
    throw new Error(`Bash tool execution failed: ${echoResult}`);
  }
  console.log('  ✔ Bash echo execution verified successfully.\n');

  // Test 3: Bash Sandbox Tool Abort & Process Tree Cleanup
  console.log('▶ Testing Bash Sandbox Abort Signal...');
  const abortController = new AbortController();
  const abortableBash = createBashTool({
    getSignal: () => abortController.signal
  });

  const startTime = Date.now();
  // Trigger abort after 300ms
  setTimeout(() => {
    abortController.abort();
  }, 300);

  const abortResult = await abortableBash.execute({ command: 'sleep 5' }, { toolCallId: 'test-2', messages: [] });
  const duration = Date.now() - startTime;

  if (duration >= 2500) {
    throw new Error(`Abort took too long: ${duration}ms (expected < 2000ms)`);
  }
  if (!String(abortResult).includes('aborted')) {
    throw new Error(`Expected aborted output, got: ${abortResult}`);
  }
  console.log(`  ✔ Bash abort handled in ${duration}ms.\n`);

  // Test 3b: Nested Process Group Tree Kill (Background Subprocesses)
  console.log('▶ Testing Nested Process Group Tree Kill...');
  const nestedController = new AbortController();
  const nestedBash = createBashTool({
    getSignal: () => nestedController.signal
  });
  const nestedStart = Date.now();
  setTimeout(() => {
    nestedController.abort();
  }, 200);

  const nestedResult = await nestedBash.execute({
    command: 'sleep 15 & sleep 15 & wait'
  }, { toolCallId: 'test-2b', messages: [] });

  const nestedDuration = Date.now() - nestedStart;
  if (nestedDuration >= 2000) {
    throw new Error(`Nested process abort took too long: ${nestedDuration}ms`);
  }
  console.log(`  ✔ Nested process tree terminated cleanly in ${nestedDuration}ms.\n`);

  // Test 4: Emotion Decay Engine
  console.log('▶ Testing Emotion Decay Engine...');
  const initial = createInitialEmotion();
  const excited = updateEmotionOnInteraction(initial, {
    valenceDelta: -0.8,
    arousalDelta: 0.7,
    fatigueDelta: 0.6
  });

  if (excited.valence !== -0.8 || Math.abs(excited.arousal - 0.9) > 0.01) {
    throw new Error(`Emotion update failed: ${JSON.stringify(excited)}`);
  }

  // Decay 10 minutes (600,000 ms)
  const decayed = decayEmotion(excited, excited.lastUpdate + 600_000, 300_000);
  if (decayed.valence <= -0.8 || decayed.valence > 0) {
    throw new Error(`Valence decay failed: ${decayed.valence}`);
  }
  if (decayed.arousal >= 0.9 || decayed.arousal < 0.2) {
    throw new Error(`Arousal decay failed: ${decayed.arousal}`);
  }
  console.log('  ✔ Emotion decay verified successfully.\n');

  // Test 5: Layered Memory Loading
  console.log('▶ Testing Layered Memory System...');
  const testMemoryDir = path.resolve('.test-memory');
  await ensureMemoryFiles(testMemoryDir);
  const memoryText = await loadLayeredMemory(testMemoryDir);

  if (!memoryText.includes('Soul (Identity & Principles)') || !memoryText.includes('Long-term Facts')) {
    throw new Error('Layered memory content missing expected sections');
  }
  console.log('  ✔ Layered memory verified successfully.\n');

  // Clean up test memory dir
  await fs.rm(testMemoryDir, { recursive: true, force: true });

  console.log('=== All Smoke Tests Passed Successfully ===');
}

runSmokeTests().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
