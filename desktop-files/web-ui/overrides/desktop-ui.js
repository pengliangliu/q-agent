import './desktop-contextmenus.js'
import '/static/app/codexLayout.js'
import { effect } from '@preact/signals'
import { languageSignal } from '/static/app/desktopPreferences.js'

for (const href of ['/desktop-ui.css', '/static/app/chat.css', '/static/app/project.css', '/static/app/activity.css']) {
  const resolved = new URL(href, location.origin).href
  if (![...document.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === resolved)) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'; link.href = href; document.head.append(link)
  }
}
const themeStylesheet = document.querySelector('link[data-codex-theme]')
if (themeStylesheet) document.head.append(themeStylesheet)

// Translate only known interface labels. Session names, paths, user fields,
// file contents and xterm's terminal output retain their original text.
const labels = new Map(Object.entries({
  'Command Center': '指挥中心', 'Fleet': '会话总览', 'Terminal': '终端',
  'MCPs': 'MCP 服务', 'Skills': '技能', 'Conductor': '协调器',
  'Watchers': '监视器', 'Costs': '费用', 'Search': '搜索', 'Archived': '已归档',
  'Sessions': '会话', 'SESSIONS': '会话', 'SESSION': '会话', 'Session': '会话',
  'New session': '新建会话', 'New session (n)': '新建会话（n）',
  'New group': '新建分组', 'New': '新建', 'NEW': '新建',
  'Start': '启动', 'Stop': '停止', 'Restart': '重启', 'Fork': '分支会话',
  'Archive': '归档', 'Unarchive': '取消归档', 'Restore': '恢复',
  'Delete': '删除', 'Edit': '编辑', 'Rename': '重命名', 'Close': '关闭',
  'Cancel': '取消', 'Confirm': '确认', 'Save': '保存', 'Save changes': '保存更改',
  'Create': '创建', 'Create session': '创建会话', 'Create group': '创建分组',
  'Apply': '应用', 'Reset': '重置', 'Done': '完成', 'done': '完成',
  'Refresh': '刷新', 'Retry': '重试', 'Dismiss': '关闭提示', 'Continue': '继续',
  'Back': '返回', 'Next': '下一步', 'Open': '打开', 'Copy': '复制',
  'Copied': '已复制', 'Copy path': '复制路径', 'Details': '详情',
  'Settings': '设置', 'SETTINGS': '设置', 'Close settings': '关闭设置',
  'Tweaks': '界面设置', 'Close tweaks': '关闭界面设置', 'Overview': '概览',
  'Usage & activity': '用量与活动', 'Right-rail panels': '右侧面板',
  'Children (conductor)': '子会话（协调器）', 'Events (watcher)': '事件（监视器）',
  'Toggle right rail': '切换右侧面板', 'Hide right rail (])': '隐藏右侧面板（]）',
  'Show right rail (])': '显示右侧面板（]）',
  'Jump to session, search conversations, run command…': '切换会话、搜索对话或运行命令…',
  'Search sessions…': '搜索会话…', 'Filter sessions…': '筛选会话…',
  'Filter…': '筛选…', 'Search…': '搜索…', 'Search conversations': '搜索对话',
  'Search conversations…': '搜索对话…', 'Search sessions': '搜索会话',
  'No results': '没有匹配结果', 'No results found': '没有匹配结果',
  'No matching sessions': '没有匹配的会话', 'No sessions': '暂无会话',
  'No sessions yet': '暂无会话', 'No sessions yet.': '暂无会话。',
  'No sessions yet. Press': '暂无会话。按', 'to create one.': '创建会话。',
  'Select a session': '选择一个会话', 'Select a session to get started': '选择一个会话开始工作',
  'Select a session to view details': '选择一个会话查看详情',
  'Select a session from the sidebar': '从左侧选择一个会话',
  'No active sessions': '没有运行中的会话', 'No archived sessions': '暂无归档会话',
  'OVERVIEW': '概览', 'USAGE': '用量', 'MCPS': 'MCP 服务', 'SKILLS': '技能',
  'CHILDREN': '子会话', 'EVENTS': '事件', '/ filter': '/ 筛选',
  'cost data not available for this session': '此会话暂无费用数据',
  'MCP attachments not exposed via web API. Use TUI (m key).': '请在终端界面按 m 查看会话的 MCP 服务。',
  'Skill attachments not exposed via web API. Use TUI (s key).': '请在终端界面按 s 查看会话的技能。',
  'All': '全部', 'Active': '运行中', 'Running': '运行中', 'Waiting': '待输入',
  'Idle': '空闲', 'Stopped': '已停止', 'Error': '错误', 'Starting': '启动中',
  'running': '运行中', 'waiting': '待输入', 'idle': '空闲', 'stopped': '已停止',
  'error': '错误', 'starting': '启动中', 'active now': '正在活动',
  'Connected': '已连接', 'Disconnected': '未连接', 'Connecting': '连接中',
  'connecting': '连接中', 'disconnected': '未连接', 'connected': '已连接',
  'Reconnecting…': '重新连接中…', 'Loading…': '加载中…', 'loading…': '加载中…',
  'live': '已连接', 'palette': '命令', 'filter': '筛选', 'rail': '面板',
  'sessions': '会话', 'profile ·': '配置档 ·', 'sessions ·': '会话 ·',
  'Loading...': '加载中…', 'Loading': '加载中', 'Saving…': '保存中…',
  'Terminal disconnected': '终端连接已断开', 'Restart session': '重启会话',
  'Show columns': '显示列', 'SHOW IN ROW': '会话行显示内容',
  'Last active': '最近活动', 'Last seen': '最近活动', 'Collapse group': '收起分组',
  'Expand group': '展开分组', 'Rename group': '重命名分组',
  'Finish worktree (merge + cleanup)': '结束工作树（合并并清理）',
  'GROUP': '分组', 'Group': '分组', 'Groups': '分组', 'NAME': '名称',
  'Name': '名称', 'WORKING DIR': '工作目录', 'Working directory': '工作目录',
  'TOOL': '工具', 'Tool': '工具', 'Tools': '工具', 'MODEL ID': '模型 ID',
  'Model': '模型', 'Tool default': '工具默认值', 'Custom model ID…': '自定义模型 ID…',
  'REASONING EFFORT': '推理强度', 'Reasoning effort': '推理强度',
  'Default': '默认', 'Optional': '可选', 'Required': '必填',
  'Title': '标题', 'Project': '项目', 'Path': '路径', 'Branch': '分支',
  'Attach': '添加', 'Detach': '移除', 'Attached': '已添加', 'Available': '可用',
  'Installed': '已安装', 'Enabled': '已启用', 'Disabled': '已禁用',
  'Enable': '启用', 'Disable': '禁用', 'Manage': '管理', 'Browse': '浏览',
  'profile': '配置档', 'version': '版本', 'read-only': '只读',
  'web mutations': '网页操作', 'hidden tools': '隐藏工具', 'picker tools': '可选工具',
  'trusted domains': '受信任域名', 'link confirm': '打开链接前确认',
  'file link roots': '可打开的文件目录', 'none (copy path)': '未设置（复制路径）',
  'kind': '类型', 'tool': '工具', 'model': '模型', 'model id': '模型 ID',
  'group': '分组', 'branch': '分支', 'path': '路径', 'sandbox': '沙箱',
  'worktree': '工作树', 'tags': '标签', 'cost': '费用', 'tokens': 'Token 用量',
  'yes': '是', 'no': '否', 'on': '开启', 'off': '关闭',
  'enabled': '已启用', 'disabled': '已禁用', 'none': '无', 'unknown': '未知',
  'or use TUI Settings → Visible tools…': '或在终端设置中选择“可见工具”…',
  ') or use TUI Settings → Visible tools…': '）或在终端设置中选择“可见工具”…',
  'ACCENT': '强调色', 'DENSITY': '界面密度', 'RIGHT RAIL': '右侧面板',
  'NOTIFICATIONS': '通知', 'Accent': '强调色', 'Density': '界面密度',
  'Balanced': '标准', 'Compact': '紧凑', 'Comfortable': '宽松',
  'balanced': '标准', 'compact': '紧凑', 'comfortable': '宽松',
  'Visible': '显示', 'Hidden': '隐藏', 'visible': '显示', 'hidden': '隐藏',
  'Blue': '蓝色', 'Purple': '紫色', 'Green': '绿色', 'Orange': '橙色',
  'Notifications': '通知', 'Enable notifications': '开启通知',
  'Notification history': '通知历史', 'No notifications': '暂无通知',
  'Clear': '清空', 'Clear all': '全部清空', 'Mark all read': '全部标为已读',
  'HELP': '帮助', 'Help': '帮助', 'Keyboard shortcuts': '快捷键',
  'Command palette': '命令面板', 'Focus session filter / search': '聚焦会话筛选或搜索',
  'Move focus down (groups and sessions)': '向下选择分组或会话',
  'Move focus up (groups and sessions)': '向上选择分组或会话',
  'Move focus up': '向上选择', 'Move focus down': '向下选择',
  'Collapse focused group': '收起选中的分组', 'Expand focused group': '展开选中的分组',
  'Open focused session / toggle focused group': '打开选中会话或展开、收起分组',
  'Open focused session in new browser tab': '在新标签页打开选中会话',
  'New session in the focused group': '在选中分组中新建会话',
  'Rename focused group (session rename is TUI-only today)': '重命名选中分组（会话重命名使用终端界面）',
  'Close focused session (stop process, keep metadata)': '关闭选中会话（保留会话记录）',
  'Undo last delete (within 30s)': '撤销最近一次删除（30 秒内）',
  'Close current modal / overlay': '关闭当前弹窗', 'Close modal / unfocus input': '关闭弹窗或退出输入框',
  'Toggle this help overlay': '显示或隐藏快捷键帮助',
  'Active profile (bound at startup; not switchable from the web UI)': '当前配置档（启动时确定）',
  'Close session?': '关闭会话？', 'Delete session?': '删除会话？',
  'Archive session?': '归档会话？', 'Restart session?': '重启会话？',
  'Edit session': '编辑会话',
  'No MCP servers': '暂无 MCP 服务', 'No skills': '暂无技能',
  'No children': '暂无子会话', 'No events': '暂无事件',
  'Today': '今天', 'This week': '本周', 'This month': '本月',
  'Total': '合计', 'Activity': '活动', 'Recent activity': '最近活动',
  'Status': '状态', 'Actions': '操作', 'Send': '发送', 'Sending…': '发送中…',
  '➤ Send': '➤ 发送', 'Route to': '发送到', 'Comment / answer this': '评论或回复',
  'Waiting for the first fleet snapshot…': '正在加载会话状态…',
  '● connecting…': '● 连接中…', '● offline': '● 未连接', '● live': '● 已连接',
  '👉 Needs you': '👉 需要你处理', 'nothing waiting on you 🎉': '暂无待处理事项 🎉',
  '🛰️ The fleet — what each is doing': '🛰️ 会话工作状态',
  'no conductors detected': '暂无协调器', 'no active sessions': '没有运行中的会话',
  'model unavailable': '模型不可用', 'auth error (401)': '身份验证失败（401）',
  'idle (empty prompt)': '空闲（等待输入）',
  'answer a decision, comment, or instruct… ⌘/Ctrl+Enter to send': '回复、评论或输入指令… 按 Ctrl+Enter 发送',
}))

