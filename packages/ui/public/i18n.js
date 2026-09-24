/**
 * SuperIU · UI internationalisation.
 *
 * ── Why a module rather than inline strings ─────────────────────────────────
 * The SPA is one 4500-line `index.html` plus `notifications.js`. Every
 * user-visible string lives in the dictionary below, so adding a language is a
 * data change rather than a hunt through render functions, and the two shells
 * that share `@agent/core` cannot drift into half-translated states.
 *
 * ── Resolution order ────────────────────────────────────────────────────────
 *   1. `localStorage['superiu.language']` — read synchronously at module load so
 *      the very first paint is already in the user's language (no English
 *      flash while `/api/status` is in flight).
 *   2. `.myagent/ui-settings.json` → `language`, pushed in by the caller via
 *      `setLanguage()` once the server answers. The file is authoritative: it is
 *      the value the settings dialog edits and the value the desktop shell's
 *      native menu reads at launch.
 *   3. `zh` — the product default.
 *
 * ── Markup contract ─────────────────────────────────────────────────────────
 *   `data-i18n`               → textContent
 *   `data-i18n-html`          → innerHTML (dictionary values are authored here,
 *                               never user input; only used where a key carries
 *                               inline `<code>`)
 *   `data-i18n-title`         → title attribute
 *   `data-i18n-placeholder`   → placeholder attribute
 *   `data-i18n-aria-label`    → aria-label attribute
 *
 * `apply(root)` translates every annotated node under `root`; `setLanguage()`
 * calls it on `document` and then notifies `onChange` subscribers so dynamically
 * rendered regions (status panel, session list, palette, …) can re-render.
 */

const STORAGE_KEY = 'superiu.language';

/** The languages offered in Settings; `id` is what lands in ui-settings.json. */
export const LANGUAGES = Object.freeze([
  Object.freeze({ id: 'zh', label: '中文' }),
  Object.freeze({ id: 'en', label: 'English' })
]);

const DEFAULT_LANGUAGE = 'zh';

