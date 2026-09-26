/**
 * SuperIU · UI internationalisation.
 *
 * ── Why a module rather than inline strings ─────────────────────────────────
 * The SPA is one large `index.html` plus `notifications.js`. Every
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

    'composer.effort.title': '推理强度',
    'composer.effort.aria': '推理强度',
    'composer.effort.list': '推理强度选项',
    'composer.effort.off': '关闭',
    'composer.effort.unset': '未设置 —— 使用模型默认值',
    'composer.effort.low': '低',
    'composer.effort.medium': '中',
    'composer.effort.high': '高',
    'composer.effort.pending': '已保存 —— 切换到支持推理的模型后生效',

    'composer.model.title': '主模型',
    'composer.model.aria': '选择主模型',
    'composer.model.search': '搜索模型…',
    'composer.model.list': '模型列表',
    'composer.model.empty': '没有匹配的模型',
    'composer.model.current': '当前',
    'composer.model.noModels': '{provider} 尚未添加模型',
    'composer.model.favorites': '收藏',
    'composer.model.favorite.add': '收藏 {model}',
    'composer.model.favorite.remove': '取消收藏 {model}',
    'composer.model.vision': '支持图像输入',
    'composer.model.tools': '支持工具调用',

    'composer.context.title': '{tokens} / {limit}（{percent}%）',
    'composer.context.aria': '上下文占用 {percent}%',
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
    'menu.session.clear.title': '清除当前上下文 (/clear)',

    'menu.model.select': '主模型',
    'menu.model.effort.title': '推理强度',
    'menu.model.tool.title': '工具 / 审查模型',
    'menu.model.noEffort': '不发送',
    'menu.model.autoReviewOff': 'AutoReview 已关闭',

    'menu.status.workstation': '实时工作站快照',
    'menu.status.detecting': '检测中…',

    // Tooltip labels for the workstation badge. The values beside them (OS
    // string, arch, git branch, timestamp) are data and stay verbatim; only
    // these four labels and the "no branch" fallback are copy.
    'workstation.os': '操作系统：',
    'workstation.arch': '架构：',
    'workstation.git': 'Git：',
    'workstation.time': '时间：',
    'workstation.none': '无',

    'menu.emotion.title': '情绪状态',
    'menu.emotion.scale': '近 5 分钟',
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
    'menu.posture.caption': '以下文字即模型实际收到的内容，保持英文。',

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
    'menu.history.empty': '（空）',

    'menu.actions.notify': '通知',
    'menu.actions.notify.on': '通知已开',
    'menu.actions.notify.title': '开启桌面通知',
    'menu.actions.commands': '命令',
    'menu.actions.commands.title': '命令面板',
    'menu.actions.settings': '设置',
    'menu.actions.settings.title': '设置',

    'settings.title': '设置',
    'settings.close': '关闭设置',
    'settings.apiKey': 'API 密钥',
    'settings.apiKey.hint': '密钥保存在本地设备中。留空则保留当前密钥。',
    'settings.baseURL': 'API 地址',
    'settings.baseURL.hint': '服务商 API 基础地址（Base URL），留空使用默认地址。',
    'settings.effort': '推理强度',
    'settings.effort.unset': '未设置 —— 使用模型默认值',
    'settings.effort.active': '当前推理强度：<span class="text-secondary">{level}</span>。',
    'settings.effort.none': '未设置推理强度，将使用服务商默认值。',
    'settings.effort.unsupported': '当前模型不支持调整推理强度。',
    'settings.effort.pending': '已保存 —— 切换到支持推理的模型后生效。',
    'settings.language': '界面语言',
    'settings.language.hint': '立即生效并保存，重启后保持。',
    'settings.theme': '界面主题',
    'settings.theme.hint': '选择界面的外观风格或跟随系统设置。',
    'settings.theme.system': '跟随系统',
    'settings.theme.dark': '深色',
    'settings.theme.light': '浅色',
    'settings.autoReview': 'AutoReview',
    'settings.autoReview.hint': '让每一次工具调用都经过工具模型审核；升级为人工确认的调用会弹出审批卡片。',
    'settings.notifications': '桌面通知与提示音',
    'settings.notifications.hint': '在审批请求与任务完成时提醒。',
    'settings.save': '保存',
    'settings.saving': '保存中…',
    'settings.saved': '✓ 已保存',
    'settings.savedRestarted': '✓ 已保存并生效',

    'settings.nav.general': '通用',
    'settings.nav.providers': '模型配置',
    'settings.nav.about': '关于',
    'settings.general.title': '通用',
    'settings.general.subtitle': '界面、审批与推理行为',
    'settings.about.title': '关于',
    'settings.about.subtitle': '产品信息',
    'settings.about.product': 'SuperIU · 自主智能体控制台',
    'settings.about.storage': '所有设置与密钥仅保存在本机。',
    'settings.providers.title': '模型配置',
    'settings.providers.subtitle': '管理服务商、密钥与可用模型',
    'settings.providers.search': '搜索服务商…',
    'settings.providers.add': '添加服务商',
    'settings.providers.custom': '自定义',
    'settings.providers.empty': '没有匹配的服务商',
    'settings.providers.select': '从左侧选择一个服务商',
    'settings.providers.enabled': '启用',
    'settings.providers.enabledHint': '设为当前生效服务商，对话与任务将通过此服务商执行。',
    'settings.providers.name': '名称',
    'settings.providers.delete': '删除服务商',
    'settings.providers.unnamed': '未命名服务商',
    'settings.providers.desc.openai': 'OpenAI 官方端点，包括 gpt-6-astra、gpt-5.6-terra 与 gpt-4o。',
    'settings.providers.desc.anthropic': 'Anthropic Claude 模型，包括 claude-sonnet-5、claude-opus-5-5 与 claude-haiku-4-5。',
    'settings.providers.desc.gemini': 'Google 官方 OpenAI 兼容端点，包括 gemini-3.8-flash、gemini-2.5-flash 与 gemini-2.5-pro。',
    'settings.providers.desc.deepseek': 'DeepSeek 开放平台，包括 deepseek-flash 与 deepseek-v4-pro。',
    'settings.providers.desc.custom': '兼容 OpenAI 接口规范的自定义端点或本地服务。',
    'settings.providers.apiKey.unchanged': '{masked}（保持不变）',
    'settings.providers.apiKey.unset': '未配置 —— 输入密钥后保存',
    'settings.providers.apiKey.warning': '当前服务商尚未配置密钥，暂时无法使用。请填入密钥后保存。',
    'settings.providers.name.custom': '自定义服务商',
    'settings.providers.apiKey.show': '显示密钥',
    'settings.providers.apiKey.hide': '隐藏密钥',
    'settings.providers.apiKey.get': '获取密钥',
    'settings.providers.fetch': '获取模型',
    'settings.providers.fetching': '获取中…',
    'settings.providers.fetchOk': '已获取 {count} 个模型',
    'settings.providers.fetchFail': '获取失败：{message}',
    'settings.providers.fetchHint': '实时获取该服务商支持的模型列表。',
    'settings.providers.models': '模型',
    'settings.providers.searchModels': '搜索模型…',
    'settings.providers.modelsEmpty': '暂无模型 —— 点击「获取模型」或手动添加。',
    'settings.providers.addModel': '添加模型',
    'settings.providers.modelPlaceholder': '模型 ID',
    'settings.providers.setMain': '设为主模型',
    'settings.providers.setReview': '设为审查模型',
    'settings.dirty': '存在未保存的更改',
    'settings.clean': '所有更改已保存',
    'settings.closeBtn': '关闭',

    'quit.title': '退出 SuperIU？',
    'quit.body': '应用将退出，当前会话已保存在本地。',
    'quit.cancel': '取消',
    'quit.confirm': '退出',

    'complete.aria': '命令补全',
    'slash.clear.desc': '清空当前上下文，后续对话从新轮次开始',
    'slash.status.desc': '查看智能体与工作台状态',
    'slash.sessions.desc': '列出已保存的会话',

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

    // The /status card pads its own labels so the values line up as a column.
    // A CJK glyph (11.5px) is not an integral multiple of a monospace cell
    // (6.92px), so ASCII spaces alone cannot align labels whose CJK length
    // differs — each label carries U+3000 ideographic spaces sized so that
    // every one occupies exactly six fullwidth cells, plus two ASCII spaces to
    // land on the English column. Same reasoning as the CLI's `cli.status.*`
    // keys; the `\u3000` escapes keep the padding reviewable.
    'status.card.state': '状态：\u3000\u3000\u3000  ',
    'status.card.session': '会话：\u3000\u3000\u3000  ',
    'status.card.leaf': '叶节点：\u3000\u3000  ',
    'status.card.messages': '消息数：\u3000\u3000  ',
    'status.card.file': '日志文件：\u3000  ',
    'status.card.mainModel': '主模型：\u3000\u3000  ',
    'status.card.toolModel': '工具模型：\u3000  ',
    'status.card.effort': '推理强度：\u3000  ',
    'status.card.valence': '效价：\u3000\u3000\u3000  ',
    'status.card.arousal': '\u3000唤醒度：\u3000  ',
    'status.card.fatigue': '\u3000疲劳度：\u3000  ',
    'status.card.posture': '运行姿态：\u3000  ',
    'status.card.root': '（根）',
    'status.card.autoReviewOff': '（AutoReview 已关闭）',
    'status.card.noEffort': '（未发送）',

    'badge.running': '运行中',
    'badge.done': '完成',
    'badge.error': '错误',
    'badge.denied': '已拒绝',
    'badge.pending': '待确认',

    'transcript.thinking': '思考中…',
    'transcript.thinkingSummary': '思考摘要（{n} 字）',
    'transcript.step': '步骤 {n}',
    'transcript.stepReview': '复核 · 步骤 {n}',
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
    'approval.risk.safe': '安全',
    'approval.risk.low': '低',
    'approval.risk.medium': '中',
    'approval.risk.high': '高',
    'approval.risk.critical': '严重',
    'approval.risk.unknown': '未知',
    'approval.reviewer.rule': '规则引擎',
    'approval.reviewer.model': '审查模型',
    'approval.reviewer.unknown': '未知来源',
    'approval.waiting': '等待你的决定…',
    'approval.approve': '允许执行',
    'approval.reject': '拒绝',
    'approval.approved': '✓ 已允许 —— 正在执行',
    'approval.rejected': '✕ 已拒绝 —— 智能体将调整',
    'approval.retired': '已失效',
    'approval.retiredNote': '本轮在做出决定前已结束',

    'session.file.inMemory': '（内存中）',
    'session.file.notWritten': '{path}（尚未写入）',
    'session.select.empty': '（未开始的新会话）',
    'session.select.none': '（暂无会话）',
    'session.untitled': '未命名会话',

    'toast.clipboard': '剪贴板不可用',
    'toast.unknownCommand': '未知命令：{cmd}',
    'toast.statusUnavailable': '状态不可用：{message}',
    'toast.sessionsUnavailable': '会话列表不可用：{message}',
    'toast.bootFailed': '启动失败：{message}',
    'toast.abortFirst': '请先中止正在运行的一轮',
    'toast.newSession': '已创建新会话',
    'toast.loadedSession': '已加载会话 {id}',
    'toast.notifyEnabled': '桌面通知已开启',
    'toast.notifyPermission': '无法获取桌面通知权限。',
    'toast.notifyPermission.granted': '桌面通知已开启。',
    'toast.notifyPermission.denied': '桌面通知权限被拒绝，请在系统设置中开启。',
    'toast.notifyPermission.default': '桌面通知权限尚未授权。',
    'toast.notifyPermission.unsupported': '此环境不支持桌面通知。',
    'toast.notifyUnavailable': '此环境不支持桌面通知。',
    'toast.requestFailed': '请求失败，请稍后重试。',
    'toast.contextCleared': '上下文已清空',
    'toast.aborting': '正在中止本轮…',
    'toast.nothingRunning': '当前没有正在运行的任务',
    'toast.modelChanged': '主模型 → {model}',
    'toast.settingsSaved': '设置已保存',
    'toast.shutdown': 'SuperIU 已关闭，此标签页可以关闭了。',

    'note.resetBoundary': '✓ 上下文已清空 · 后续对话将作为新轮次开始',

    'notify.stack': '通知',
    'notify.dismiss': '关闭通知',
    'notify.viewApproval': '查看审批',
    'notify.taskComplete': 'SuperIU：任务完成',
    'notify.approvalRequired': 'SuperIU：需要审批',
    'notify.error': 'SuperIU：执行出错',
    'notify.waiting': '智能体正在等待你的决定。',
    'notify.alertsEnabled': 'SuperIU：通知已启用',
    'notify.alertsEnabledBody': '任务完成或需要审批时，你会收到提醒。',
    'notify.settled': '任务已结束，没有更多输出。',
    'notify.approvalFallback': '此操作需要你确认后才会执行。',
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

    'composer.effort.title': 'Reasoning effort',
    'composer.effort.aria': 'Reasoning effort',
    'composer.effort.list': 'Reasoning effort options',
    'composer.effort.off': 'Off',
    'composer.effort.unset': 'Unset — use the model default',
    'composer.effort.low': 'Low',
    'composer.effort.medium': 'Medium',
    'composer.effort.high': 'High',
    'composer.effort.pending': 'Saved — applies once a reasoning-capable model is active',

    'composer.model.title': 'Main model',
    'composer.model.aria': 'Choose the main model',
    'composer.model.search': 'Search models…',
    'composer.model.list': 'Model list',
    'composer.model.empty': 'No matching model',
    'composer.model.current': 'Current',
    'composer.model.noModels': '{provider} has no models yet',
    'composer.model.favorites': 'Favorites',
    'composer.model.favorite.add': 'Add {model} to favorites',
    'composer.model.favorite.remove': 'Remove {model} from favorites',
    'composer.model.vision': 'Accepts image input',
    'composer.model.tools': 'Supports tool calls',

    'composer.context.title': '{tokens} / {limit} ({percent}%)',
    'composer.context.aria': 'Context usage {percent}%',
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
    'menu.session.clear.title': 'Clear conversation context (/clear)',

    'menu.model.select': 'Main model',
    'menu.model.effort.title': 'Reasoning effort',
    'menu.model.tool.title': 'Tool / review model',
    'menu.model.noEffort': 'no effort',
    'menu.model.autoReviewOff': 'AutoReview off',

    'menu.status.workstation': 'Live workstation snapshot',
    'menu.status.detecting': 'detecting…',

    'workstation.os': 'OS:',
    'workstation.arch': 'Arch:',
    'workstation.git': 'Git:',
    'workstation.time': 'Time:',
    'workstation.none': 'n/a',

    'menu.emotion.title': 'Emotion State',
    'menu.emotion.scale': 'last 5 minutes',
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
    'menu.posture.caption': 'The text below is exactly what the model receives, so it stays in English.',

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
    'settings.apiKey': 'API Key',
    'settings.apiKey.hint': 'Stored locally on your device. Leave empty to keep current key.',
    'settings.baseURL': 'Base URL',
    'settings.baseURL.hint': 'Provider API base URL. Leave empty to use the default.',
    'settings.effort': 'Reasoning Effort',
    'settings.effort.unset': 'Unset — use the model default',
    'settings.effort.active': 'Current reasoning effort: <span class="text-secondary">{level}</span>.',
    'settings.effort.none': 'No reasoning effort set; the provider default applies.',
    'settings.effort.unsupported': 'The current model does not support adjusting reasoning effort.',
    'settings.effort.pending': 'Saved — it applies once you switch to a reasoning-capable model.',
    'settings.language': 'Interface Language',
    'settings.language.hint': 'Applies immediately and persists across restarts.',
    'settings.theme': 'Appearance',
    'settings.theme.hint': 'Select color appearance or match system settings.',
    'settings.theme.system': 'System',
    'settings.theme.dark': 'Dark',
    'settings.theme.light': 'Light',
    'settings.autoReview': 'AutoReview',
    'settings.autoReview.hint':
      'Gate every tool call through the tool model. Escalated calls surface an interactive approval card.',
    'settings.notifications': 'Desktop notifications & chime',
    'settings.notifications.hint': 'Alert on approval requests and task completion.',
    'settings.save': 'Save',
    'settings.saving': 'Saving…',
    'settings.saved': '✓ Saved',
    'settings.savedRestarted': '✓ Saved and applied',

    'settings.nav.general': 'General',
    'settings.nav.providers': 'Model Configuration',
    'settings.nav.about': 'About',
    'settings.general.title': 'General',
    'settings.general.subtitle': 'Interface, approvals, and reasoning behaviour',
    'settings.about.title': 'About',
    'settings.about.subtitle': 'Product information',
    'settings.about.product': 'SuperIU · Autonomous agent console',
    'settings.about.storage': 'All settings and keys are stored on this device only.',
    'settings.providers.title': 'Model Configuration',
    'settings.providers.subtitle': 'Manage providers, credentials, and available models',
    'settings.providers.search': 'Search providers…',
    'settings.providers.add': 'Add provider',
    'settings.providers.custom': 'Custom',
    'settings.providers.empty': 'No matching providers',
    'settings.providers.select': 'Select a provider on the left',
    'settings.providers.enabled': 'Enabled',
    'settings.providers.enabledHint': 'Set as the active provider; conversation and tasks will route through it.',
    'settings.providers.name': 'Name',
    'settings.providers.delete': 'Delete provider',
    'settings.providers.unnamed': 'Unnamed provider',
    'settings.providers.desc.openai': "OpenAI's own endpoint, including gpt-6-astra, gpt-5.6-terra, and gpt-4o.",
    'settings.providers.desc.anthropic': 'Anthropic Claude models, including claude-sonnet-5, claude-opus-5-5, and claude-haiku-4-5.',
    'settings.providers.desc.gemini': "Google's OpenAI-compatible endpoint, including gemini-3.8-flash, gemini-2.5-flash, and gemini-2.5-pro.",
    'settings.providers.desc.deepseek': 'The DeepSeek platform, including deepseek-flash and deepseek-v4-pro.',
    'settings.providers.desc.custom': 'OpenAI-compatible custom endpoint or local service.',
    'settings.providers.apiKey.unchanged': '{masked} (unchanged)',
    'settings.providers.apiKey.unset': 'Not configured — enter a key and save',
    'settings.providers.apiKey.warning': 'This provider has no API key yet and cannot be used. Enter a key and save.',
    'settings.providers.name.custom': 'Custom provider',
    'settings.providers.apiKey.show': 'Show key',
    'settings.providers.apiKey.hide': 'Hide key',
    'settings.providers.apiKey.get': 'Get an API key',
    'settings.providers.fetch': 'Fetch models',
    'settings.providers.fetching': 'Fetching…',
    'settings.providers.fetchOk': 'Fetched {count} models',
    'settings.providers.fetchFail': 'Fetch failed: {message}',
    'settings.providers.fetchHint': 'Fetch available models from this provider.',
    'settings.providers.models': 'Models',
    'settings.providers.searchModels': 'Search models…',
    'settings.providers.modelsEmpty': 'No models yet — fetch them or add one manually.',
    'settings.providers.addModel': 'Add model',
    'settings.providers.modelPlaceholder': 'Model ID',
    'settings.providers.setMain': 'Set as main',
    'settings.providers.setReview': 'Set as review',
    'settings.dirty': 'Unsaved changes',
    'settings.clean': 'All changes saved',
    'settings.closeBtn': 'Close',

    'quit.title': 'Quit SuperIU?',
    'quit.body': 'The application will close. Your session is saved locally.',
    'quit.cancel': 'Cancel',
    'quit.confirm': 'Quit',

    'complete.aria': 'Command completion',
    'slash.clear.desc': 'Clear the current context; later messages start fresh',
    'slash.status.desc': 'Show agent and workstation status',
    'slash.sessions.desc': 'List saved sessions',

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

    // Padding rationale lives on the zh entries; the English labels are twelve
    // monospace cells, which is the column the Chinese labels are sized to.
    'status.card.state': 'state:      ',
    'status.card.session': 'session:    ',
    'status.card.leaf': 'leaf:       ',
    'status.card.messages': 'messages:   ',
    'status.card.file': 'file:       ',
    'status.card.mainModel': 'main model: ',
    'status.card.toolModel': 'tool model: ',
    'status.card.effort': 'effort:     ',
    'status.card.valence': 'valence:    ',
    // The arousal/fatigue labels keep a leading separator, because the emotion
    // row is a run of label+value pairs: without it the previous value would
    // touch the next label.
    'status.card.arousal': '   arousal: ',
    'status.card.fatigue': '   fatigue: ',
    'status.card.posture': 'posture:    ',
    'status.card.root': '(root)',
    'status.card.autoReviewOff': ' (autoReview off)',
    'status.card.noEffort': '(none sent)',

    'badge.running': 'RUNNING',
    'badge.done': 'DONE',
    'badge.error': 'ERROR',
    'badge.denied': 'DENIED',
    'badge.pending': 'AWAITING',

    'transcript.thinking': 'Thinking…',
    'transcript.thinkingSummary': 'Thinking summary ({n} words)',
    'transcript.step': 'step {n}',
    'transcript.stepReview': 'check · step {n}',
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
    'approval.risk.safe': 'safe',
    'approval.risk.low': 'low',
    'approval.risk.medium': 'medium',
    'approval.risk.high': 'high',
    'approval.risk.critical': 'critical',
    'approval.risk.unknown': 'unknown',
    'approval.reviewer.rule': 'rule engine',
    'approval.reviewer.model': 'review model',
    'approval.reviewer.unknown': 'unknown source',
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
    'session.untitled': 'Untitled session',

    'toast.clipboard': 'Clipboard unavailable',
    'toast.unknownCommand': 'Unknown command: {cmd}',
    'toast.statusUnavailable': 'Status unavailable: {message}',
    'toast.sessionsUnavailable': 'Sessions unavailable: {message}',
    'toast.bootFailed': 'Boot failed: {message}',
    'toast.abortFirst': 'Abort the running turn first',
    'toast.newSession': 'New session created',
    'toast.loadedSession': 'Loaded session {id}',
    'toast.notifyEnabled': 'Desktop notifications enabled',
    'toast.notifyPermission': 'Could not determine the desktop notification permission.',
    'toast.notifyPermission.granted': 'Desktop notifications are enabled.',
    'toast.notifyPermission.denied': 'Desktop notification permission was denied — enable it in System Settings.',
    'toast.notifyPermission.default': 'Desktop notification permission has not been granted yet.',
    'toast.notifyPermission.unsupported': 'Desktop notifications are not available in this environment.',
    'toast.notifyUnavailable': 'Desktop notifications are not available in this environment.',
    'toast.requestFailed': 'The request failed. Please try again.',
    'toast.contextCleared': 'Context cleared',
    'toast.aborting': 'Aborting turn…',
    'toast.nothingRunning': 'Nothing is running',
    'toast.modelChanged': 'Main model → {model}',
    'toast.settingsSaved': 'Settings saved',
    'toast.shutdown': 'SuperIU has shut down. This tab can be closed.',

    'note.resetBoundary': '✓ Context cleared · subsequent messages start a new context',

    'notify.stack': 'Notifications',
    'notify.dismiss': 'Dismiss notification',
    'notify.viewApproval': 'View Approval',
    'notify.taskComplete': 'SuperIU: 任务完成 / Task complete',
    'notify.approvalRequired': 'SuperIU: 需要审批 / Approval required',
    'notify.error': 'SuperIU: 执行出错 / Error',
    'notify.waiting': 'The agent is waiting for your decision.',
    'notify.alertsEnabled': 'SuperIU: 通知已启用 / Alerts enabled',
    'notify.alertsEnabledBody': 'You will be notified when a task completes or an approval is needed.',
    'notify.settled': 'The task finished without further output.',
    'notify.approvalFallback': 'This action needs your confirmation before it can run.',
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
 * Values are authored here and never user input, so an entry that carries
 * inline markup (`settings.effort.active`) is safe to hand to `innerHTML` —
 * which is what `renderReasoningHint()` does with it.
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