const preserved = 'script,style,pre,code,textarea,[contenteditable="true"],[translate="no"],.chat-bubble,.chat-markdown,.chat-user-text,.xterm,.tt,.side-group-head .name,.rd-v,.path .cur,.path .seg,.tpath,.status-chip.model,.tag,.skill-name,.mcp-name,.desktop-file-info,.hint-headline,.annotation-line,.cc-ask-text,.cc-stt,.cc-shl,.cc-md,.cc-nm,.cc-ac,.cc-summary-src,.cc-message,.cc-log,.markdown,.mini-markdown,[data-desktop-preserve]'

for (const [source, target] of Object.entries({
  'Folder does not exist.': '目录尚不存在。',
  'Opt in below to create it when you submit the session.': '勾选下方选项以在提交时创建目录。',
  'Create this folder': '创建此目录', 'Directories to create:': '将创建以下目录：',
  'Missing working directory': '工作目录尚不存在', 'Directories': '目录',
  'Working directory': '工作目录', 'Title': '会话名称', 'Session title': '会话名称',
  'Tool': '助手', 'Model': '模型', 'Reasoning effort': '思考强度',
  'Group': '项目或分组', 'Start session': '启动会话', 'Start immediately': '立即启动',
  'Inherit': '继承现有设置', 'Default': '默认', 'Advanced': '高级选项',
})) labels.set(source, target)