const DICT = {
  zh: {
    'app.title': 'SuperIU · 智能体控制台',

    'titlebar.more': '更多',
    'titlebar.more.title': '更多',
    'traffic.close': '关闭窗口',
    'traffic.more': '更多',
    'traffic.fullscreen': '进入全屏',

    'sidebar.title': '消息列表',
    'sidebar.new': '+ 新建',
    'sidebar.new.title': '新建会话',
    'sidebar.toggle': '切换侧边栏',
    'sidebar.toggle.title': '切换侧边栏',
    'sidebar.collapse': '收起侧边栏',
    'sidebar.collapse.title': '收起侧边栏',
    'composer.placeholder': '描述一个交给自主智能体的任务…',
    'composer.stop': '停止',
    'composer.stop.title': '中止本轮',
    'composer.send': '发送',
    'composer.send.title': '发送',
    'menu.title': '更多',
    'menu.close': '关闭菜单',

    'menu.section.session': '会话',
    'menu.section.model': '模型',
    'menu.section.status': '状态',
    'menu.section.actions': '操作',

    'menu.session.select': '当前会话',
    'menu.session.new': '+ 新建',
    'menu.session.new.title': '新建会话',
    'menu.session.clear': '/clear',
    'menu.session.clear.title': '追加 reset_boundary',

    'menu.model.select': '主模型（智能体循环）',
    'menu.model.effort.title': '推理强度（主路由）',
    'menu.model.tool.title': '工具 / 审查模型',
    'menu.model.noEffort': '不发送',
    'menu.model.autoReviewOff': 'AutoReview 已关闭',

    'menu.status.workstation': '实时工作站快照',
    'menu.status.detecting': '检测中…',

    'menu.emotion.title': '情绪状态',
    'menu.emotion.scale': 'VA · τ 5m',
    'menu.emotion.valence': '效价',
    'menu.emotion.arousal': '唤醒度',
    'menu.emotion.fatigue': '疲劳度',
    'menu.emotion.valence.min': '-1 消极',
    'menu.emotion.valence.max': '积极 +1',
    'menu.emotion.arousal.min': '平静',
    'menu.emotion.arousal.max': '警觉',
    'menu.emotion.fatigue.min': '精力充沛',
    'menu.emotion.fatigue.max': '疲惫',

    'menu.posture.title': '运行姿态',
    'menu.posture.baseline': '基线 —— 无生效的修饰语',
    'menu.posture.caption': '以下为注入系统提示词的原文（保持英文，模型按原文执行）',

    'posture.terse': '精简直接',
    'posture.cautious': '谨慎专注',
    'posture.constructive': '积极建设',
    'posture.driven': '主动深挖',
    'posture.pragmatic': '务实严谨',

    'menu.info.title': '会话信息',
    'menu.info.session': '会话 ID',
    'menu.info.leaf': '叶子 ID',
    'menu.info.count': '有效消息',
    'menu.info.step': '步骤',
    'menu.info.file': '日志文件',

    'menu.history.title': '输入历史',
    'menu.history.empty': '(空)',

    'menu.actions.notify': '通知',
    'menu.actions.notify.on': '通知已开',
    'menu.actions.notify.title': '开启桌面通知',
    'menu.actions.commands': '命令',
    'menu.actions.commands.title': '命令面板',
    'menu.actions.settings': '设置',
    'menu.actions.settings.title': '设置',

    'settings.title': '设置',
    'settings.close': '关闭设置',
    'settings.apiKey': 'OPENAI_API_KEY',
    'settings.apiKey.hint':
      '本地保存在 <code>.myagent/ui-settings.json</code>（权限 0600）。留空则保留当前密钥。',
    'settings.baseURL': 'OPENAI_BASE_URL',
    'settings.baseURL.hint': '任意 OpenAI 兼容端点（DeepSeek、SiliconFlow、Ollama、Moonshot…）。',
    'settings.model': '主模型名称',
    'settings.model.hint': '也可在「更多」面板中切换。',
    'settings.reviewModel': '工具 / 审查模型名称',
    'settings.reviewModel.hint': '用于 AutoReview 的判定。',
    'settings.effort': '推理强度',
    'settings.effort.unset': '未设置 —— 从 OPENAI_REASONING_EFFORT 推导',
    'settings.effort.active': '主路由当前发送 <span class="text-secondary">reasoningEffort: {level}</span>。',
    'settings.effort.none': '主路由不发送 reasoningEffort。',
    'settings.effort.unsupported':
      '当前主模型不接受 reasoning_effort，因此不会发送（非推理模型会以 HTTP 400 拒绝该参数）。',
    'settings.effort.pending': '仍会保存 —— 切换到推理模型后生效。',
    'settings.language': '界面语言',
    'settings.language.hint': '立即生效并保存，重启后保持。',
    'settings.autoReview': 'AutoReview',
    'settings.autoReview.hint': '让每一次工具调用都经过工具模型审核；升级为人工确认的调用会弹出审批卡片。',
    'settings.notifications': '桌面通知与提示音',
    'settings.notifications.hint': '在审批请求与任务完成时提醒。',
    'settings.env': '环境变量',
    'settings.env.note': '已保存的设置优先于环境变量默认值。',
    'settings.cancel': '取消',
    'settings.save': '保存',
    'settings.saving': '保存中…',
    'settings.saved': '✓ 已保存',
    'settings.savedRestarted': '✓ 已保存 · 运行器已重启',

    'quit.title': '退出 SuperIU？',
    'quit.body': 'Web 外壳将关闭，智能体会话已保存到其 JSONL 日志。',
    'quit.cancel': '取消',
    'quit.confirm': '退出',

    'complete.aria': '命令补全',
    'slash.clear.desc': '清空当前上下文（追加 reset_boundary）',
    'slash.status.desc': '查看智能体与工作台状态',
    'slash.sessions.desc': '列出已落盘会话',

    'palette.aria': '命令面板',
    'palette.placeholder': '输入命令…',
    'palette.empty': '没有匹配的命令',
    'palette.new': '新建会话',
    'palette.clear': '清空上下文 (/clear)',
    'palette.status': '查看状态 (/status)',
    'palette.sessions': '列出会话 (/sessions)',
    'palette.settings': '打开设置',
    'palette.notify': '开启桌面通知',
    'palette.abort': '中止当前轮次',
    'palette.quit': '退出 SuperIU',
    'palette.focus': '聚焦输入框',

    'empty.eyebrow': 'Autonomous Agent',
    'empty.title': 'SuperIU',
    'empty.body': '随时就绪，为你执行自主推理、代码开发与系统操作。',
    'status.idle': '空闲',
    'status.running': '运行中',
    'status.thinking': '思考中',
    'status.streaming': '流式输出',
    'status.tool_calling': '执行工具',
    'status.completed': '已完成',
    'status.aborted': '已中止',
    'status.error': '出错',

    'badge.running': '运行中',
    'badge.done': '完成',
    'badge.error': '错误',
    'badge.denied': '已拒绝',
    'badge.pending': '待确认',

    'transcript.thinking': '思考中…',
    'transcript.thinkingSummary': '思考摘要（{n} 字）',
    'transcript.step': '步骤 {n}',
    'transcript.stepReview': '审查 · 步骤 {n}',
    'transcript.arguments': '参数',
    'transcript.output': '输出',
    'transcript.noOutput': '[无输出]',
    'transcript.thenRun': '随后执行：{command}',
    'transcript.thenRun.title': '写入后立即执行的链式命令：{command}',
    'transcript.copy': '复制消息',
    'transcript.tools': '{n} 个工具',
    'transcript.waitBlocked': '等待你的审批决定 {seconds}s',
    'transcript.aborted': '■ 本轮已被用户中止',

    'approval.title': '需要审批',
    'approval.via': '经由 {name}',
    'approval.waiting': '等待你的决定…',
    'approval.approve': '允许执行',
    'approval.reject': '拒绝',
    'approval.approved': '✓ 已允许 —— 正在执行',
    'approval.rejected': '✕ 已拒绝 —— 智能体将调整',
    'approval.retired': '已失效',
    'approval.retiredNote': '本轮在做出决定前已结束',

    'session.file.inMemory': '(内存中)',
    'session.file.notWritten': '{path}（尚未写入）',
    'session.select.empty': '(未开始的新会话)',
    'session.select.none': '(暂无会话)',
    'session.untitled': '会话 {id}',

    'toast.clipboard': '剪贴板不可用',
    'toast.unknownCommand': '未知命令：{cmd}',
    'toast.statusUnavailable': '状态不可用：{message}',
    'toast.sessionsUnavailable': '会话列表不可用：{message}',
    'toast.bootFailed': '启动失败：{message}',
    'toast.abortFirst': '请先中止正在运行的一轮',
    'toast.newSession': '已创建新会话',
    'toast.loadedSession': '已加载会话 {id}',
    'toast.notifyEnabled': '桌面通知已开启',
    'toast.notifyPermission': '通知权限：{permission}',
    'toast.notifyUnavailable': 'notifications.js 不可用',
    'toast.contextCleared': '上下文已清空',
    'toast.aborting': '正在中止本轮…',
    'toast.nothingRunning': '当前没有正在运行的任务',
    'toast.modelChanged': '主模型 → {model}',
    'toast.settingsSaved': '设置已保存',
    'toast.shutdown': 'SuperIU Web 外壳已关闭，此标签页可以关闭了。',
    'toast.about': 'SuperIU · 单核双驱 —— 自主智能体控制台',
    'toast.docs': '文档：docs/shells-guide.md · docs/agent-loop-and-context-architecture.md',

    'note.resetBoundary': '✓ 已追加 reset_boundary · 有效上下文已截断',

    'notify.stack': '通知',
    'notify.dismiss': '关闭通知',
    'notify.viewApproval': '查看审批',
    'notify.taskComplete': 'SuperIU：任务完成',
    'notify.approvalRequired': 'SuperIU：需要审批',
    'notify.error': 'SuperIU：执行出错',
    'notify.waiting': '智能体正在等待你的决定。',
    'notify.alertsEnabled': 'SuperIU：通知已启用',
    'notify.alertsEnabledBody': '任务完成或需要审批时，你会收到提醒。',
    'notify.settled': '智能体循环已结束。',
    'notify.kind.info': '提示',
    'notify.kind.success': '完成',
    'notify.kind.error': '错误',
    'notify.kind.approval': '审批'
  },

  en: {
    'app.title': 'SuperIU · Agent Console',

    'titlebar.more': 'More',
    'titlebar.more.title': 'More',
    'traffic.close': 'Close window',
    'traffic.more': 'More',
    'traffic.fullscreen': 'Enter fullscreen',

    'sidebar.title': 'Sessions',
    'sidebar.new': '+ New',
    'sidebar.new.title': 'New session',
    'sidebar.toggle': 'Toggle Sidebar',
    'sidebar.toggle.title': 'Toggle Sidebar',
    'sidebar.collapse': 'Collapse Sidebar',
    'sidebar.collapse.title': 'Collapse Sidebar',
    'composer.placeholder': 'Describe a task for the autonomous agent…',
    'composer.stop': 'Stop',
    'composer.stop.title': 'Abort',
    'composer.send': 'Send',
    'composer.send.title': 'Send',
    'menu.title': 'More',
    'menu.close': 'Close menu',

    'menu.section.session': 'Session',
    'menu.section.model': 'Model',
    'menu.section.status': 'Status',
    'menu.section.actions': 'Actions',

    'menu.session.select': 'Active session',
    'menu.session.new': '+ New',
    'menu.session.new.title': 'New session',
    'menu.session.clear': '/clear',
    'menu.session.clear.title': 'Append reset_boundary',

    'menu.model.select': 'Main model (agent loop)',
    'menu.model.effort.title': 'Reasoning effort (main route)',
    'menu.model.tool.title': 'Tool / review model',
    'menu.model.noEffort': 'no effort',
    'menu.model.autoReviewOff': 'AutoReview off',

    'menu.status.workstation': 'Live workstation snapshot',
    'menu.status.detecting': 'detecting…',

    'menu.emotion.title': 'Emotion State',
    'menu.emotion.scale': 'VA · τ 5m',
    'menu.emotion.valence': 'Valence',
    'menu.emotion.arousal': 'Arousal',
    'menu.emotion.fatigue': 'Fatigue',
    'menu.emotion.valence.min': '-1 negative',
    'menu.emotion.valence.max': 'positive +1',
    'menu.emotion.arousal.min': 'calm',
    'menu.emotion.arousal.max': 'alert',
    'menu.emotion.fatigue.min': 'energetic',
    'menu.emotion.fatigue.max': 'tired',

    'menu.posture.title': 'Operational Posture',
    'menu.posture.baseline': 'baseline — no active modifier',
    'menu.posture.caption': 'Injected system-prompt text, shown verbatim (English is what the model reads)',

    'posture.terse': 'Terse & Direct',
    'posture.cautious': 'Cautious & Focused',
    'posture.constructive': 'Constructive & Proactive',
    'posture.driven': 'Driven & Deep-Diving',
    'posture.pragmatic': 'Pragmatic & Rigorous',

    'menu.info.title': 'Session Info',
    'menu.info.session': 'Session ID',
    'menu.info.leaf': 'Leaf ID',
    'menu.info.count': 'Active msgs',
    'menu.info.step': 'Step',
    'menu.info.file': 'Log file',

    'menu.history.title': 'Prompt History',
    'menu.history.empty': '(empty)',

    'menu.actions.notify': 'Notify',
    'menu.actions.notify.on': 'Alerts on',
    'menu.actions.notify.title': 'Enable desktop notifications',
    'menu.actions.commands': 'Commands',
    'menu.actions.commands.title': 'Command Palette',
    'menu.actions.settings': 'Settings',
    'menu.actions.settings.title': 'Settings',

    'settings.title': 'Settings',
    'settings.close': 'Close settings',
    'settings.apiKey': 'OPENAI_API_KEY',
    'settings.apiKey.hint':
      'Stored locally in <code>.myagent/ui-settings.json</code> (0600). Leave blank to keep the current key.',
    'settings.baseURL': 'OPENAI_BASE_URL',
    'settings.baseURL.hint': 'Any OpenAI-compatible endpoint (DeepSeek, SiliconFlow, Ollama, Moonshot…).',
    'settings.model': 'Main Model Name',
    'settings.model.hint': 'Also switchable from the secondary menu.',
    'settings.reviewModel': 'Tool / Review Model Name',
    'settings.reviewModel.hint': 'Used for AutoReview verdicts.',
    'settings.effort': 'Reasoning Effort',
    'settings.effort.unset': 'Unset — derive from OPENAI_REASONING_EFFORT',
    'settings.effort.active': 'Main route currently sends <span class="text-secondary">reasoningEffort: {level}</span>.',
    'settings.effort.none': 'Main route sends no reasoningEffort.',
    'settings.effort.unsupported':
      'The current main model does not accept reasoning_effort, so nothing is sent (a non-reasoning model rejects the parameter with HTTP 400).',
    'settings.effort.pending': 'Saved anyway — it will apply once you switch to a reasoning model.',
    'settings.language': 'Interface Language',
    'settings.language.hint': 'Applies immediately and persists across restarts.',
    'settings.autoReview': 'AutoReview',
    'settings.autoReview.hint':
      'Gate every tool call through the tool model. Escalated calls surface an interactive approval card.',
    'settings.notifications': 'Desktop notifications & chime',
    'settings.notifications.hint': 'Alert on approval requests and task completion.',
    'settings.env': 'Environment',
    'settings.env.note': 'Saved settings override environment defaults.',
    'settings.cancel': 'Cancel',
    'settings.save': 'Save',
    'settings.saving': 'Saving…',
    'settings.saved': '✓ Saved',
    'settings.savedRestarted': '✓ Saved · runner restarted',

    'quit.title': 'Quit SuperIU?',
    'quit.body': 'The web shell will shut down and the agent session is saved to its JSONL log.',
    'quit.cancel': 'Cancel',
    'quit.confirm': 'Quit',

    'complete.aria': 'Command completion',
    'slash.clear.desc': 'Clear the current context (appends reset_boundary)',
    'slash.status.desc': 'Show agent and workstation status',
    'slash.sessions.desc': 'List persisted sessions',

    'palette.aria': 'Command palette',
    'palette.placeholder': 'Type a command…',
    'palette.empty': 'No matching commands',
    'palette.new': 'New Session',
    'palette.clear': 'Clear Context (/clear)',
    'palette.status': 'Show Status (/status)',
    'palette.sessions': 'List Sessions (/sessions)',
    'palette.settings': 'Open Settings',
    'palette.notify': 'Enable Desktop Notifications',
    'palette.abort': 'Abort Running Turn',
    'palette.quit': 'Quit SuperIU',
    'palette.focus': 'Focus Prompt Input',

    'empty.eyebrow': 'Autonomous Agent',
    'empty.title': 'SuperIU',
    'empty.body': 'Standing by for autonomous reasoning, coding, and system operations.',
    'status.idle': 'Idle',
    'status.running': 'Running',
    'status.thinking': 'Thinking',
    'status.streaming': 'Streaming',
    'status.tool_calling': 'Running a tool',
    'status.completed': 'Completed',
    'status.aborted': 'Aborted',
    'status.error': 'Error',

    'badge.running': 'RUNNING',
    'badge.done': 'DONE',
    'badge.error': 'ERROR',
    'badge.denied': 'DENIED',
    'badge.pending': 'AWAITING',

    'transcript.thinking': 'Thinking…',
    'transcript.thinkingSummary': 'Thinking summary ({n} words)',
    'transcript.step': 'step {n}',
    'transcript.stepReview': 'review · step {n}',
    'transcript.arguments': 'arguments',
    'transcript.output': 'output',
    'transcript.noOutput': '[no output]',
    'transcript.thenRun': 'THEN RUN: {command}',
    'transcript.thenRun.title': 'Chained command executed immediately after the write: {command}',
    'transcript.copy': 'Copy message',
    'transcript.tools': '{n} tools',
    'transcript.waitBlocked': 'Blocked {seconds}s waiting for your approval decision',
    'transcript.aborted': '■ turn aborted by user',

    'approval.title': 'Approval required',
    'approval.via': 'via {name}',
    'approval.waiting': 'waiting for your decision…',
    'approval.approve': 'Approve',
    'approval.reject': 'Reject',
    'approval.approved': '✓ approved — executing',
    'approval.rejected': '✕ rejected — agent will adapt',
    'approval.retired': 'Retired',
    'approval.retiredNote': 'Turn ended before a decision was made',

    'session.file.inMemory': '(in-memory)',
    'session.file.notWritten': '{path} (not written yet)',
    'session.select.empty': '(no session yet)',
    'session.select.none': '(no sessions)',
    'session.untitled': 'Session {id}',

    'toast.clipboard': 'Clipboard unavailable',
    'toast.unknownCommand': 'Unknown command: {cmd}',
    'toast.statusUnavailable': 'Status unavailable: {message}',
    'toast.sessionsUnavailable': 'Sessions unavailable: {message}',
    'toast.bootFailed': 'Boot failed: {message}',
    'toast.abortFirst': 'Abort the running turn first',
    'toast.newSession': 'New session created',
    'toast.loadedSession': 'Loaded session {id}',
    'toast.notifyEnabled': 'Desktop notifications enabled',
    'toast.notifyPermission': 'Notification permission {permission}',
    'toast.notifyUnavailable': 'notifications.js unavailable',
    'toast.contextCleared': 'Context cleared',
    'toast.aborting': 'Aborting turn…',
    'toast.nothingRunning': 'Nothing is running',
    'toast.modelChanged': 'Main model → {model}',
    'toast.settingsSaved': 'Settings saved',
    'toast.shutdown': 'SuperIU web shell shut down. This tab can be closed.',
    'toast.about': 'SuperIU · One Core, Two Shells — autonomous agent console',
    'toast.docs': 'Docs: docs/shells-guide.md · docs/agent-loop-and-context-architecture.md',

    'note.resetBoundary': '✓ reset_boundary appended · active context truncated',

    'notify.stack': 'Notifications',
    'notify.dismiss': 'Dismiss notification',
    'notify.viewApproval': 'View Approval',
    'notify.taskComplete': 'SuperIU: 任务完成 / Task complete',
    'notify.approvalRequired': 'SuperIU: 需要审批 / Approval required',
    'notify.error': 'SuperIU: 执行出错 / Error',
    'notify.waiting': 'The agent is waiting for your decision.',
    'notify.alertsEnabled': 'SuperIU: 通知已启用 / Alerts enabled',
    'notify.alertsEnabledBody': 'You will be notified when a task completes or an approval is needed.',
    'notify.settled': 'The agent loop has settled.',
    'notify.kind.info': 'Info',
    'notify.kind.success': 'Done',
    'notify.kind.error': 'Error',
    'notify.kind.approval': 'Approval'
  }
};

