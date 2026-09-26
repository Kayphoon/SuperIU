/**
 * Terminal-shell i18n.
 *
 * Deliberately a SEPARATE table from `packages/ui/public/i18n.js`: that file is
 * a browser ES module served over HTTP by the UI server, so a Node CLI process
 * cannot reach it. The CLI also phrases the same states for a terminal — no
 * HTML, different casing — so the values differ by design. Key NAMES for
 * identical concepts are kept aligned with the web dictionary (`status.*`) so
 * the two shells cannot drift semantically.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type UiLanguage = 'zh' | 'en';

export const DEFAULT_LANGUAGE: UiLanguage = 'zh';

/** The web shell owns this file; the CLI only ever reads it, never writes it. */
const SETTINGS_FILE = path.join('.myagent', 'ui-settings.json');

function isUiLanguage(value: unknown): value is UiLanguage {
  return value === 'zh' || value === 'en';
}

/**
 * Synchronous by design: the banner prints before any await would be useful.
 * A missing or corrupt settings file is the normal first-run case, not an error,
 * so every failure path falls through to the default instead of throwing.
 *
 * The settings file wins over the environment, matching the web shell's
 * `loadSettings()` and every other field (`apiKey: raw.apiKey ?? defaults.apiKey`).
 * The env var only seeds the default for a workspace whose file does not set a
 * language.
 */
export function resolveLanguage(cwd = process.cwd()): UiLanguage {
  try {
    const raw = fs.readFileSync(path.join(cwd, SETTINGS_FILE), 'utf-8');
    const settings = JSON.parse(raw) as { language?: unknown };
    if (isUiLanguage(settings.language)) {
      return settings.language;
    }
  } catch {
    // No settings file yet, or unparseable: fall through to the environment.
  }

  if (isUiLanguage(process.env.SUPERIU_LANGUAGE)) {
    return process.env.SUPERIU_LANGUAGE;
  }

  return DEFAULT_LANGUAGE;
}

/** Falls back to the `zh` table, then to the raw key, so a typo degrades visibly. */
export function t(
  language: UiLanguage,
  key: string,
  params?: Record<string, string | number>
): string {
  const template = DICTS[language][key] ?? DICTS[DEFAULT_LANGUAGE][key] ?? key;
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match
  );
}