for (const [source, target] of Object.entries({
  'Chat': '聊天', 'New project': '新建项目', 'Projects and sessions': '项目与会话',
  'Project actions': '项目操作', 'Session actions': '会话操作', 'New child project': '新建子项目',
  'Open project folder': '打开项目文件夹', 'Open project directory': '打开项目目录',
  'Open in file manager': '在文件管理器中显示', 'Reveal file location': '显示文件所在位置',
  'Copy full path': '复制完整路径', 'Locate file': '定位文件', 'File or folder path': '文件或文件夹路径',
  'Paste a Windows or WSL path': '粘贴 Windows 或 WSL 文件路径', 'Choose file location': '选择文件位置',
  'Multiple locations found. Choose one.': '找到多个位置，请选择要打开的文件', 'Cancel location selection': '取消选择文件位置',
  'Independent terminal': '独立终端', 'Open in independent terminal': '在独立终端打开',
  'Advanced controls': '高级控制', 'Open advanced controls': '打开高级控制', 'Close advanced controls': '关闭高级控制',
  'Native controls for this session': '当前会话的原生交互界面', 'Advanced session controls': '高级会话控制',
  'Current chat': '当前会话', 'Message input': '消息输入框', 'Ready for messages': '可以发送消息',
  'Working…': '正在处理…', 'Working': '正在处理', 'Waiting for your confirmation': '等待你的确认',
  'Background tasks running': '后台任务运行中', 'Submitting message…': '正在提交消息…',
  'Not running': '未运行', 'Connecting…': '正在连接', 'Starting…': '正在启动',
  'Switching model': '正在切换模型', 'Start failed': '会话启动失败', 'Retry start': '重新启动会话',
  'Send message': '发送消息', 'Queue message': '加入队列', 'Stop generating': '停止生成',
  'Stopping…': '正在停止…', 'Add images or files': '添加图片或文件', 'Remove attachment': '移除附件',
  'Files uploading…': '文件上传中…', 'Copy reply': '复制回复', 'Reply copied': '回复已复制',
  'Load earlier messages': '查看更早消息', 'Loading chat history': '正在加载聊天记录',
  'Connecting to the current session and restoring context.': '连接当前会话，恢复上下文。',
  'Reconnect': '重新连接', 'Latest messages': '最新消息', '↓ Latest messages': '↓ 最新消息',
  'Close message': '关闭提示', 'Read-only session': '当前会话为只读模式',
  'Draft your message, then start the session to send…': '先写下你的想法，启动会话后发送…',
  'Enter to send · Shift + Enter for newline · / commands': 'Enter 发送 · Shift + Enter 换行 · / 命令',
  'Working; new messages are queued · Enter to submit': '正在处理，新消息将加入队列 · Enter 提交',
  'Enter to run command · / available commands': 'Enter 执行命令 · / 查看可用命令',
  'Remove attachments before running a command': '命令不支持附件，请移除附件后执行',
  'Drop files or paste screenshots · Up to 100 MB per file': '支持拖入多个文件、粘贴截图 · 单个文件不超过 100 MB',
  'Drop to add files': '松开即可添加文件', 'Add images, documents or code together': '图片、文档或代码，可一次添加多个',
  'Based on this reply': '基于本轮回复', 'Accept suggestion': '接受建议', 'Accept next-step suggestion': '接受下一步建议',
  'Esc to dismiss · Enter to send': 'Esc 忽略 · Enter 发送',
  'Choose model and effort': '选择模型与强度', 'Current session model': '当前会话模型',
  'Current session model settings': '当前会话模型设置', 'Close model settings': '关闭模型设置',
  'Apply to current session': '应用到当前会话', 'Refresh status': '刷新状态',
  'Choose a model': '请选择模型', 'Choose effort': '请选择强度', 'Effort unconfirmed': '强度未确认',
  'Current model unconfirmed': '当前模型尚未确认',
  'No effort levels': '无强度档位', 'Checking current model…': '正在核对当前模型…',
  'Model settings updated for this session.': '已切换当前会话的模型与强度。',
  'Session quota': '会话额度', '5 hours': '5 小时', 'Weekly': '每周',
  'Loading quota…': '读取中…', 'Unavailable from tool': '原生未提供', 'Read failed': '读取失败',
  'Awaiting update after reset': '重置后待更新', 'Quota temporarily unavailable': '暂时无法读取额度',
  'Deliver now': '立即投递', 'Query delivery status': '查询投递状态',
  'Stop waiting': '停止等待', 'Clear unsubmitted command': '清除未提交命令',
  'Stopped waiting.': '已停止等待。',
  'Clearing the unsubmitted model command…': '正在清除未提交的模型命令…',
  'The unsubmitted model command was cleared. You can apply settings again.': '未提交的模型命令已清除，可以重新应用设置。',
  'The unsubmitted model command was cleared. Choose the model and effort again.': '已清除未提交的模型命令，可重新选择模型与强度。',
  'The model command was not confirmed; Enter was not sent.': '原生模型命令尚未通过核对，未发送 Enter。',
  'The model change is unconfirmed. Refresh to check the current state.': '切换结果尚未确认，请刷新核对当前状态。',
  'Delivering now may interrupt this turn.': '立即投递可能中断当前回合。',
  'Message queued; awaiting confirmation': '消息已排队，等待会话确认', 'Message not delivered': '消息未送达',
  'Delivery result unconfirmed': '发送结果待确认', 'Move back to composer': '移回输入框',
  'Local tracking stopped; original request retained': '已停止本地跟踪，原请求保留',
  'Query original request': '查询原请求', 'Stop local tracking': '停止本地跟踪',
  'Submit staged message': '提交已暂存消息', 'Run command': '执行命令',
  'Waiting for command selection': '等待命令选择', 'Command result unconfirmed': '命令结果待确认',
  'Command running': '命令处理中', 'Continue in independent terminal': '在独立终端继续',
  'Session question': '会话提问', 'Permission confirmation': '权限确认',
  'Your confirmation is needed': '需要你的确认', 'Your answer is needed': '需要你的回答',
  'Review and submit answers': '核对并提交回答', 'Select one, then submit': '请选择一项，再提交',
  'Select multiple, then submit': '可选择多项，选好后提交', 'Other answer': '其他答案',
  'Additional answer': '补充回答', 'Submit selection': '提交选择', 'Submit answer': '提交回答',
  'Submit all answers': '提交全部答案', 'Next question': '下一题', 'Confirm this question': '确认本题',
  'Submitting…': '正在提交…', 'Refresh current prompt': '刷新当前提示',
  'Waiting for your input': '正在等待你的操作', 'Completion notifications': '完成通知',
  'Reply completion notifications': '回复完成通知', 'No unread completed replies': '暂无未读的完成回复',
  'Enable system notifications': '开启系统通知', 'Disable system notifications': '关闭系统通知',
  'Close notifications': '关闭通知', 'Search sessions and commands': '搜索会话与命令',
  'Reply completion notifications are disabled in settings.': '回复完成提示已在设置中关闭。',
  'Close completion notifications': '关闭完成通知', 'Reply complete · Click to view': '回复已完成 · 点击查看',
  'Enable app system notifications': '开启本应用系统提醒', 'Disable app system notifications': '关闭本应用系统提醒',
  'Requesting permission…': '正在请求权限…', 'Browser notifications are unsupported': '浏览器不支持系统通知',
  'Browser notifications are blocked': '浏览器已阻止系统通知',
  'Allow notifications in browser site settings.': '可在浏览器的网站设置中允许通知。',
  'Notifications while this page is open. Current replies show a toast; background replies enter the unread list.': '页面打开期间提醒。当前会话轻提示，后台回复加入未读列表。',
  'Project and session actions': '项目和会话', 'Available commands': '可用命令', 'Close command menu': '关闭命令菜单',
  'Reading available commands…': '正在读取可用命令…', 'No matching commands': '没有匹配的可用命令',
  'Native menu · Continue choosing': '原生菜单 · 继续选择', 'Native command': '原生命令',
  '↑↓ to select · Tab / Enter to insert · Esc to close': '↑↓ 选择 · Tab / Enter 填入 · Esc 关闭',
  'Enter your answer': '填写你的答案',
  'Create project': '创建项目', 'Project name': '项目名称', 'Parent project': '父项目',
  'Top-level project': '顶级项目', 'Project directory': '项目目录', 'Choose folder': '选择文件夹',
  'Create missing directory': '创建不存在的目录', 'Parent session': '父会话',
  'Open settings': '打开设置', 'Interface language': '界面语言', 'Appearance': '外观',
  'Dark': '深色', 'Light': '浅色', 'Follow system': '跟随系统',
})) labels.set(source, target)