/** `zh-CN`, `zh-Hans`, `en-US`… → a supported id, or `null`. */
function normalize(value) {
  if (typeof value !== 'string' || !value) return null;
  const lower = value.toLowerCase();
  for (const { id } of LANGUAGES) {
    if (lower === id || lower.startsWith(`${id}-`) || lower.startsWith(`${id}_`)) return id;
  }
  return null;
}

function readStored() {
  try {
    return normalize(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Private mode / storage disabled: fall back to the default.
    return null;
  }
}

function writeStored(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* best effort */
  }
}

let language = readStored() ?? DEFAULT_LANGUAGE;
const listeners = new Set();
const warned = new Set();

/** Missing keys are a bug, not a runtime condition: warn once, render the key. */
function lookup(key) {
  const table = DICT[language];
  const value = table[key] ?? DICT[DEFAULT_LANGUAGE][key];
  if (value === undefined && !warned.has(key)) {
    warned.add(key);
    console.warn(`[i18n] missing key: ${key}`);
  }
  return value;
}

/**
 * Translate `key`, substituting `{name}` placeholders from `params`.
 * Values are authored here and never user input, so HTML-bearing entries are
 * safe to hand to `innerHTML` (the `*-html` markup attribute does exactly that).
 */
export function t(key, params) {
  const value = lookup(key);
  if (value === undefined) return key;
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

export function getLanguage() {
  return language;
}

/** The dictionary entry for a `posture.key` sent by the server. */
export function postureLabel(key) {
  return t(`posture.${key}`);
}

/** Translate every annotated node under `root` (defaults to the whole document). */
export function apply(root) {
  const scope = root ?? document;
  scope.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  scope.querySelectorAll('[data-i18n-html]').forEach((node) => {
    node.innerHTML = t(node.dataset.i18nHtml);
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.title = t(node.dataset.i18nTitle);
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  });
  scope.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
    node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
  });
}