const DICTS: Record<UiLanguage, Record<string, string>> = {
  zh: {
    'cli.banner': '=== SuperIU 自主智能体 CLI ===',
    'cli.mainModel': '主模型：{model}',
    'cli.reviewModel': '审查模型：{model}',
    'cli.reviewDisabled': '（自动审查已禁用）',
    'cli.session': '会话：{id}',
    'cli.inMemory': '（内存中）',
    'cli.logNotWritten': '（尚未写入）',
    'cli.hint': '输入 /help 查看斜杠命令，或直接输入你的任务开始。',
    'cli.prompt': 'agent> ',
    'cli.interrupted': '[已中断]',
    'cli.abortedByUser': '任务已由用户中止。',
    'cli.abortHint': '再按一次 Ctrl+C 或输入 /exit 退出。',
    'cli.goodbye': '再见！',
    'cli.exiting': '正在退出…',
    'cli.thinking': '思考中…',
    'cli.toolCall': '⚙ [工具]',
    'cli.toolDone': '✔ [完成]',
    'cli.toolBlocked': '⚠ [已拦截]',
    'cli.error': '✖ [错误]',
    'cli.execFailed': '执行失败：{message}',
    'cli.fatal': '致命错误：{message}',

    'cli.approval.title': '⚠ [需要审批]',
    'cli.approval.reason': '原因：',
    'cli.approval.args': '参数：',
    'cli.approval.risk': '风险',
    'cli.approval.by': '由',
    'cli.approval.riskSafe': '安全',
    'cli.approval.riskLow': '低',
    'cli.approval.riskMedium': '中',
    'cli.approval.riskHigh': '高',
    'cli.approval.riskCritical': '严重',
    'cli.approval.riskUnknown': '未知',
    'cli.approval.reviewerRule': '规则引擎',
    'cli.approval.reviewerModel': '审查模型',
    'cli.approval.reviewerUnknown': '未知来源',
    'cli.approval.question': '是否允许执行该命令？[y/N] ',

    // Status labels carry their own padding: the values must line up as a column
    // in both languages, and fullwidth labels are double-width in a terminal.
    'cli.status.header': '智能体状态：',
    'cli.status.state': '状态：     ',
    'cli.status.session': '会话：     ',
    'cli.status.leaf': '叶节点：   ',
    'cli.status.logFile': '日志文件： ',
    'cli.status.messages': '消息数：   ',
    'cli.status.messagesSuffix': '（活动分支）',
    'cli.status.emotion': '情绪：     ',
    'cli.status.emotionSep': '，',
    'cli.status.valence': '效价：',
    'cli.status.arousal': '唤醒度：',
    'cli.status.fatigue': '疲劳度：',
    'cli.status.os': '系统：     ',
    'cli.status.main': '主模型：   ',
    'cli.status.review': '审查：     ',
    'cli.status.reviewDisabled': '已禁用',
    'cli.status.modeLenient': '宽松',
    'cli.status.modeStrict': '严格',
    'cli.status.modeUnknown': '未知',
    'cli.status.approve': '审批：     ',
    'cli.status.approveInteractive': '交互式（本终端）',
    'cli.status.approveNone': '无',
    'cli.status.memory': '记忆：     ',
    'cli.status.root': '（根）',

    'cli.history.header': '提示词历史（{count}）：',
    'cli.history.empty': '（空）',
    'cli.sessions.header': '会话列表（{count}）：',
    'cli.sessions.untitled': '未命名会话',
    'cli.load.usage': '用法：/load <会话 ID|文件名|路径>',
    'cli.load.ok': '✔ 已载入会话 {id}（{count} 条消息）',
    'cli.load.failed': '✖ {message}',
    'cli.new.ok': '✔ 新会话 {id}',
    'cli.clear.ok': '✔ 当前上下文已清空，后续对话从新轮次开始。',
    'cli.memory.analyzing': '正在分析当前对话以提取持久事实…',
    'cli.memory.none': '没有新的内容需要记住。',
    'cli.memory.failed': '✖ 记忆提取失败：{message}',

    'cli.help.header': '可用斜杠命令：',
    'cli.help.status': '查看智能体与工作台状态',
    'cli.help.clear': '清空当前上下文，后续对话从新轮次开始',
    'cli.help.history': '显示最近的提示词历史（可附加过滤词）',
    'cli.help.sessions': '列出当前工作区已保存的会话',
    'cli.help.load': '按 ID、文件名或路径载入会话',
    'cli.help.new': '开启一个全新的会话',
    'cli.help.memory': '从本次对话中提炼值得长期记住的事实',
    'cli.help.help': '显示本帮助信息',
    'cli.help.exit': '退出 CLI',
    'cli.unknownCommand': '未知命令：{cmd}。输入 /help 查看可用命令。',

    // Shared with the web dictionary: both shells render the same `AgentStatus`
    // union, and the documented convention is that they must phrase identical
    // state identically. Keep these two tables in step.
    'status.idle': '空闲',
    'status.running': '运行中',
    'status.thinking': '思考中',
    'status.streaming': '流式输出',
    'status.tool_calling': '执行工具',
    'status.completed': '已完成',
    'status.aborted': '已中止',
    'status.error': '出错',
  },

  en: {
    'cli.banner': '=== SuperIU Autonomous Agent CLI ===',
    'cli.mainModel': 'Main model: {model}',
    'cli.reviewModel': 'Review model: {model}',
    'cli.reviewDisabled': '(auto-review disabled)',
    'cli.session': 'Session: {id}',
    'cli.inMemory': '(in-memory)',
    'cli.logNotWritten': ' (not written yet)',
    'cli.hint': 'Type /help for slash commands, or enter your task to begin.',
    'cli.prompt': 'agent> ',
    'cli.interrupted': '[Interrupted]',
    'cli.abortedByUser': 'Task aborted by user.',
    'cli.abortHint': 'Press Ctrl+C again or type /exit to quit.',
    'cli.goodbye': 'Goodbye!',
    'cli.exiting': 'Exiting...',
    'cli.thinking': 'Thinking...',
    'cli.toolCall': '⚙ [Tool]',
    'cli.toolDone': '✔ [Done]',
    'cli.toolBlocked': '⚠ [Blocked]',
    'cli.error': '✖ [Error]',
    'cli.execFailed': 'Execution failed: {message}',
    'cli.fatal': 'Fatal error: {message}',

    'cli.approval.title': '⚠ [Approval Required]',
    'cli.approval.reason': 'reason:',
    'cli.approval.args': 'args:  ',
    'cli.approval.risk': 'risk',
    'cli.approval.by': 'by',
    'cli.approval.riskSafe': 'safe',
    'cli.approval.riskLow': 'low',
    'cli.approval.riskMedium': 'medium',
    'cli.approval.riskHigh': 'high',
    'cli.approval.riskCritical': 'critical',
    'cli.approval.riskUnknown': 'unknown',
    'cli.approval.reviewerRule': 'rule engine',
    'cli.approval.reviewerModel': 'review model',
    'cli.approval.reviewerUnknown': 'unknown source',
    'cli.approval.question': 'Approve this command? [y/N] ',

    'cli.status.header': 'Agent Status:',
    'cli.status.state': 'State:    ',
    'cli.status.session': 'Session:  ',
    'cli.status.leaf': 'Leaf ID:  ',
    'cli.status.logFile': 'Log file: ',
    'cli.status.messages': 'Messages: ',
    'cli.status.messagesSuffix': ' in active branch',
    'cli.status.emotion': 'Emotion:  ',
    'cli.status.emotionSep': ', ',
    'cli.status.valence': 'Valence: ',
    'cli.status.arousal': 'Arousal: ',
    'cli.status.fatigue': 'Fatigue: ',
    'cli.status.os': 'OS:       ',
    'cli.status.main': 'Main:     ',
    'cli.status.review': 'Review:   ',
    'cli.status.reviewDisabled': 'disabled',
    'cli.status.modeLenient': 'Lenient',
    'cli.status.modeStrict': 'Strict',
    'cli.status.modeUnknown': 'Unknown',
    'cli.status.approve': 'Approve:  ',
    'cli.status.approveInteractive': 'interactive (this terminal)',
    'cli.status.approveNone': 'none',
    'cli.status.memory': 'Memory:   ',
    'cli.status.root': '(root)',

    'cli.history.header': 'Prompt History ({count}):',
    'cli.history.empty': '(empty)',
    'cli.sessions.header': 'Sessions ({count}):',
    'cli.sessions.untitled': 'Untitled session',
    'cli.load.usage': 'Usage: /load <session-id|file-name|path>',
    'cli.load.ok': '✔ Loaded session {id} ({count} messages)',
    'cli.load.failed': '✖ {message}',
    'cli.new.ok': '✔ New session {id}',
    'cli.clear.ok': '✔ Context cleared; subsequent messages start fresh.',
    'cli.memory.analyzing': 'Analyzing the active conversation for durable facts...',
    'cli.memory.none': 'Nothing new to remember.',
    'cli.memory.failed': '✖ Memory extraction failed: {message}',

    'cli.help.header': 'Available Slash Commands:',
    'cli.help.status': 'Show agent and workstation status',
    'cli.help.clear': 'Clear the current context; later messages start fresh',
    'cli.help.history': 'Show recent prompt history (optionally filtered)',
    'cli.help.sessions': 'List saved sessions for this workspace',
    'cli.help.load': 'Load a session by id, file name, or path',
    'cli.help.new': 'Start a fresh session',
    'cli.help.memory': 'Extract facts worth remembering from this conversation',
    'cli.help.help': 'Display this help message',
    'cli.help.exit': 'Exit CLI',
    'cli.unknownCommand': 'Unknown command: {cmd}. Type /help for available commands.',

    'status.idle': 'Idle',
    'status.running': 'Running',
    'status.thinking': 'Thinking',
    'status.streaming': 'Streaming',
    'status.tool_calling': 'Running a tool',
    'status.completed': 'Completed',
    'status.aborted': 'Aborted',
    'status.error': 'Error',
  },
};