const englishLabels = new Map()
for (const [english, chinese] of labels) if (!englishLabels.has(chinese)) englishLabels.set(chinese, english)
const dynamicLabels = [
  [/^(\d+)\s*个可见会话$/, m => `${m[1]} visible sessions`, /^(\d+) visible sessions$/, m => `${m[1]} 个可见会话`],
  [/^(\d+)\s*个子会话$/, m => `${m[1]} child sessions`, /^(\d+) child sessions$/, m => `${m[1]} 个子会话`],
  [/^(\d+)\s*会话$/, m => `${m[1]} sessions`, /^(\d+) sessions$/, m => `${m[1]} 会话`],
  [/^向 (Claude|Codex) 发送消息…$/, m => `Message ${m[1]}…`, /^Message (Claude|Codex)…$/, m => `向 ${m[1]} 发送消息…`],
  [/^(Claude|Codex) 命令$/, m => `${m[1]} commands`, /^(Claude|Codex) commands$/, m => `${m[1]} 命令`],
  [/^(Claude|Codex) · 模型未确认$/, m => `${m[1]} · Model unconfirmed`, /^(Claude|Codex) · Model unconfirmed$/, m => `${m[1]} · 模型未确认`],
  [/^(5 小时|每周) · (.+?)(?: · ([\d/: ]+) 重置（北京时间）)?$/, m => `${translateLabel(m[1])} · ${translateLabel(m[2])}${m[3] ? ` · ${m[3]} reset (Beijing time)` : ''}`,
    /^(5 hours|Weekly) · (.+?)(?: · ([\d/: ]+) reset \(Beijing time\))?$/, m => `${translateLabel(m[1])} · ${translateLabel(m[2])}${m[3] ? ` · ${m[3]} 重置（北京时间）` : ''}`],
  [/^(上次剩余|剩余)\s*([\d.]+)%$/, m => `${m[1] === '上次剩余' ? 'Last remaining' : 'Remaining'} ${m[2]}%`, /^(Last remaining|Remaining) ([\d.]+)%$/, m => `${m[1] === 'Last remaining' ? '上次剩余' : '剩余'} ${m[2]}%`],
  [/^(.+?) 重置$/, m => `${m[1]} reset`, /^(.+?) reset$/, m => `${m[1]} 重置`],
  [/^第 (\d+) \/ (\d+) 题$/, m => `Question ${m[1]} / ${m[2]}`, /^Question (\d+) \/ (\d+)$/, m => `第 ${m[1]} / ${m[2]} 题`],
  [/^((?:claude|gpt)-[\w.\[\]-]+) · (.+)；点击设置$/, m => `${m[1]} · ${translateLabel(m[2])}; click to configure`, /^((?:claude|gpt)-[\w.\[\]-]+) · (.+); click to configure$/, m => `${m[1]} · ${translateLabel(m[2])}；点击设置`],
  [/^完成通知，(\d+) 条未读$/, m => `Completion notifications, ${m[1]} unread`, /^Completion notifications, (\d+) unread$/, m => `完成通知，${m[1]} 条未读`],
  [/^(强度|本轮|最近请求)：(?:最低|低|中|高|很高|最大|极高) · (minimal|low|medium|high|xhigh|max|ultra)$/, m => `${({ 强度: 'Effort', 本轮: 'This turn', 最近请求: 'Last request' })[m[1]]}: ${m[2]}`,
    /^(Effort|This turn|Last request): (minimal|low|medium|high|xhigh|max|ultra)$/, m => `${({ Effort: '强度', 'This turn': '本轮', 'Last request': '最近请求' })[m[1]]}：${({ minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最大', ultra: '极高' })[m[2]]} · ${m[2]}`],
  [/^(最低|低|中|高|很高|最大|极高) · (minimal|low|medium|high|xhigh|max|ultra)$/, m => m[2], /^(minimal|low|medium|high|xhigh|max|ultra)$/, m => `${({ minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最大', ultra: '极高' })[m[1]]} · ${m[1]}`],
  [/^终端 · (已连接|连接中|未连接)$/, m => `ws · ${({ 已连接: 'live', 连接中: 'connecting', 未连接: 'disconnected' })[m[1]]}`, /^ws · (live|connected|connecting|disconnected)$/, m => `终端 · ${({ live: '已连接', connected: '已连接', connecting: '连接中', disconnected: '未连接' })[m[1]]}`],
]