export function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Switch language: persist, re-apply the static markup, mirror onto `<html lang>`,
 * tell the desktop shell (which rebuilds its native menu), then let the
 * dynamically rendered regions re-render.
 */
export function setLanguage(next, options = {}) {
  const resolved = normalize(next) ?? DEFAULT_LANGUAGE;
  if (resolved === language && options.force !== true) return language;
  language = resolved;
  if (options.persist !== false) writeStored(language);
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  apply(document);
  void window.superiuDesktop?.setLanguage?.(language)?.catch?.(() => {});
  for (const listener of listeners) listener(language);
  return language;
}

const SuperIUi18n = {
  LANGUAGES,
  DEFAULT_LANGUAGE,
  t,
  apply,
  getLanguage,
  setLanguage,
  onChange,
  postureLabel
};

if (typeof window !== 'undefined') {
  window.SuperIUi18n = SuperIUi18n;
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  // Translate the annotated markup here rather than leaving it to the caller.
  // `boot()` pushes the settings-file value with `setLanguage(v)`, which hits the
  // same-language early-return and therefore never reaches `apply()` — so on the
  // overwhelmingly common path (stored language === file language === zh) this is
  // the ONLY thing that ever translates the static shell. This module is loaded
  // from `<body>`, after the markup it walks, so the nodes are already parsed.
  apply(document);
}

export default SuperIUi18n;