function translateLabel(value) {
  const key = value.trim(), chinese = languageSignal.value === 'zh-CN'
  let translated = (chinese ? labels : englishLabels).get(key)
  if (!translated) for (const [zhPattern, toEnglish, enPattern, toChinese] of dynamicLabels) {
    const match = key.match(chinese ? enPattern : zhPattern)
    if (match) { translated = (chinese ? toChinese : toEnglish)(match); break }
  }
  return translated ? value.replace(key, translated) : value
}

function isPreserved(node) {
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
  return !element || Boolean(element.closest(preserved))
}

const originals = new WeakMap()
function translateTracked(node, key, value) {
  let entries = originals.get(node)
  if (!entries) { entries = new Map(); originals.set(node, entries) }
  const previous = entries.get(key)
  const source = previous?.rendered === value ? previous.source : value
  const rendered = translateLabel(source)
  entries.set(key, { source, rendered })
  return rendered
}

function translateText(node) {
  if (isPreserved(node)) return
  const translated = translateTracked(node, '#text', node.nodeValue)
  if (node.nodeValue !== translated) node.nodeValue = translated
}

function translateElement(element) {
  if (isPreserved(element) && (element.tagName !== 'TEXTAREA' || element.parentElement?.closest(preserved))) return
  for (const attribute of ['title', 'aria-label', 'placeholder']) {
    if (attribute === 'placeholder' && element.classList.contains('has-native-suggestion')) continue
    const value = element.getAttribute(attribute)
    if (value) {
      const translated = translateTracked(element, attribute, value)
      if (translated !== value) element.setAttribute(attribute, translated)
    }
  }
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) { translateText(root); return }
  if (root.nodeType !== Node.ELEMENT_NODE) return
  translateElement(root)
  if (isPreserved(root)) return
  for (const element of root.querySelectorAll('[title],[aria-label],[placeholder]')) translateElement(element)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) translateText(walker.currentNode)
}

effect(() => {
  const chinese = languageSignal.value === 'zh-CN'
  document.documentElement.lang = chinese ? 'zh-CN' : 'en'
  document.title = chinese ? 'Q-agent · 工作台' : 'Q-agent · Workspace'
  if (document.body) translateTree(document.body)
})
// Update the upstream offline cache policy, which predates the /desktop APIs.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    for (const registration of registrations) registration.update().catch(() => {})
  }).catch(() => {})
}
translateTree(document.body)
const pending = new Set()
let scheduled = false
new MutationObserver(records => {
  for (const record of records) {
    if (record.type === 'attributes') { pending.add(record.target); continue }
    if (isPreserved(record.target)) continue
    if (record.type === 'childList') {
      for (const node of record.addedNodes) if (!isPreserved(node)) pending.add(node)
    } else pending.add(record.target)
  }
  if (!pending.size || scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    for (const node of pending) if (node.isConnected) translateTree(node)
    pending.clear()
  })
}).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder'] })
