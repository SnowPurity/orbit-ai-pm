import { extractCitationChunkIds, renderRichText } from './citations.js';

const STATUSES = [
  ['todo', '待办'],
  ['doing', '进行中'],
  ['review', '待验收'],
  ['done', '完成'],
];
const STATUS_LABEL = Object.fromEntries(STATUSES);
const PRIORITY_LABEL = { low: '低', medium: '中', high: '高', urgent: '紧急' };
const TASK_KIND_LABEL = { task: '普通任务', milestone: '里程碑任务' };
const JOB_LABEL = { queued: '排队中', claimed: '执行中', done: '已完成', failed: '失败' };
const RUN_LABEL = { success: '成功', failed: '失败', running: '运行中', skipped: '跳过' };
const DEPENDENCY_LABEL = {
  finish_to_start: '完成才开始',
  finish_to_finish: '完成才完成',
  start_to_start: '开始才开始',
  start_to_finish: '开始才完成',
};
const KIND_LABEL = { human: '人类', agent: 'Agent', system: '系统' };
const HOOK_EVENTS = [
  'task.created',
  'task.updated',
  'task.status_changed',
  'task.assigned',
  'comment.created',
];
const EVENT_LABEL = {
  'task.created': '任务创建',
  'task.updated': '任务更新',
  'task.status_changed': '任务状态变更',
  'task.assigned': '任务分配',
  'comment.created': '评论创建',
  'group.created': '任务组创建',
  'group.updated': '任务组更新',
  'group.deleted': '任务组删除',
  'member.added': '成员加入',
  'member.removed': '成员移除',
  'member.updated': '成员角色更新',
  'project.updated': '项目更新',
};
const STORAGE_TOKEN = 'orbit.ui.token';
const STORAGE_PROJECT = 'orbit.ui.project';
const STORAGE_BOARD_MODE = 'orbit.ui.board.mode';

const root = document.getElementById('app');
const overlay = document.getElementById('overlay');
const drawer = document.getElementById('drawer');
const modal = document.getElementById('modal');
const toastEl = document.getElementById('toast');

const state = {
  token: '',
  actor: null,
  weknoraUiUrl: '',
  fileLimits: { maxUploadBytes: 50 * 1024 * 1024, taskFileLimit: 20 },
  upload: null,
  citationKnowledge: {},
  projects: [],
  projectKey: null,
  project: null,
  board: null,
  activity: [],
  automations: [],
  jobs: [],
  actors: [],
  notifications: [],
  notificationsUnread: 0,
  notificationsOpen: false,
  onlineActors: [],
  presenceOpen: false,
  commentDraft: null,
  lastEventId: 0,
  liveConnected: false,
  page: 'project',
  view: 'board',
  myTasks: null,
  myTasksScope: 'related',
  myTasksStatus: '',
  myTasksKind: '',
  myTasksQuery: '',
  boardMode: localStorage.getItem(STORAGE_BOARD_MODE) === 'focus' ? 'focus' : 'groups',
  boardHasFiles: false,
  focusGroupId: null,
  loading: false,
  error: null,
  openTaskRef: null,
  openTask: null,
  openTaskLoading: false,
  aiSuggestion: null,
  dependenciesOpen: false,
  descriptionEditing: false,
  descriptionDraft: null,
  taskParentPreset: null,
  modal: null,
  groupEdit: null,
  pendingAutomationDelete: null,
  pendingGroupDelete: null,
  pendingMemberRemove: null,
  pendingMemberPreselect: '',
  editingActor: null,
  actorMemberships: null,
  actorRoleProject: '',
  actorRoleDrafts: null,
  automationTasks: [],
  busy: false,
};

const UI_ROOT = '/ui';
const MY_TASKS_PATH = `${UI_ROOT}/me`;
const LIVE_KEY = 'global';
const VIEWS = new Set(['board', 'activity', 'automations', 'members']);
const VIEW_LABEL = { board: '看板', activity: '动态', automations: '自动化', members: '成员' };
let navigationSeq = 0;

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseRoute() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const queryTaskRef = new URLSearchParams(window.location.search).get('task');
  if (path === '/' || path === UI_ROOT) return { name: 'home' };
  if (path === MY_TASKS_PATH) return { name: 'me', taskRef: queryTaskRef };
  const segments = path.split('/').filter(Boolean).map(decodeSegment);
  if (segments[0] === UI_ROOT.slice(1) && segments[1] === 'tasks' && segments[2] && segments.length === 3) {
    return { name: 'task', taskRef: segments[2] };
  }
  if (segments[0] !== UI_ROOT.slice(1) || segments[1] !== 'projects' || !segments[2]) {
    return { name: 'notfound', path };
  }
  let cursor = 3;
  let view = 'board';
  let taskRef = null;
  if (VIEWS.has(segments[cursor])) {
    view = segments[cursor];
    cursor += 1;
  }
  if (segments[cursor] === 'tasks') {
    if (!segments[cursor + 1]) return { name: 'notfound', path };
    taskRef = segments[cursor + 1];
    cursor += 2;
  }
  if (cursor !== segments.length) return { name: 'notfound', path };
  return { name: 'project', projectKey: segments[2], view, taskRef: taskRef ?? queryTaskRef };
}

function projectPath(key, view = 'board') {
  return `${UI_ROOT}/projects/${encodeURIComponent(key)}/${view}`;
}

function taskPath(key, view, ref) {
  return `${projectPath(key, view)}/tasks/${encodeURIComponent(ref)}`;
}

function taskOnlyPath(ref) {
  return `${UI_ROOT}/tasks/${encodeURIComponent(ref)}`;
}

function withTaskQuery(path, ref) {
  return `${path}?task=${encodeURIComponent(ref)}`;
}

function taskLinkPath(ref) {
  const route = parseRoute();
  if (route.name === 'project') return taskPath(route.projectKey, route.view, ref);
  if (route.name === 'me') return withTaskQuery(MY_TASKS_PATH, ref);
  return taskOnlyPath(ref);
}

function currentViewPath(view = state.view) {
  return state.projectKey ? projectPath(state.projectKey, view) : UI_ROOT;
}

function preferredProjectKey() {
  const saved = localStorage.getItem(STORAGE_PROJECT);
  if (saved && state.projects.some((project) => project.key === saved)) return saved;
  return state.projects[0]?.key ?? null;
}

function focusGroupStorageKey(key) {
  return `orbit.ui.board.group.${key}`;
}

async function navigate(path, options = {}) {
  if (!path) return;
  const current = `${window.location.pathname}${window.location.search}`;
  if (path === current) {
    await syncRoute();
    return;
  }
  if (options.replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  await syncRoute();
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

class ApiError extends Error {
  constructor(message, code, status, details) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function api(method, path, body) {
  const headers = { authorization: `Bearer ${state.token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(error.message || `请求失败 (${response.status})`, error.code, response.status, error.details);
  }
  return payload?.data;
}

const LIVE_RETRY_MS = 3000;
const PRESENCE_POLL_MS = 15000;
let liveController = null;
let liveRetryTimer = null;
let liveKey = null;
let liveRenderTimer = null;
let liveRefreshTimer = null;
let liveNotificationsTimer = null;
let pendingDrawerRefresh = false;
let presenceTimer = null;
let presenceKey = null;
let presenceInFlight = false;
let presenceSignature = null;

function stopLiveStream() {
  if (liveController) liveController.abort();
  liveController = null;
  liveKey = null;
  clearTimeout(liveRetryTimer);
  clearTimeout(liveRenderTimer);
  clearTimeout(liveRefreshTimer);
  clearTimeout(liveNotificationsTimer);
  liveRetryTimer = null;
  liveRenderTimer = null;
  liveRefreshTimer = null;
  liveNotificationsTimer = null;
  pendingDrawerRefresh = false;
  state.liveConnected = false;
  syncLiveIndicator();
}

function startLiveStream() {
  if (!state.token) return;
  if (liveController && !liveController.signal.aborted && liveKey === LIVE_KEY) return;
  if (liveController) liveController.abort();
  clearTimeout(liveRetryTimer);
  liveRetryTimer = null;
  liveKey = LIVE_KEY;
  const controller = new AbortController();
  liveController = controller;
  void connectLiveStream(LIVE_KEY, controller);
}

async function connectLiveStream(key, controller) {
  if (controller.signal.aborted || liveKey !== key) return;
  try {
    const response = await fetch(
      `/api/v1/events/stream?after=${state.lastEventId}`,
      {
        headers: { authorization: `Bearer ${state.token}`, accept: 'text/event-stream' },
        signal: controller.signal,
        cache: 'no-store',
      },
    );
    if (response.status === 401) {
      logout();
      return;
    }
    if (!response.ok || !response.body) throw new Error(`实时连接失败 (${response.status})`);
    state.liveConnected = true;
    syncLiveIndicator();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleLiveBlock(block, key);
      }
    }
  } catch {
    // The retry path below owns reconnects.
  }
  if (controller.signal.aborted || liveKey !== key) return;
  state.liveConnected = false;
  syncLiveIndicator();
  clearTimeout(liveRetryTimer);
  liveRetryTimer = setTimeout(() => void connectLiveStream(key, controller), LIVE_RETRY_MS);
}

function handleLiveBlock(block, key) {
  if (!block || block.startsWith(':')) return;
  let type = 'message';
  let id = null;
  const data = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') type = value;
    else if (field === 'id') id = Number(value);
    else if (field === 'data') data.push(value);
  }
  if (type === 'ready') {
    if (Number.isFinite(id) && id > state.lastEventId) state.lastEventId = id;
    state.liveConnected = true;
    syncLiveIndicator();
    void loadPresence();
    return;
  }
  if (type !== 'domain' || data.length === 0) return;
  let event;
  try {
    event = JSON.parse(data.join('\n'));
  } catch {
    return;
  }
  if (!event || !Number.isFinite(event.id)) return;
  applyLiveEvent(event, key);
}

function applyLiveEvent(event, key) {
  if (liveKey !== key || event.id <= state.lastEventId) return;
  state.lastEventId = event.id;
  const sameProject = !state.project || !event.projectId || event.projectId === state.project.id;
  if (sameProject) state.activity = [event, ...state.activity].slice(0, 60);
  const type = String(event.type ?? '');
  const touchesDrawer = sameProject && state.openTaskRef && event.taskRef === state.openTaskRef;

  if (type.startsWith('comment.')) {
    maybeShowDesktopNotification(event);
    scheduleNotificationsRefresh();
    if (touchesDrawer) scheduleOpenTaskRefresh(event.taskRef);
    if (sameProject && state.view === 'activity') scheduleLiveRender();
    return;
  }
  if (state.page === 'me') {
    scheduleProjectRefresh();
    return;
  }
  if (state.page === 'task') {
    if (touchesDrawer) scheduleOpenTaskRefresh(event.taskRef);
    return;
  }
  if (!sameProject) return;
  if (touchesDrawer) scheduleOpenTaskRefresh(event.taskRef);
  scheduleProjectRefresh();
}

function scheduleProjectRefresh() {
  if (liveRefreshTimer) return;
  liveRefreshTimer = setTimeout(() => {
    liveRefreshTimer = null;
    if (state.actor) void refreshCurrent();
  }, 350);
}

async function refreshCurrent() {
  if (state.page === 'me') {
    await loadMyTasks({ silent: true });
    return;
  }
  if (state.page === 'task') {
    if (state.openTaskRef) await loadDetail(state.openTaskRef, { silent: true });
    return;
  }
  await refreshProject();
}

function scheduleLiveRender() {
  if (liveRenderTimer) return;
  liveRenderTimer = setTimeout(() => {
    liveRenderTimer = null;
    if (state.actor) render();
  }, 250);
}

function scheduleNotificationsRefresh() {
  if (liveNotificationsTimer) return;
  liveNotificationsTimer = setTimeout(() => {
    liveNotificationsTimer = null;
    void loadNotifications({ notify: true });
  }, 350);
}

function commentFieldFocused() {
  return document.activeElement?.matches?.('#comment-form textarea') ?? false;
}

function scheduleOpenTaskRefresh(ref) {
  if (!ref || state.openTaskRef !== ref) return;
  void (async () => {
    try {
      const detail = await api('GET', `/tasks/${encodeURIComponent(ref)}`);
      if (state.openTaskRef !== ref) return;
      state.openTask = detail;
      state.openTaskLoading = false;
      if (commentFieldFocused()) {
        pendingDrawerRefresh = true;
        return;
      }
      renderDrawer();
      void hydrateCitations(detail);
    } catch {
      // A transient refresh failure should not break the live stream.
    }
  })();
}

function applyPendingDrawerRefresh() {
  if (!pendingDrawerRefresh) return;
  pendingDrawerRefresh = false;
  renderDrawer();
}

function syncLiveIndicator() {
  const online = state.liveConnected;
  for (const element of document.querySelectorAll('[data-live-state]')) {
    element.className = `live-state ${online ? 'online' : 'offline'}`;
    element.title = online ? '事件实时推送中' : '正在重新连接实时事件流';
    element.innerHTML = `<i></i>${online ? '实时' : '重连中'}`;
  }
}

function liveIndicatorHtml() {
  return `<span class="live-state ${state.liveConnected ? 'online' : 'offline'}" data-live-state title="${state.liveConnected ? '事件实时推送中' : '正在重新连接实时事件流'}"><i></i>${state.liveConnected ? '实时' : '重连中'}</span>`;
}

function presenceSignatureOf() {
  const ids = state.onlineActors.map((actor) => actor.id).join(',');
  return `${state.presenceOpen ? 'open' : 'closed'}:${ids}`;
}

function presenceWrapHtml() {
  return `<div class="presence-wrap" data-presence-wrap>
    <button type="button" class="presence-chip" data-action="toggle-presence" aria-expanded="${state.presenceOpen}" title="查看当前在线用户">
      <i class="presence-dot"></i><span>${state.onlineActors.length} 在线</span>
    </button>
    ${state.presenceOpen ? presencePanelHtml() : ''}
  </div>`;
}

function presencePanelHtml() {
  const selfId = state.actor?.id;
  return `<div class="presence-panel" role="dialog" aria-label="在线用户">
    <div class="presence-panel-head"><strong>当前在线</strong><span class="count">${state.onlineActors.length} 人</span></div>
    ${state.onlineActors.length
      ? `<ul class="presence-list">${state.onlineActors.map((actor) => `<li class="presence-item">
          ${avatar(actor)}
          <span class="presence-name">${esc(actor.name)}${actor.id === selfId ? '<em>你</em>' : ''}</span>
          <span class="presence-kind">${esc(KIND_LABEL[actor.kind] ?? actor.kind)}</span>
        </li>`).join('')}</ul>`
      : '<p class="empty small">当前没有在线成员</p>'}
    <p class="presence-hint">在线状态由实时事件连接维护，页面关闭后会自动离线。</p>
  </div>`;
}

function syncPresenceUi() {
  const signature = presenceSignatureOf();
  if (signature === presenceSignature) return;
  presenceSignature = signature;
  const wrap = document.querySelector('[data-presence-wrap]');
  if (wrap) wrap.outerHTML = presenceWrapHtml();
  for (const element of document.querySelectorAll('[data-member-online]')) {
    const online = state.onlineActors.some((actor) => actor.id === element.dataset.memberOnline);
    element.classList.toggle('online', online);
    element.innerHTML = online ? '<i></i>在线' : '';
  }
}

async function loadPresence() {
  if (!state.token || !state.projectKey || presenceInFlight) return;
  presenceInFlight = true;
  const key = state.projectKey;
  try {
    const result = await api('GET', `/presence?project=${encodeURIComponent(key)}`);
    if (state.projectKey !== key) return;
    state.onlineActors = Array.isArray(result?.actors) ? result.actors : [];
    syncPresenceUi();
  } catch (error) {
    if (error.status === 401) logout();
  } finally {
    presenceInFlight = false;
  }
}

function startPresencePolling() {
  if (!state.token || !state.projectKey) return;
  if (presenceTimer && presenceKey === state.projectKey) return;
  stopPresencePolling();
  presenceKey = state.projectKey;
  presenceSignature = null;
  void loadPresence();
  presenceTimer = setInterval(() => void loadPresence(), PRESENCE_POLL_MS);
}

function stopPresencePolling() {
  clearInterval(presenceTimer);
  presenceTimer = null;
  presenceKey = null;
  presenceInFlight = false;
  presenceSignature = null;
  state.onlineActors = [];
  state.presenceOpen = false;
}

async function loadNotifications(options = {}) {
  if (!state.projectKey) return;
  const key = state.projectKey;
  const previousUnread = state.notificationsUnread;
  try {
    const result = await api('GET', '/notifications?limit=50');
    if (state.projectKey !== key) return;
    state.notifications = result?.items ?? [];
    state.notificationsUnread = Number(result?.unread ?? 0);
    syncNotificationBell();
    if (options.notify && state.notificationsUnread > previousUnread) {
      toast('你有一条新的 @提及');
    }
  } catch (error) {
    if (error.status === 401) logout();
  }
}

function notificationBadgeHtml() {
  if (state.notificationsUnread <= 0) return '';
  const label = state.notificationsUnread > 9 ? '9+' : String(state.notificationsUnread);
  return `<span class="notify-badge">${label}</span>`;
}

function syncNotificationBell() {
  const bell = document.querySelector('[data-notification-bell]');
  if (bell) {
    bell.classList.toggle('has-unread', state.notificationsUnread > 0);
    bell.setAttribute(
      'aria-label',
      state.notificationsUnread > 0 ? `通知，${state.notificationsUnread} 条未读` : '通知',
    );
    bell.innerHTML = `${BELL_ICON}${notificationBadgeHtml()}`;
  }
  const panel = document.querySelector('.notify-panel');
  if (panel) panel.outerHTML = notificationsPanelHtml();
}

const BELL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`;

function notificationsPanelHtml() {
  const items = state.notifications;
  return `<div class="notify-panel" role="dialog" aria-label="通知">
    <div class="notify-panel-head">
      <strong>通知</strong>
      <span class="count">${state.notificationsUnread} 未读</span>
      <button type="button" class="link-button" data-action="notifications-read-all" ${state.notificationsUnread > 0 ? '' : 'disabled'}>全部已读</button>
    </div>
    ${browserNotifyRowHtml()}
    ${items.length
      ? `<ul class="notify-list">${items.map(notificationItemHtml).join('')}</ul>`
      : '<p class="empty small">暂无通知</p>'}
  </div>`;
}

function browserNotifyRowHtml() {
  if (typeof Notification === 'undefined') {
    return '<p class="notify-permission muted">当前浏览器不支持桌面通知</p>';
  }
  if (Notification.permission === 'granted') {
    return '<p class="notify-permission granted"><i></i>桌面通知已开启，@提及会在系统通知中提醒</p>';
  }
  if (Notification.permission === 'denied') {
    return '<p class="notify-permission muted">桌面通知已被浏览器阻止，请在站点权限中允许</p>';
  }
  return '<button type="button" class="notify-permission-cta" data-action="enable-browser-notifications">开启桌面通知 · 及时收到 @提及</button>';
}

async function enableBrowserNotifications() {
  if (typeof Notification === 'undefined') {
    toast('当前浏览器不支持桌面通知', 'error');
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      toast('桌面通知已开启');
      new Notification('Orbit 桌面通知已开启', { body: '有人 @提及时会在这里提醒你。' });
    } else {
      toast('未获得桌面通知权限', 'error');
    }
  } catch {
    toast('无法开启桌面通知', 'error');
  }
  syncNotificationBell();
}

function maybeShowDesktopNotification(event) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const mentions = Array.isArray(event.payload?.mentions) ? event.payload.mentions : [];
  const selfName = state.actor?.name;
  if (!selfName || !mentions.some((name) => String(name).toLowerCase() === selfName.toLowerCase())) return;
  if (event.actor?.id && event.actor.id === state.actor?.id) return;
  const ref = String(event.taskRef ?? '');
  const projectKey = String(event.projectKey ?? state.projectKey ?? '');
  if (!ref || !projectKey) return;
  const commentId = String(event.payload?.commentId ?? '');
  const author = String(event.actor?.name ?? '有人');
  try {
    const note = new Notification(`${author} 在 ${ref} 中提及了你`, {
      body: String(event.payload?.excerpt ?? '').slice(0, 160),
      tag: commentId ? `orbit-mention-${commentId}` : `orbit-mention-${event.id}`,
    });
    note.onclick = () => {
      window.focus();
      note.close();
      const item = state.notifications.find((entry) => entry.commentId === commentId);
      if (item && !item.readAt) void markNotificationsRead({ ids: [item.id] });
      void openTaskFromNotification(ref, projectKey);
    };
  } catch {
    // Desktop notifications are best-effort and must not interrupt live updates.
  }
}

function notificationItemHtml(item) {
  return `<li>
    <button type="button" class="notify-item ${item.readAt ? 'read' : 'unread'}" data-action="open-notification" data-id="${esc(item.id)}" data-ref="${esc(item.taskRef ?? '')}">
      <span class="notify-mark"></span>
      <span class="notify-copy">
        <span class="notify-line">${avatar(item.author, 'xs')}<strong>${esc(item.author.name)}</strong> 在 <b>${esc(item.taskRef ?? '任务')}</b> 中提及了你</span>
        <span class="notify-excerpt">${esc(item.excerpt)}</span>
        <time datetime="${esc(item.createdAt)}" title="${esc(fullDate(item.createdAt))}">${timeAgo(item.createdAt)}</time>
      </span>
    </button>
  </li>`;
}

async function markNotificationsRead(payload) {
  try {
    const result = await api('POST', '/notifications/read', payload);
    state.notificationsUnread = Number(result?.unread ?? 0);
    const readAt = new Date().toISOString();
    const ids = payload.ids ? new Set(payload.ids) : null;
    for (const item of state.notifications) {
      if (!ids || ids.has(item.id)) item.readAt = item.readAt ?? readAt;
    }
    syncNotificationBell();
  } catch (error) {
    if (error.status === 401) logout();
    else toast(friendlyError(error), 'error');
  }
}

async function openTaskFromNotification(ref, projectKey) {
  if (!ref) return;
  if (state.page === 'project' && projectKey) {
    await navigate(taskPath(projectKey, state.view, ref));
    return;
  }
  if (state.page === 'me') {
    await navigate(withTaskQuery(MY_TASKS_PATH, ref));
    return;
  }
  await navigate(taskOnlyPath(ref));
}

async function openNotification(id, ref) {
  state.notificationsOpen = false;
  const item = state.notifications.find((entry) => entry.id === id);
  if (item && !item.readAt) await markNotificationsRead({ ids: [item.id] });
  if (ref) await openTaskFromNotification(ref, item?.projectKey ?? state.projectKey);
  else render();
}

function insertMention(name) {
  if (!name) return;
  const textarea = document.querySelector('#comment-form textarea');
  if (!textarea) return;
  const token = `@${name} `;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  textarea.value = `${textarea.value.slice(0, start)}${token}${textarea.value.slice(end)}`;
  textarea.focus();
  const caret = start + token.length;
  textarea.setSelectionRange(caret, caret);
  state.commentDraft = {
    ref: textarea.closest('form')?.dataset.ref ?? '',
    body: textarea.value,
  };
  syncMentionTokens(textarea);
  closeMentionPicker();
}

const relativeFormatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

function timeAgo(iso) {
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return '';
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relativeFormatter.format(seconds, 'second');
  if (abs < 3600) return relativeFormatter.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relativeFormatter.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 30) return relativeFormatter.format(Math.round(seconds / 86400), 'day');
  return dateFormatter.format(new Date(timestamp));
}

function fullDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date);
}

function toDateTimeLocal(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function avatar(actor, size = '') {
  if (!actor) return '';
  const initial = (actor.name || '?').trim().slice(0, 1).toUpperCase();
  const kind = actor.kind || 'human';
  return `<span class="avatar ${esc(kind)} ${size}" title="${esc(actor.name)} · ${KIND_LABEL[kind] ?? kind}">${esc(initial)}</span>`;
}

function roleTagFor(actorId) {
  return (state.project?.members ?? []).find((member) => member.actor.id === actorId)?.roleTag ?? '';
}

function priorityTag(priority) {
  const label = PRIORITY_LABEL[priority] ?? priority;
  return `<span class="priority ${esc(priority)}"><i></i>${esc(label)}</span>`;
}

function taskOverdue(task) {
  return task.status !== 'done' && Boolean(task.dueAt) && new Date(task.dueAt).getTime() < Date.now();
}

function memberName(id) {
  if (!id) return null;
  return state.project?.members?.find((member) => member.actor.id === id)?.actor.name ?? null;
}

async function init() {
  state.token = localStorage.getItem(STORAGE_TOKEN) ?? '';
  if (!state.token) {
    renderConnect();
    return;
  }
  renderSplash();
  try {
    state.actor = await api('GET', '/me');
    await loadWorkspace();
  } catch (error) {
    if (error.status === 401) {
      state.token = '';
      localStorage.removeItem(STORAGE_TOKEN);
      renderConnect('Token 无效或已过期，请重新连接。');
      return;
    }
    renderFatal(error.message);
  }
}

function renderSplash() {
  document.title = '正在连接 · Orbit';
  root.innerHTML = `<div class="splash"><span class="brand-mark">O</span><span>正在连接 Orbit…</span></div>`;
}

function renderConnect(message = '') {
  document.title = '连接 Orbit';
  root.innerHTML = `<div class="connect-screen">
    <form id="connect-form" class="connect-card">
      <span class="brand-mark large">O</span>
      <h1>连接 Orbit</h1>
      <p class="connect-sub">使用项目 Token 连接，直接复用现有 REST API 与权限模型。</p>
      ${message ? `<p class="form-error">${esc(message)}</p>` : ''}
      <label class="field"><span>访问 Token</span><input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴 humanToken" required></label>
      <button type="submit" class="primary wide">连接</button>
      <p class="hint">Token 位于项目根目录 <code>.orbitrc.json</code> 的 <code>humanToken</code> 字段，仅保存在本机浏览器。</p>
    </form>
  </div>`;
  setTimeout(() => document.querySelector('#connect-form input[name="token"]')?.focus(), 0);
}

function renderFatal(message) {
  document.title = '加载失败 · Orbit';
  root.innerHTML = `<div class="center-screen">
    <div class="state-card">
      <h1>无法加载 Orbit</h1>
      <p>${esc(message || '未知错误')}</p>
      <button type="button" class="primary" data-action="retry-boot">重试</button>
    </div>
  </div>`;
}

async function loadWorkspace() {
  const [runtime, projects] = await Promise.all([
    api('GET', '/runtime').catch(() => null),
    api('GET', '/projects'),
  ]);
  state.weknoraUiUrl = runtime?.weknora?.uiUrl ?? '';
  if (runtime?.files) state.fileLimits = runtime.files;
  state.projects = projects;
  await syncRoute();
}

async function loadProject(key, options = {}) {
  const streamChanged = liveKey !== LIVE_KEY;
  if (streamChanged) stopLiveStream();
  state.projectKey = key;
  localStorage.setItem(STORAGE_PROJECT, key);
  if (!options.silent) {
    state.loading = true;
    state.error = null;
    render();
  }
  try {
    const base = `/projects/${encodeURIComponent(key)}`;
    const [project, board, activity, automations, jobs, actors, notifications] = await Promise.all([
      api('GET', base),
      api('GET', `${base}/board`),
      api('GET', `${base}/activity?limit=30`),
      api('GET', `${base}/automations`),
      api('GET', `${base}/jobs`),
      api('GET', '/actors'),
      api('GET', '/notifications?limit=50').catch(() => ({
        items: [],
        unread: 0,
      })),
    ]);
    if (state.projectKey !== key) return;
    state.project = project;
    state.board = board;
    state.activity = activity;
    state.automations = automations;
    state.jobs = jobs;
    state.actors = actors;
    state.notifications = notifications?.items ?? [];
    state.notificationsUnread = Number(notifications?.unread ?? 0);
    const activityMax = activity.reduce((max, event) => Math.max(max, event.id), 0);
    if (activityMax > state.lastEventId) state.lastEventId = activityMax;
    state.error = null;
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    if (state.projectKey !== key) return;
    state.error = error.message;
  } finally {
    state.loading = false;
    if (state.actor && state.projectKey === key) {
      render();
      if (state.project) {
        startLiveStream();
        startPresencePolling();
      }
    }
  }
}

async function refreshProject() {
  if (!state.projectKey) return;
  await loadProject(state.projectKey, { silent: true });
}

async function loadMyTasks(options = {}) {
  if (!options.silent) {
    state.loading = true;
    state.error = null;
    render();
  }
  try {
    const params = new URLSearchParams({ scope: state.myTasksScope, limit: '100' });
    if (state.myTasksStatus === 'overdue') params.set('overdue', 'true');
    else if (state.myTasksStatus) params.set('status', state.myTasksStatus);
    if (state.myTasksKind) params.set('kind', state.myTasksKind);
    const query = state.myTasksQuery.trim();
    if (query) params.set('q', query);
    const byId = new Map();
    let first = null;
    let offset = 0;
    for (;;) {
      params.set('offset', String(offset));
      const page = await api('GET', `/me/tasks?${params.toString()}`);
      if (state.page !== 'me') return;
      first = first ?? page;
      for (const task of page.items ?? []) byId.set(task.id, task);
      offset += page.items?.length ?? 0;
      if (!page.hasMore || offset === 0) break;
    }
    state.myTasks = { ...first, items: [...byId.values()], hasMore: false };
    state.error = null;
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    if (state.page !== 'me') return;
    state.error = error.message;
  } finally {
    if (state.page === 'me' && state.actor) {
      state.loading = false;
      const active = document.activeElement;
      const keepFilterFocus = active?.id === 'my-task-filter';
      const cursor = keepFilterFocus ? active.selectionStart : null;
      render();
      if (keepFilterFocus) {
        const input = document.getElementById('my-task-filter');
        if (input) {
          input.focus();
          const position = Math.min(cursor ?? input.value.length, input.value.length);
          input.setSelectionRange(position, position);
        }
      }
      startLiveStream();
    }
  }
}

function setMyTasksScope(scope) {
  if (!['related', 'assigned', 'created'].includes(scope) || scope === state.myTasksScope) return;
  state.myTasksScope = scope;
  render();
  void loadMyTasks({ silent: true });
}

function setMyTasksStatus(status) {
  const allowed = ['', ...STATUSES.map(([id]) => id), 'overdue'];
  if (!allowed.includes(status) || status === state.myTasksStatus) return;
  state.myTasksStatus = status;
  render();
  void loadMyTasks({ silent: true });
}

function setMyTasksKind(kind) {
  if (!['', ...Object.keys(TASK_KIND_LABEL)].includes(kind) || kind === state.myTasksKind) return;
  state.myTasksKind = kind;
  render();
  void loadMyTasks({ silent: true });
}

let myTasksQueryTimer = 0;

function setMyTasksQuery(query) {
  if (query === state.myTasksQuery) return;
  state.myTasksQuery = query;
  clearTimeout(myTasksQueryTimer);
  myTasksQueryTimer = setTimeout(() => {
    if (state.page === 'me') void loadMyTasks({ silent: true });
  }, 300);
}

function myTaskRow(task) {
  const assigned = (task.assignees ?? []).some((assignedActor) => assignedActor.id === state.actor.id);
  const created = task.createdBy?.id === state.actor.id;
  const assignees = (task.assignees ?? []).map((assignedActor) => assignedActor.name).join('、');
  const overdue = taskOverdue(task);
  return `<a class="my-task-row" href="${esc(withTaskQuery(MY_TASKS_PATH, task.ref))}" data-link>
    <span class="my-task-main">
      <span class="my-task-line">
        <span class="ref">${esc(task.ref)}</span>
        ${task.kind === 'milestone' ? '<span class="task-kind milestone">里程碑</span>' : ''}
        <span class="my-task-title">${esc(task.title)}</span>
      </span>
      <span class="my-task-meta">
        <span class="my-status ${esc(task.status)}"><span class="status-dot ${esc(task.status)}"></span>${esc(STATUS_LABEL[task.status] ?? task.status)}</span>
        ${priorityTag(task.priority)}
        ${task.groupName ? `<span class="my-meta-chip">${esc(task.groupName)}</span>` : ''}
        ${task.parentRef ? `<span class="my-meta-chip">子任务 · 上级 ${esc(task.parentRef)}</span>` : ''}
        ${task.dueAt ? `<span class="my-due${overdue ? ' overdue' : ''}">${overdue ? '逾期 · ' : '截止 · '}${esc(fullDate(task.dueAt))}</span>` : ''}
        ${assignees ? `<span class="my-assignees">${esc(assignees)}</span>` : ''}
      </span>
    </span>
    <span class="my-relations">
      ${assigned ? '<span class="my-relation assigned">指派给我</span>' : ''}
      ${created ? '<span class="my-relation created">我创建</span>' : ''}
    </span>
  </a>`;
}

function myTasksHtml() {
  const result = state.myTasks;
  const stats = result?.stats ?? { total: 0, todo: 0, doing: 0, review: 0, done: 0, overdue: 0 };
  const tasks = result?.items ?? [];
  const byProject = new Map();
  for (const task of tasks) {
    if (!byProject.has(task.projectKey)) byProject.set(task.projectKey, []);
    byProject.get(task.projectKey).push(task);
  }
  const groups = state.projects
    .filter((project) => byProject.has(project.key))
    .map((project) => ({ project, tasks: byProject.get(project.key) }));
  const scopes = [
    ['related', '全部相关'],
    ['assigned', '指派给我'],
    ['created', '我创建的'],
  ];
  const statusOptions = [['', '全部状态'], ...STATUSES, ['overdue', '逾期']];
  const kindOptions = [['', '全部类型'], ...Object.entries(TASK_KIND_LABEL)];
  const statCards = [
    ['total', '全部', stats.total, ''],
    ['doing', '进行中', stats.doing, 'doing'],
    ['review', '待验收', stats.review, 'review'],
    ['todo', '待办', stats.todo, 'todo'],
    ['done', '完成', stats.done, 'done'],
    ['overdue', '逾期', stats.overdue, 'overdue'],
  ];
  return `<section class="view my-tasks-view">
    <div class="view-head">
      <div>
        <div class="view-title"><h1>我的任务</h1></div>
        <p class="view-sub">汇总你在 ${state.projects.length} 个参与项目中${state.myTasksScope === 'assigned' ? '指派给我' : state.myTasksScope === 'created' ? '我创建' : '相关（指派或创建）'}的任务。点击任务会在侧栏打开，不会离开当前页面。</p>
      </div>
      <div class="view-actions"><button type="button" class="ghost" data-action="refresh">刷新</button></div>
    </div>
    <div class="my-stats">${statCards.map(([id, label, value, status]) => `<button type="button" class="my-stat ${id}${state.myTasksStatus === status ? ' active' : ''}" data-action="my-stat" data-status="${status}" aria-pressed="${state.myTasksStatus === status}" title="筛选${label}任务">
      <span class="my-stat-value">${Number(value) || 0}</span>
      <span class="my-stat-label">${label}</span>
    </button>`).join('')}</div>
    <div class="my-toolbar">
      <div class="my-scope" role="group" aria-label="任务范围">${scopes.map(([id, label]) => `<button type="button" class="${state.myTasksScope === id ? 'active' : ''}" aria-pressed="${state.myTasksScope === id}" data-action="my-scope" data-scope="${id}">${label}</button>`).join('')}</div>
      <div class="my-filters">
        <label class="my-filter"><span>状态</span><select id="my-status-filter">${statusOptions.map(([id, label]) => `<option value="${id}" ${state.myTasksStatus === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="my-filter"><span>类型</span><select id="my-kind-filter">${kindOptions.map(([id, label]) => `<option value="${id}" ${state.myTasksKind === id ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="my-filter my-filter-search"><span>任务</span><input id="my-task-filter" type="search" placeholder="标题或描述" value="${esc(state.myTasksQuery)}" autocomplete="off" aria-label="按任务标题或描述筛选"></label>
      </div>
    </div>
    ${tasks.length ? `<div class="my-task-groups">${groups.map(({ project, tasks: projectTasks }) => `<section class="my-project-group">
      <header class="my-project-head">
        <span class="my-project-key" style="--project-color:${esc(project.color ?? '#5B8DEF')}">${esc(project.key)}</span>
        <span class="my-project-name">${esc(project.name)}</span>
        <span class="count">${projectTasks.length}</span>
      </header>
      <div class="my-task-list">${projectTasks.map(myTaskRow).join('')}</div>
    </section>`).join('')}</div>` : `<div class="my-empty">
      <h3>暂无相关任务</h3>
      <p>${state.projects.length ? '当前筛选下没有任务；可以切换范围、状态或类型，也可以到项目中把任务指派给自己。' : '你还没有加入任何项目。'}</p>
    </div>`}
  </section>`;
}

async function syncRoute() {
  if (!state.actor) {
    renderConnect();
    return;
  }
  const seq = ++navigationSeq;
  const route = parseRoute();

  if (route.name === 'notfound') {
    closeModal();
    closeDrawer();
    state.loading = false;
    renderRouteNotFound();
    return;
  }

  if (route.name === 'home') {
    const key = preferredProjectKey();
    if (!key) {
      state.projectKey = null;
      state.project = null;
      state.loading = false;
      render();
      return;
    }
    await navigate(projectPath(key, 'board'), { replace: true });
    return;
  }

  if (route.name === 'task') {
    closeModal();
    state.page = 'task';
    state.view = 'board';
    state.loading = true;
    state.error = null;
    state.openTaskRef = route.taskRef;
    state.openTask = null;
    state.openTaskLoading = true;
    state.aiSuggestion = null;
    state.dependenciesOpen = false;
    state.descriptionEditing = false;
    state.descriptionDraft = null;
    render();
    renderDrawer();
    syncLayers();
    try {
      const detail = await api('GET', `/tasks/${encodeURIComponent(route.taskRef)}`);
      if (seq !== navigationSeq || !state.actor || state.openTaskRef !== route.taskRef) return;
      const project = state.projects.find((entry) => entry.key === detail.projectKey);
      if (!project) {
        closeDrawer();
        state.loading = false;
        state.error = '该任务所属项目不存在或无权访问';
        render();
        return;
      }
      if (state.projectKey !== detail.projectKey || !state.project) {
        await loadProject(detail.projectKey);
        if (seq !== navigationSeq || !state.actor || state.openTaskRef !== route.taskRef) return;
      }
      if (state.error || state.projectKey !== detail.projectKey) {
        closeDrawer();
        state.loading = false;
        render();
        return;
      }
      state.openTask = detail;
      state.openTaskLoading = false;
      state.loading = false;
      render();
      renderDrawer();
      syncLayers();
      void hydrateCitations(detail);
    } catch (error) {
      if (seq !== navigationSeq || !state.actor) return;
      if (error.status === 401) {
        logout();
        return;
      }
      closeDrawer();
      state.loading = false;
      state.error = friendlyError(error);
      render();
    }
    return;
  }

  if (route.name === 'me') {
    closeModal();
    if (!route.taskRef) closeDrawer();
    state.page = 'me';
    await loadMyTasks();
    if (seq !== navigationSeq || !state.actor) return;
    if (!state.error) await syncDrawerRoute(route.taskRef);
    if (seq !== navigationSeq || !state.actor) return;
    render();
    renderDrawer();
    syncLayers();
    return;
  }

  if (!state.projects.some((project) => project.key === route.projectKey)) {
    const key = preferredProjectKey();
    if (!key) {
      state.projectKey = null;
      state.project = null;
      state.loading = false;
      render();
      return;
    }
    toast(`项目「${route.projectKey}」不存在或无权访问`, 'error');
    await navigate(projectPath(key, 'board'), { replace: true });
    return;
  }

  closeModal();
  localStorage.setItem(STORAGE_PROJECT, route.projectKey);
  const projectChanged = state.projectKey !== route.projectKey || !state.project;
  state.page = 'project';
  state.projectKey = route.projectKey;
  state.view = route.view;

  if (projectChanged) {
    state.boardHasFiles = false;
    state.project = null;
    state.board = null;
    state.activity = [];
    state.automations = [];
    state.jobs = [];
    state.actors = [];
    state.notifications = [];
    state.notificationsUnread = 0;
    state.notificationsOpen = false;
    state.commentDraft = null;
    state.openTaskRef = null;
    state.openTask = null;
    state.openTaskLoading = false;
    state.aiSuggestion = null;
    state.dependenciesOpen = false;
    state.automationTasks = [];
    state.focusGroupId = localStorage.getItem(focusGroupStorageKey(route.projectKey));
    await loadProject(route.projectKey);
    if (seq !== navigationSeq || !state.actor) return;
  }

  if (!state.error) await syncDrawerRoute(route.taskRef);
  if (seq !== navigationSeq || !state.actor) return;
  render();
  renderDrawer();
  syncLayers();
}

async function syncDrawerRoute(ref) {
  if (!ref) {
    if (state.openTaskRef) closeDrawer();
    return;
  }
  if (state.openTaskRef === ref && (state.openTask || state.openTaskLoading)) return;
  state.openTaskRef = ref;
  state.openTask = null;
  state.openTaskLoading = true;
  state.aiSuggestion = null;
  state.dependenciesOpen = false;
  state.descriptionEditing = false;
  state.descriptionDraft = null;
  renderDrawer();
  syncLayers();
  await loadDetail(ref, { silent: true });
}

function renderRouteNotFound() {
  document.title = '页面不存在 · Orbit';
  root.innerHTML = `<div class="center-screen">
    <div class="state-card">
      <h1>页面不存在</h1>
      <p>这个地址没有对应的项目视图。</p>
      <button type="button" class="primary" data-action="home">返回看板</button>
    </div>
  </div>`;
}

function updateTitle() {
  if (state.openTaskRef) {
    const title = state.openTask ? `${state.openTask.ref} · ${state.openTask.title}` : state.openTaskRef;
    document.title = `${title} · Orbit`;
    return;
  }
  if (state.page === 'me') {
    document.title = '我的任务 · Orbit';
    return;
  }
  if (state.project) {
    document.title = `${state.project.name} · ${VIEW_LABEL[state.view] ?? '看板'} · Orbit`;
    return;
  }
  document.title = 'Orbit · 项目管理';
}

function render() {
  if (!state.actor) {
    renderConnect();
    return;
  }
  root.innerHTML = shellHtml();
  updateTitle();
}

function tab(view, label) {
  const active = state.view === view;
  return `<a class="tab ${active ? 'active' : ''}" href="${esc(currentViewPath(view))}" data-link${active ? ' aria-current="page"' : ''}>${label}</a>`;
}

function myTasksTab() {
  const active = state.page === 'me';
  return `<a class="tab ${active ? 'active' : ''}" href="${MY_TASKS_PATH}" data-link${active ? ' aria-current="page"' : ''}>我的任务</a>`;
}

function shellHtml() {
  const projectOptions = state.projects
    .map((project) => `<option value="${esc(project.key)}" ${project.key === state.projectKey ? 'selected' : ''}>${esc(project.key)} · ${esc(project.name)}</option>`)
    .join('');
  return `<header class="topbar">
    <a class="brand" href="${esc(state.projectKey ? projectPath(state.projectKey, 'board') : UI_ROOT)}" data-link aria-label="返回看板">
      <span class="brand-mark">O</span>
      <span class="brand-name">Orbit</span>
      <span class="brand-tag">AI-native</span>
    </a>
    <div class="topbar-mid">
      <button type="button" class="primary small new-project" data-action="new-project" title="新建项目">+ 新建项目</button>
      <select id="project-select" class="project-select" aria-label="选择项目">${projectOptions}</select>
      <nav class="tabs" aria-label="视图">${tab('board', '看板')}${tab('activity', '动态')}${tab('automations', '自动化')}${tab('members', '成员')}${myTasksTab()}</nav>
    </div>
    <div class="topbar-actions">
      ${liveIndicatorHtml()}
      ${presenceWrapHtml()}
      <div class="notify-wrap">
        <button type="button" class="icon-button notify-bell ${state.notificationsUnread > 0 ? 'has-unread' : ''}" data-action="toggle-notifications" data-notification-bell aria-label="${state.notificationsUnread > 0 ? `通知，${state.notificationsUnread} 条未读` : '通知'}" aria-expanded="${state.notificationsOpen}">
          ${BELL_ICON}${notificationBadgeHtml()}
        </button>
        ${state.notificationsOpen ? notificationsPanelHtml() : ''}
      </div>
      <button type="button" class="icon-button" data-action="refresh" title="刷新" aria-label="刷新">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg>
      </button>
      <span class="actor-chip">${avatar(state.actor)}<span>${esc(state.actor.name)}</span></span>
      <button type="button" class="link-button" data-action="logout">切换 Token</button>
    </div>
  </header>
  <main class="workspace">${contentHtml()}</main>`;
}

function contentHtml() {
  if (state.page === 'task') return taskOnlyHtml();
  if (state.page === 'me') {
    if (state.error) {
      return `<div class="center-screen">
        <div class="state-card"><h1>加载失败</h1><p>${esc(state.error)}</p><button type="button" class="primary" data-action="refresh">重试</button></div>
      </div>`;
    }
    if (state.loading && !state.myTasks) {
      return `<div class="center-screen"><div class="state-card"><h1>正在汇总我的任务</h1><p>正在读取所有参与项目的任务…</p></div></div>`;
    }
    return myTasksHtml();
  }
  if (state.loading) return loadingHtml();
  if (state.error) {
    return `<div class="center-screen">
      <div class="state-card"><h1>加载失败</h1><p>${esc(state.error)}</p><button type="button" class="primary" data-action="refresh">重试</button></div>
    </div>`;
  }
  if (!state.project) {
    return `<div class="center-screen"><div class="state-card"><h1>没有可访问的项目</h1><p>请检查 Token 的项目成员关系。</p></div></div>`;
  }
  if (state.view === 'activity') return activityHtml();
  if (state.view === 'automations') return automationsHtml();
  if (state.view === 'members') return membersHtml();
  return boardHtml();
}

function taskOnlyHtml() {
  if (state.error) {
    return `<div class="center-screen">
      <div class="state-card"><h1>无法打开任务</h1><p>${esc(state.error)}</p><button type="button" class="primary" data-action="home">返回看板</button></div>
    </div>`;
  }
  const task = state.openTask;
  if (!task) return loadingHtml();
  const project = state.project?.key === task.projectKey ? state.project : null;
  return `<section class="view task-only-view">
    <div class="view-head">
      <div>
        <div class="view-title">
          ${project ? `<span class="project-mark" style="background:${esc(project.color || '#18181b')}"></span>` : ''}
          <h1>${esc(task.ref)}</h1>
          <span class="project-key">${esc(project?.key ?? task.projectKey)}</span>
        </div>
        <p class="view-sub">${project ? `${esc(project.name)} · ` : ''}任务详情已在右侧侧栏打开，不依赖项目页面。</p>
      </div>
      <div class="view-actions">${project ? `<a class="ghost" href="${esc(projectPath(project.key, 'board'))}" data-link>打开项目看板</a>` : ''}</div>
    </div>
    <div class="state-card task-only-card">
      <span class="ref">${esc(task.ref)}</span>
      <h1>任务侧栏已打开</h1>
      <p>${esc(task.title)}</p>
      <p class="hint">关闭侧栏后会返回项目看板。</p>
    </div>
  </section>`;
}

function loadingHtml() {
  const column = `<section class="column">
    <div class="column-head"><span class="skeleton" style="width:60px;height:10px"></span></div>
    <div class="column-body">${Array.from({ length: 3 }, () => `<div class="skeleton-card">
      <div class="skeleton skeleton-line short"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line tiny"></div>
    </div>`).join('')}</div>
  </section>`;
  return `<div class="view-head"><div>
    <div class="skeleton skeleton-line" style="width:190px;height:22px"></div>
    <div class="skeleton skeleton-line short" style="margin-top:12px;height:12px"></div>
  </div></div><div class="board">${column.repeat(4)}</div>`;
}

function richTextOptions(projectKey = state.projectKey) {
  return {
    uiUrl: state.weknoraUiUrl,
    knowledgeMap: state.citationKnowledge,
    mentionNames: (state.project?.members ?? []).map(({ actor }) => actor.name),
    projectKey,
    projects: state.projects,
    groups: state.board?.groups ?? [],
  };
}

function renderRichTextHtml(body, projectKey = state.projectKey) {
  return renderRichText(body, richTextOptions(projectKey));
}

function projectDescriptionHtml() {
  const description = state.project?.description ?? '';
  return `<div class="project-description">
    <div class="task-description project-description-body">${description ? renderRichTextHtml(description) : '<p class="muted">暂无项目说明，点击「编辑项目」添加。</p>'}</div>
  </div>`;
}

function boardHtml() {
  const board = state.board;
  const allTasks = board.columns.flatMap((column) => column.tasks);
  const attachmentCount = allTasks.filter((task) => (task.fileCount ?? 0) > 0).length;
  const tasks = state.boardHasFiles ? allTasks.filter((task) => (task.fileCount ?? 0) > 0) : allTasks;
  const columns = new Map(
    board.columns.map((column) => [column.status, tasks.filter((task) => task.status === column.status)]),
  );
  const groups = board.groups ?? [];
  const ungrouped = tasks.filter((task) => !task.groupId);
  const lanes = boardLanes(groups, tasks, ungrouped);
  return `<section class="view">
    <div class="view-head">
      <div>
        <div class="view-title">
          <span class="project-mark" style="background:${esc(state.project.color || '#18181b')}"></span>
          <h1>${esc(state.project.name)}</h1>
          <span class="project-key">${esc(state.project.key)}</span>
          <button type="button" class="ghost small project-info-edit" data-action="edit-project">编辑项目</button>
        </div>
        ${projectDescriptionHtml()}
      </div>
      <div class="view-actions">
        ${groups.length ? boardModeSwitch() : ''}
        ${boardFilesFilter(attachmentCount)}
        <button type="button" class="ghost" data-action="new-group">+ 新建任务组</button>
        <button type="button" class="primary" data-action="new-task">+ 新建任务</button>
      </div>
    </div>
    ${state.boardHasFiles && !tasks.length
      ? `<div class="state-card board-empty-card">
          <h1>没有带附件的任务</h1>
          <p>当前项目下暂无已上传附件的任务。</p>
          <button type="button" class="ghost" data-action="board-files-filter">清除筛选</button>
        </div>`
      : groups.length
        ? state.boardMode === 'focus'
          ? focusBoardHtml(lanes)
          : groupBoardHtml(lanes)
        : `<div class="board">${STATUSES.map(([id, label]) => columnHtml(id, label, columns.get(id) ?? [])).join('')}</div>`}
  </section>`;
}

function boardFilesFilter(count) {
  return `<div class="view-switch board-filter" role="group" aria-label="看板筛选">
    <button type="button" class="${state.boardHasFiles ? 'active' : ''}" data-action="board-files-filter" aria-pressed="${state.boardHasFiles}" title="只看有附件的任务">📎 含附件 <span class="filter-count">${count}</span></button>
  </div>`;
}

function boardModeSwitch() {
  return `<div class="view-switch" role="group" aria-label="看板视图">
    <button type="button" class="${state.boardMode === 'groups' ? 'active' : ''}" data-action="board-mode" data-mode="groups" aria-pressed="${state.boardMode === 'groups'}">分组</button>
    <button type="button" class="${state.boardMode === 'focus' ? 'active' : ''}" data-action="board-mode" data-mode="focus" aria-pressed="${state.boardMode === 'focus'}">单组</button>
  </div>`;
}

function boardLanes(groups, tasks, ungrouped) {
  return [
    ...groups.map((group) => ({
      group,
      tasks: tasks.filter((task) => task.groupId === group.id),
    })),
    ...(ungrouped.length
      ? [{ group: { id: null, name: '未分组', description: '尚未归入任何任务组的任务。' }, tasks: ungrouped, ungrouped: true }]
      : []),
  ];
}

function laneKey(lane) {
  return lane.ungrouped ? 'ungrouped' : lane.group.id;
}

function groupBoardHtml(lanes) {
  const statusCounts = new Map(
    STATUSES.map(([id]) => [
      id,
      lanes.reduce((sum, lane) => sum + lane.tasks.filter((task) => task.status === id).length, 0),
    ]),
  );
  return `<div class="group-board">
    <div class="group-board-grid">
      <div class="group-rail-head">任务组</div>
      ${STATUSES.map(([id, label]) => `<div class="group-status-head">
        <span class="status-dot ${id}"></span>
        <span>${label}</span>
        <span class="column-count">${statusCounts.get(id)}</span>
      </div>`).join('')}
      ${lanes.map((lane) => groupLaneHtml(lane.group, lane.tasks, lane.ungrouped)).join('')}
    </div>
  </div>`;
}

function focusBoardHtml(lanes) {
  const selected = lanes.find((lane) => laneKey(lane) === state.focusGroupId) ?? lanes[0];
  const done = selected.tasks.filter((task) => task.status === 'done').length;
  const ratio = selected.tasks.length > 0 ? Math.round((done / selected.tasks.length) * 100) : 0;
  return `<div class="focus-board">
    <aside class="focus-rail" aria-label="任务组">
      <div class="focus-rail-head">任务组</div>
      <div class="focus-group-list">
        ${lanes.map((lane) => focusGroupItemHtml(lane, lane === selected)).join('')}
      </div>
    </aside>
    <section class="focus-main" aria-label="${esc(selected.group.name)} 任务">
      <header class="focus-main-head">
        <div class="focus-main-title">
          <h2>${esc(selected.group.name)}</h2><span class="count">${selected.tasks.length}</span>
          ${selected.ungrouped ? '' : `<button type="button" class="ghost small group-rename" data-action="edit-group" data-group="${esc(selected.group.id)}">编辑</button>
          <button type="button" class="ghost small group-delete" data-action="delete-group" data-group="${esc(selected.group.id)}" data-name="${esc(selected.group.name)}" data-count="${selected.tasks.length}">删除</button>`}
        </div>
        <div class="focus-main-progress" title="完成 ${done}/${selected.tasks.length}">
          <span class="track"><b style="width:${ratio}%"></b></span>
          <span>${done}/${selected.tasks.length}</span>
        </div>
      </header>
      ${selected.group.description ? `<div class="focus-main-desc task-description">${renderRichTextHtml(selected.group.description)}</div>` : ''}
      <div class="board">${STATUSES.map(([id, label]) => columnHtml(id, label, selected.tasks.filter((task) => task.status === id))).join('')}</div>
    </section>
  </div>`;
}

function focusGroupItemHtml(lane, active) {
  const { group, tasks, ungrouped } = lane;
  const done = tasks.filter((task) => task.status === 'done').length;
  const ratio = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;
  return `<button type="button" class="focus-group-item${active ? ' active' : ''}${ungrouped ? ' ungrouped' : ''}" data-action="focus-group" data-group="${esc(laneKey(lane))}" aria-pressed="${active}">
    <span class="focus-group-top"><span class="focus-group-name">${esc(group.name)}</span><span class="focus-group-count">${tasks.length}</span></span>
    ${group.description ? `<span class="focus-group-desc">${esc(group.description)}</span>` : ''}
    <span class="focus-group-progress"><span class="track"><b style="width:${ratio}%"></b></span><span>${done}/${tasks.length}</span></span>
  </button>`;
}

function groupLaneHtml(group, tasks, ungrouped = false) {
  const done = tasks.filter((task) => task.status === 'done').length;
  const ratio = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;
  return `<div class="group-cell${ungrouped ? ' ungrouped' : ''}">
    <div class="group-cell-title">
      <h2>${esc(group.name)}</h2><span class="count">${tasks.length}</span>
      ${ungrouped ? '' : `<button type="button" class="link-button group-rename" data-action="edit-group" data-group="${esc(group.id)}">编辑</button>
      <button type="button" class="link-button group-delete" data-action="delete-group" data-group="${esc(group.id)}" data-name="${esc(group.name)}" data-count="${tasks.length}">删除</button>`}
    </div>
    ${group.description ? `<div class="group-cell-desc task-description">${renderRichTextHtml(group.description)}</div>` : ''}
    <div class="group-cell-progress" title="完成 ${done}/${tasks.length}">
      <span class="track"><b style="width:${ratio}%"></b></span>
      <span>${done}/${tasks.length}</span>
    </div>
  </div>
  ${STATUSES.map(([id, label]) => {
    const cellTasks = tasks.filter((task) => task.status === id);
    return `<div class="group-status-cell" aria-label="${esc(group.name)} · ${label}">${
      cellTasks.length ? cellTasks.map(taskCard).join('') : '<p class="empty group-empty">暂无任务</p>'
    }</div>`;
  }).join('')}`;
}

function columnHtml(id, label, tasks) {
  return `<section class="column" aria-label="${label}">
    <header class="column-head">
      <span class="status-dot ${id}"></span>
      <span>${label}</span>
      <span class="column-count">${tasks.length}</span>
    </header>
    <div class="column-body">${tasks.length ? tasks.map(taskCard).join('') : '<p class="empty">暂无任务</p>'}</div>
  </section>`;
}

function taskCard(task) {
  const progress = task.progress ?? { done: 0, total: 0 };
  const ratio = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const labels = (task.labels ?? []).slice(0, 2).map((label) => `<span class="label">${esc(label)}</span>`).join('');
  const assignees = task.assignees ?? (task.assignee ? [task.assignee] : []);
  const stack = assignees
    .slice(0, 3)
    .map((assigned) => avatar(assigned))
    .join('');
  const extra = assignees.length > 3 ? `<span class="avatar more">+${assignees.length - 3}</span>` : '';
  const attachment = (task.fileCount ?? 0) > 0
    ? `<span class="card-file" title="${task.fileCount} 个附件" aria-label="含 ${task.fileCount} 个附件">📎</span>`
    : '';
  const assigneeHtml = assignees.length
    ? `<span class="avatar-stack">${stack}${extra}</span><span class="assignee-names">${esc(assignees.map((assigned) => assigned.name).join('、'))}</span>`
    : '<span class="muted">未分配</span>';
  return `<a class="task-card" href="${esc(taskPath(state.projectKey, 'board', task.ref))}" data-link>
    <span class="card-top"><span class="ref">${esc(task.ref)}</span><span class="card-tags">${task.kind === 'milestone' ? '<span class="task-kind milestone">里程碑</span>' : ''}${priorityTag(task.priority)}${attachment}</span></span>
    <span class="card-title">${esc(task.title)}</span>
    ${labels ? `<span class="labels">${labels}</span>` : ''}
    <span class="card-footer">
      <span class="assignee">${assigneeHtml}</span>
      ${progress.total > 0 ? `<span class="subtask-progress" title="子任务 ${progress.done}/${progress.total}"><span class="track"><b style="width:${ratio}%"></b></span>${progress.done}/${progress.total}</span>` : ''}
    </span>
  </a>`;
}

function activityHtml() {
  return `<section class="view">
    <div class="view-head">
      <div><div class="view-title"><h1>动态</h1></div><p class="view-sub">项目与任务的事件流，最近 ${state.activity.length} 条${state.liveConnected ? '，正在实时同步' : ''}。</p></div>
      <div class="view-actions">${liveIndicatorHtml()}<button type="button" class="ghost" data-action="refresh">刷新</button></div>
    </div>
    ${activityDigestHtml()}
    <div class="feed-panel">${state.activity.length ? `<ol class="feed">${state.activity.map(feedItem).join('')}</ol>` : '<p class="empty">暂无事件</p>'}</div>
  </section>`;
}

function activityDigestHtml() {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = state.activity.filter((event) => new Date(event.createdAt).getTime() >= since);
  const isType = (prefixes) => (event) =>
    prefixes.some((prefix) => event.type === prefix || event.type.startsWith(`${prefix}.`));
  const taskChanges = recent.filter(isType(['task'])).length;
  const comments = recent.filter(isType(['comment'])).length;
  const automationWork = recent.filter(
    isType(['automation', 'job', 'agent_job', 'automation_run']),
  ).length;
  const actors = new Map();
  for (const event of recent) actors.set(event.actor.id, event.actor);
  const active = [...actors.values()].slice(0, 5);
  return `<div class="activity-digest">
    <div class="digest-stats">
      <div class="digest-stat"><strong>${recent.length}</strong><span>最近 24 小时</span></div>
      <div class="digest-stat"><strong>${taskChanges}</strong><span>任务变更</span></div>
      <div class="digest-stat"><strong>${comments}</strong><span>评论</span></div>
      <div class="digest-stat"><strong>${automationWork}</strong><span>自动化 / Agent</span></div>
    </div>
    <div class="digest-actors">
      <span class="digest-label">活跃成员</span>
      ${active.length
        ? active
            .map((actor) => `<span class="digest-actor">${avatar(actor, 'xs')}<span>${esc(actor.name)}</span></span>`)
            .join('')
        : '<span class="muted">最近 24 小时暂无动态</span>'}
    </div>
  </div>`;
}

function feedItem(event) {
  const link = event.taskRef
    ? ` · <a class="link-button" href="${esc(taskPath(state.projectKey, state.view, event.taskRef))}" data-link>查看 ${esc(event.taskRef)}</a>`
    : '';
  return `<li class="feed-item">
    <span class="feed-icon ${eventCategory(event.type)}"></span>
    <div class="feed-body">
      <p>${describeEvent(event)}</p>
      <div class="feed-meta">
        ${avatar(event.actor, 'xs')}<span>${esc(event.actor.name)}</span><span>·</span>
        <time datetime="${esc(event.createdAt)}" title="${esc(fullDate(event.createdAt))}">${timeAgo(event.createdAt)}</time>${link}
      </div>
    </div>
  </li>`;
}

function eventCategory(type) {
  if (type.startsWith('job.') || type.startsWith('agent_job.')) return 'job';
  const head = type.split('.')[0];
  return ['task', 'comment', 'automation', 'group', 'project', 'member'].includes(head) ? head : 'project';
}

function describeEvent(event) {
  const payload = event.payload ?? {};
  const ref = event.taskRef ? `<strong>${esc(event.taskRef)}</strong>` : '任务';
  switch (event.type) {
    case 'project.created':
      return `创建了项目 ${esc(payload.key ?? '')}`;
    case 'project.updated': {
      const labels = { name: '名称', key: '代号', description: '说明' };
      const fields = (payload.fields ?? []).map((field) => labels[field]).filter(Boolean).join('、');
      return `更新了项目 ${esc(payload.key ?? '')}${fields ? ` 的${fields}` : ''}`;
    }
    case 'task.created':
      return `创建了 ${ref}`;
    case 'task.status_changed':
      return `${ref} 从「${esc(STATUS_LABEL[payload.from] ?? '')}」移动到「${esc(STATUS_LABEL[payload.to] ?? '')}」`;
    case 'task.assigned': {
      const name = payload.to ? memberName(payload.to) : null;
      return name ? `将 ${ref} 分配给 ${esc(name)}` : `取消了 ${ref} 的负责人`;
    }
    case 'task.updated':
      return `更新了 ${ref}`;
    case 'task.dependency_added':
      return `为 ${ref} 添加了${payload.direction === 'predecessor' ? '前置任务' : '后置任务'} <strong>${esc(payload.relatedRef ?? '')}</strong>（${esc(DEPENDENCY_LABEL[payload.type] ?? '')}）`;
    case 'task.dependency_removed':
      return `移除了 ${ref} 的${payload.direction === 'predecessor' ? '前置任务' : '后置任务'} <strong>${esc(payload.relatedRef ?? '')}</strong>`;
    case 'comment.created':
      return `在 ${ref} 添加了评论${payload.excerpt ? `<span class="excerpt">${esc(payload.excerpt)}</span>` : ''}`;
    case 'automation.created':
      return `创建了自动化「${esc(payload.name ?? '')}」`;
    case 'automation.updated':
      return '更新了自动化设置';
    case 'automation.deleted':
      return `删除了自动化「${esc(payload.name ?? '')}」`;
    case 'group.created':
      return `创建了任务组「${esc(payload.name ?? '')}」${payload.taskCount ? ` · ${payload.taskCount} 个任务` : ''}`;
    case 'group.updated': {
      const labels = { name: '名称', description: '说明', position: '排序' };
      const fields = (payload.fields ?? []).map((field) => labels[field]).filter(Boolean).join('、');
      return `更新了任务组「${esc(payload.name ?? '')}」${fields ? ` 的${fields}` : ''}`;
    }
    case 'group.deleted':
      return `删除了任务组「${esc(payload.name ?? '')}」`;
    case 'member.added':
      return `将 ${esc(payload.name ?? '')} 加入项目${payload.role === 'owner' ? '（项目负责人）' : ''}`;
    case 'member.removed':
      return `移除了成员 ${esc(payload.name ?? '')}`;
    case 'member.updated':
      return `更新了 ${esc(payload.name ?? '')} 的项目角色标签${payload.roleTag ? `：${esc(payload.roleTag)}` : '（已清空）'}`;
    case 'job.created':
      return `创建了 Agent 任务「${esc(payload.title ?? '')}」`;
    case 'agent_job.created':
      return `自动化创建了 Agent 任务「${esc(payload.title ?? '')}」`;
    default:
      return esc(event.type);
  }
}

function automationsHtml() {
  const globalRules = state.automations.filter((automation) => !automation.taskId);
  const taskRules = state.automations.filter((automation) => automation.taskId);
  return `<section class="view">
    <div class="view-head">
      <div><div class="view-title"><h1>自动化</h1></div><p class="view-sub">规则分为全局与指定任务两类；给任务添加名称以 Agent 结尾的成员时，会自动生成一条固定的评审规则，由 Agent Worker 异步输出评论。</p></div>
      <div class="view-actions">
        <button type="button" class="ghost" data-action="refresh">刷新</button>
        <button type="button" class="primary" data-action="new-automation">+ 添加自动化</button>
      </div>
    </div>
    <h2 class="section-title">全局规则 <span class="count">${globalRules.length}</span></h2>
    ${globalRules.length ? `<div class="automation-grid">${globalRules.map(automationCard).join('')}</div>` : '<p class="empty">暂无全局规则</p>'}
    <h2 class="section-title">指定任务规则 <span class="count">${taskRules.length}</span></h2>
    ${taskRules.length ? `<div class="automation-grid">${taskRules.map(automationCard).join('')}</div>` : '<p class="empty">暂无指定任务规则</p>'}
    <h2 class="section-title">Agent 任务 <span class="count">${state.jobs.length}</span></h2>
    ${state.jobs.length ? `<div class="job-list">${state.jobs.map(jobRow).join('')}</div>` : '<p class="empty">暂无 Agent 任务</p>'}
  </section>`;
}

function automationCard(automation) {
  const runState = automation.lastRun?.status ?? automation.lastStatus ?? null;
  const statusLabel = runState ? (RUN_LABEL[runState] ?? runState) : '未运行';
  const auto = automation.action.type === 'enqueue_agent' && automation.action.config.auto === true;
  const scope = automation.taskRef
    ? `指定任务 · <a class="link-button" href="${esc(taskPath(state.projectKey, state.view, automation.taskRef))}" data-link>${esc(automation.taskRef)}</a>`
    : '全局 · 项目内所有任务';
  return `<article class="automation-card">
    <div class="automation-head">
      <h3>${esc(automation.name)}</h3>
      <span class="pill ${esc(runState ?? 'idle')}">${esc(statusLabel)}</span>
    </div>
    ${auto ? '<p class="automation-auto">自动规则 · 由 Agent 负责人触发，Prompt 固定，无需手动配置</p>' : ''}
    <p class="automation-line"><span class="tag">范围</span><span>${scope}</span></p>
    <p class="automation-line"><span class="tag">触发</span><span>${triggerText(automation.trigger)}</span></p>
    <p class="automation-line"><span class="tag">动作</span><span>${actionText(automation.action)}</span></p>
    <div class="automation-actions">
      <span class="meta">运行 ${automation.runCount ?? 0} 次${automation.lastRunAt ? ` · ${timeAgo(automation.lastRunAt)}` : ''}</span>
      <div class="automation-buttons">
        <button type="button" class="ghost" data-action="run-automation" data-id="${esc(automation.id)}">立即运行</button>
        <button type="button" class="ghost danger" data-action="delete-automation" data-id="${esc(automation.id)}" data-name="${esc(automation.name)}">删除</button>
      </div>
    </div>
  </article>`;
}

function triggerText(trigger) {
  if (trigger.type === 'cron') {
    return `定时 <span class="muted">${esc(trigger.expression)} · ${esc(trigger.timezone)}</span>`;
  }
  const filter = trigger.filter && Object.keys(trigger.filter).length
    ? ` · ${Object.entries(trigger.filter).map(([key, value]) => `${esc(key)}=${esc(value)}`).join(', ')}`
    : '';
  return `${esc(EVENT_LABEL[trigger.event] ?? trigger.event)}${filter}`;
}

function actionText(action) {
  if (action.type === 'enqueue_agent') {
    const auto = action.config.auto === true ? ' · 自动评审' : '';
    return `派发 Agent Job · ${esc(action.config.agent)}${auto}`;
  }
  if (action.type === 'add_comment') return '自动添加评论';
  if (action.type === 'create_task') return `自动创建任务 · ${esc(action.config.title)}`;
  return esc(action.type);
}

function jobRow(job) {
  return `<div class="job-row">
    <span class="job-status ${esc(job.status)}">${esc(JOB_LABEL[job.status] ?? job.status)}</span>
    <div class="job-main">
      <div class="job-title" title="${esc(job.title)}">${esc(job.title)}</div>
      <div class="job-meta">${job.agent ? esc(job.agent.name) : '未指定 Agent'}${job.taskRef ? ` · ${esc(job.taskRef)}` : ''} · ${timeAgo(job.createdAt)}</div>
      <div class="job-prompt">${esc(job.prompt)}</div>
      ${job.result ? `<div class="job-result ${esc(job.status)}">${esc(job.result)}</div>` : ''}
    </div>
    ${job.taskRef ? `<a class="link-button" href="${esc(taskPath(state.projectKey, state.view, job.taskRef))}" data-link>查看任务</a>` : '<span class="muted"></span>'}
  </div>`;
}

function membersHtml() {
  const members = state.project?.members ?? [];
  const memberIds = new Set(members.map((member) => member.actor.id));
  const available = (state.actors ?? []).filter((actor) => !memberIds.has(actor.id));
  return `<section class="view">
    <div class="view-head">
      <div><div class="view-title"><h1>成员与 Agent</h1></div><p class="view-sub">项目负责人和 Agent 由管理员手动维护；Agent 无需 Token 登录，配置 LLM 或 WeKnora 运行时后即可自动执行任务并回写评论。</p></div>
      <div class="view-actions">
        <button type="button" class="ghost" data-action="refresh">刷新</button>
        <button type="button" class="ghost" data-action="new-actor">+ 新建人员 / Agent</button>
        <button type="button" class="primary" data-action="add-member" ${available.length ? '' : 'disabled'}>+ 添加现有成员</button>
      </div>
    </div>
    <h2 class="section-title">项目成员 <span class="count">${members.length}</span></h2>
    ${members.length ? `<div class="member-grid">${members.map(memberCard).join('')}</div>` : '<p class="empty">暂无项目成员</p>'}
    <h2 class="section-title">可加入的人员 / Agent <span class="count">${available.length}</span></h2>
    ${available.length ? `<div class="member-grid">${available.map(directoryCard).join('')}</div>` : '<p class="empty">所有人员都已加入当前项目</p>'}
  </section>`;
}

function memberCard(member) {
  const actor = member.actor;
  const online = state.onlineActors.some((entry) => entry.id === actor.id);
  return `<article class="member-card ${esc(actor.kind)}">
    <div class="member-head">
      ${avatar(actor, 'lg')}
      <div class="member-name">
        <strong>${esc(actor.name)}</strong>
        <span>${KIND_LABEL[actor.kind] ?? actor.kind}</span>
        ${member.roleTag ? `<span class="member-role-tag">${esc(member.roleTag)}</span>` : ''}
        <em class="member-online ${online ? 'online' : ''}" data-member-online="${esc(actor.id)}">${online ? '<i></i>在线' : ''}</em>
      </div>
      <span class="pill role-${member.role}">${member.role === 'owner' ? '项目负责人' : '成员'}</span>
    </div>
    <p class="member-title">${esc(actor.title || '未填写职位')}</p>
    ${actor.kind === 'agent' ? `<p class="member-extra">WeKnora Agent ID <code>${esc(actor.externalAgentId || '未绑定')}</code></p>` : ''}
    <div class="member-actions">
      <button type="button" class="ghost" data-action="edit-actor" data-actor="${esc(actor.id)}">编辑</button>
      <button type="button" class="ghost danger" data-action="remove-member" data-actor="${esc(actor.id)}" data-name="${esc(actor.name)}">移除</button>
    </div>
  </article>`;
}

function directoryCard(actor) {
  return `<article class="member-card directory ${esc(actor.kind)}">
    <div class="member-head">
      ${avatar(actor, 'lg')}
      <div class="member-name"><strong>${esc(actor.name)}</strong><span>${KIND_LABEL[actor.kind] ?? actor.kind}</span></div>
    </div>
    <p class="member-title">${esc(actor.title || '未填写职位')}</p>
    ${actor.kind === 'agent' ? `<p class="member-extra">WeKnora Agent ID <code>${esc(actor.externalAgentId || '未绑定')}</code></p>` : ''}
    <div class="member-actions">
      <button type="button" class="ghost" data-action="edit-actor" data-actor="${esc(actor.id)}">编辑</button>
      <button type="button" class="primary small" data-action="add-member" data-actor="${esc(actor.id)}">加入项目</button>
    </div>
  </article>`;
}

function openTask(ref) {
  if (!ref) return;
  navigate(taskLinkPath(ref));
}

async function hydrateCitations(detail) {
  const ids = new Set();
  for (const comment of detail.comments ?? []) {
    for (const id of extractCitationChunkIds(comment.body)) {
      if (!state.citationKnowledge[id]) ids.add(id);
    }
  }
  if (ids.size === 0) return;
  try {
    const result = await api('POST', '/weknora/citations/resolve', {
      chunkIds: [...ids].slice(0, 50),
    });
    if (state.openTaskRef !== detail.ref) return;
    Object.assign(state.citationKnowledge, result?.citations ?? {});
    renderDrawer();
  } catch {
    // Resolution is an enhancement; KB-level links stay usable when it fails.
  }
}

async function loadDetail(ref, options = {}) {
  if (!options.silent) {
    state.openTaskLoading = true;
    renderDrawer();
  }
  try {
    const detail = await api('GET', `/tasks/${encodeURIComponent(ref)}`);
    if (state.openTaskRef !== ref) return;
    if (detail.projectKey && (detail.projectKey !== state.projectKey || !state.project)) {
      const overlay = state.page === 'me' || state.page === 'task';
      if (overlay) {
        if (!state.projects.some((project) => project.key === detail.projectKey)) {
          toast('该任务所属项目不存在或无权访问', 'error');
          closeDrawer();
          render();
          return;
        }
        await loadProject(detail.projectKey);
        if (state.openTaskRef !== ref) return;
        if (state.error || state.projectKey !== detail.projectKey) {
          const message = state.error ?? '任务所属项目加载失败';
          state.openTaskLoading = false;
          closeDrawer();
          if (state.page === 'me') state.error = null;
          toast(message, 'error');
          render();
          return;
        }
      } else if (state.projects.some((project) => project.key === detail.projectKey)) {
        await navigate(taskPath(detail.projectKey, state.view, ref), { replace: true });
        return;
      } else {
        toast('该任务不属于当前项目', 'error');
        dismissTask({ replace: true });
        return;
      }
    }
    state.openTask = detail;
    state.openTaskLoading = false;
  } catch (error) {
    if (state.openTaskRef !== ref) return;
    state.openTaskLoading = false;
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
    if (state.openTask) {
      renderDrawer();
    } else {
      closeDrawer();
      if (parseRoute().taskRef === ref) dismissTask({ replace: true });
    }
    return;
  }
  renderDrawer();
  syncLayers();
  void hydrateCitations(state.openTask);
}

function closeDrawer() {
  state.openTaskRef = null;
  state.openTask = null;
  state.openTaskLoading = false;
  state.aiSuggestion = null;
  state.dependenciesOpen = false;
  state.descriptionEditing = false;
  state.descriptionDraft = null;
  state.upload = null;
  drawer.hidden = true;
  drawer.innerHTML = '';
  syncLayers();
}

function dismissTask(options = {}) {
  const route = parseRoute();
  if (route.name === 'task') {
    navigate(state.projectKey ? projectPath(state.projectKey, 'board') : UI_ROOT, options);
    return;
  }
  if (route.name === 'me') {
    navigate(MY_TASKS_PATH, options);
    return;
  }
  navigate(state.projectKey ? currentViewPath() : UI_ROOT, options);
}

function renderDrawer() {
  if (!state.openTaskRef) {
    drawer.hidden = true;
    drawer.innerHTML = '';
    updateTitle();
    return;
  }
  drawer.hidden = false;
  if (state.openTaskLoading) drawer.innerHTML = drawerSkeleton(state.openTaskRef);
  else if (state.openTask) drawer.innerHTML = taskDetailHtml(state.openTask);
  else drawer.innerHTML = '';
  updateTitle();
}

function drawerSkeleton(ref) {
  return `<div class="drawer-head">
    <span class="ref">${esc(ref)}</span>
    <button type="button" class="icon-button" data-action="close-drawer" aria-label="关闭">×</button>
  </div>
  <div class="drawer-body">
    <div class="skeleton skeleton-line" style="width:70%;height:20px"></div>
    <div class="skeleton skeleton-line"></div>
    <div class="skeleton skeleton-line short"></div>
    <p class="loading-text">加载中…</p>
  </div>`;
}

function taskDetailHtml(task) {
  const progress = task.progress ?? { done: 0, total: 0 };
  const overdue = taskOverdue(task);
  const labels = (task.labels ?? []).map((label) => `<span class="label">${esc(label)}</span>`).join('');
  const subtasks = task.subtasks ?? [];
  const comments = [...(task.comments ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const assignees = task.assignees ?? (task.assignee ? [task.assignee] : []);
  const assigneeHtml = assignees.length
    ? assignees
        .map((assigned) => {
          const tag = roleTagFor(assigned.id);
          return `<span class="assignee-chip">${avatar(assigned, 'xs')}<span>${esc(assigned.name)}</span>${assigned.kind === 'agent' ? '<span class="kind">Agent</span>' : ''}${tag ? `<span class="role-tag">${esc(tag)}</span>` : ''}</span>`;
        })
        .join('')
    : '<span class="muted">未分配</span>';
  const hasAgent = (state.project?.members ?? []).some(({ actor }) => actor.kind === 'agent');
  const aiPending = state.aiSuggestion?.ref === task.ref;
  const dependencies = task.dependencies ?? { predecessors: [], successors: [] };
  const dependencyCount = dependencies.predecessors.length + dependencies.successors.length;
  const dependenciesOpen = state.dependenciesOpen;
  const files = task.files ?? [];
  const descriptionEditing = state.descriptionEditing;
  const descriptionDraft = state.descriptionDraft ?? task.description ?? '';
  return `<div class="drawer-head">
    <div class="drawer-head-left">
      <span class="ref">${esc(task.ref)}</span>
      <button type="button" class="dependency-toggle${dependenciesOpen ? ' active' : ''}" data-action="toggle-dependencies" aria-expanded="${dependenciesOpen}">
        依赖 <span class="count">${dependencyCount}</span><span class="dependency-caret">${dependenciesOpen ? '▴' : '▾'}</span>
      </button>
    </div>
    <button type="button" class="icon-button" data-action="close-drawer" aria-label="关闭">×</button>
  </div>
  <div class="drawer-body">
    ${dependenciesOpen ? dependencyPanelHtml(task, dependencies) : ''}
    <h2 class="task-title">${esc(task.title)}</h2>
    <div class="status-switch" role="group" aria-label="任务状态">
      ${STATUSES.map(([id, label]) => {
        const blockers = dependencyBlockers(task, id);
        const hint = blockers.length > 0 ? `前置依赖未满足：${blockers.map(dependencyBlockLabel).join('、')}` : '';
        return `<button type="button" class="${task.status === id ? 'active' : ''}${blockers.length > 0 ? ' is-blocked' : ''}"${hint ? ` title="${esc(hint)}" aria-label="${esc(`${label}，${hint}`)}"` : ''} data-action="set-status" data-status="${id}">${label}</button>`;
      }).join('')}
    </div>
    ${dependencyBlockerHint(task)}
    <section class="task-description-block">
      <div class="subtasks-head">
        <h3>说明</h3>
        ${descriptionEditing ? '' : `<button type="button" class="ghost small" data-action="edit-description">${task.description ? '编辑' : '+ 添加说明'}</button>`}
      </div>
      ${descriptionEditing ? `<form id="description-form" class="comment-form description-form" data-ref="${esc(task.ref)}">
        <textarea name="description" rows="5" maxlength="20000" placeholder="写下任务说明… 支持 Markdown，可用 @姓名 提及、ORB-12 引用任务、#ORB 引用项目、#[任务组名称] 引用任务组">${esc(descriptionDraft)}</textarea>
        <p class="hint">支持 Markdown；输入 <code>@姓名</code> 提及成员，任务引用 <code>ORB-12</code>，项目引用 <code>#ORB</code>，任务组引用 <code>#[组名]</code>。</p>
        <div class="comment-actions description-actions">
          <button type="button" class="ghost small" data-action="cancel-description">取消</button>
          <button type="submit" class="primary small">保存</button>
        </div>
      </form>` : `<div class="task-description">${task.description ? renderRichTextHtml(task.description, task.projectKey ?? state.projectKey) : '<p class="muted">暂无说明，点击右上角添加。</p>'}</div>`}
    </section>
    <dl class="meta-grid">
      <div><dt>类型</dt><dd>${task.kind === 'milestone' ? '<span class="task-kind milestone">里程碑任务</span>' : '<span class="muted">普通任务</span>'}</dd></div>
      <div><dt>优先级</dt><dd>${priorityTag(task.priority)}</dd></div>
      <div class="assignee-field"><dt>负责人</dt><dd><span class="assignee-chips">${assigneeHtml}</span><button type="button" class="ghost small" data-action="edit-assignees">编辑</button></dd></div>
      <div><dt>任务组</dt><dd>${task.groupName ? `<span class="group-chip">${esc(task.groupName)}</span>` : '<span class="muted">未分组</span>'}</dd></div>
      <div><dt>创建者</dt><dd>${avatar(task.createdBy, 'xs')}<span>${esc(task.createdBy.name)}</span></dd></div>
      <div><dt>创建时间</dt><dd title="${esc(fullDate(task.createdAt))}">${esc(fullDate(task.createdAt))}</dd></div>
      <div><dt>开始时间</dt><dd><input type="datetime-local" class="meta-date" data-task-time="startAt" value="${esc(toDateTimeLocal(task.startAt))}" aria-label="开始时间"></dd></div>
      <div><dt>截止时间</dt><dd><input type="datetime-local" class="meta-date${overdue ? ' overdue' : ''}" data-task-time="dueAt" value="${esc(toDateTimeLocal(task.dueAt))}" aria-label="截止时间"></dd></div>
      <div><dt>完成时间</dt><dd>${task.completedAt ? `<span title="${esc(fullDate(task.completedAt))}">${esc(fullDate(task.completedAt))}</span>` : `<span class="muted">${task.status === 'done' ? '—' : '未完成'}</span>`}</dd></div>
      <div><dt>更新</dt><dd title="${esc(fullDate(task.updatedAt))}">${timeAgo(task.updatedAt)}</dd></div>
    </dl>
    ${labels ? `<div class="label-row">${labels}</div>` : ''}
    ${task.parent ? `<a class="parent-link" href="${esc(taskLinkPath(task.parent.ref))}" data-link>上级任务 · ${esc(task.parent.ref)} ${esc(task.parent.title)}</a>` : ''}
    <section class="subtasks">
      <div class="subtasks-head">
        <h3>子任务 <span class="count">${progress.done}/${progress.total}</span></h3>
        ${task.status === 'done' ? '' : `<button type="button" class="ghost small" data-action="new-subtask" data-parent="${esc(task.ref)}" data-title="${esc(task.title)}" data-group="${esc(task.groupId ?? '')}">+ 新建子任务</button>`}
      </div>
      ${subtasks.length ? `<div class="subtask-list">${subtasks.map((subtask) => `<div class="subtask-row">
        <a class="subtask" href="${esc(taskLinkPath(subtask.ref))}" data-link>
          <span class="status-dot ${subtask.status}"></span>
          <span class="subtask-title">${esc(subtask.ref)} · ${esc(subtask.title)}</span>
          <span class="subtask-status">${esc(STATUS_LABEL[subtask.status] ?? subtask.status)}</span>
        </a>
        ${task.status === 'done' ? '' : `<button type="button" class="ghost small subtask-add" data-action="new-subtask" data-parent="${esc(subtask.ref)}" data-title="${esc(subtask.title)}" data-group="${esc(subtask.groupId ?? '')}" aria-label="在 ${esc(subtask.ref)} 下创建子任务" ${subtask.status === 'done' ? 'disabled title="已完成的任务不能再添加子任务"' : ''}>+ 子任务</button>`}
      </div>`).join('')}</div>` : '<p class="empty small">还没有子任务</p>'}
    </section>
    <section class="attachments">
      <div class="subtasks-head">
        <h3>附件 <span class="count">${files.length}</span></h3>
        <form id="file-form" class="file-form" data-ref="${esc(task.ref)}">
          <label class="ghost small file-pick${state.upload?.ref === task.ref ? ' is-busy' : ''}">
            ${state.upload?.ref === task.ref ? '上传中…' : '+ 上传附件'}
            <input type="file" name="file" aria-label="选择附件" ${state.upload?.ref === task.ref ? 'disabled' : ''}>
          </label>
        </form>
      </div>
      ${uploadProgressHtml(task.ref)}
      <p class="file-hint">单文件不超过 ${formatBytes(state.fileLimits.maxUploadBytes)}，每个任务最多 ${state.fileLimits.taskFileLimit} 个附件。</p>
      ${files.length ? `<div class="file-list">${files.map(fileRowHtml).join('')}</div>` : '<p class="empty small">还没有附件</p>'}
    </section>
    <section class="ai-suggestion">
      <div>
        <strong>AI 建议</strong>
        <p>Agent 将结合项目进度、任务上下文与项目知识库解释这个任务，并作为评论发送。</p>
      </div>
      <button type="button" class="ghost" data-action="ai-suggestion" data-ref="${esc(task.ref)}" ${aiPending || !hasAgent ? 'disabled' : ''}>${aiPending ? 'Agent 生成中…' : hasAgent ? '生成建议' : '暂无 Agent'}</button>
    </section>
    <section class="comments">
      <h3>评论 <span class="count">${comments.length}</span></h3>
      ${comments.length ? `<ul class="comment-list">${comments.map(commentItem).join('')}</ul>` : '<p class="empty small">还没有评论</p>'}
      <form id="comment-form" class="comment-form" data-ref="${esc(task.ref)}">
        ${mentionHintsHtml(commentDraftFor(task.ref))}
        <textarea name="body" rows="2" placeholder="写下评论… 输入 @ 提及成员或 Agent，可用 ORB-12 / #ORB / #[组名] 引用" required>${esc(commentDraftFor(task.ref))}</textarea>
        <div class="comment-actions"><span class="hint">Ctrl + Enter 发送 · 任务 ORB-12 · 项目 #ORB · 任务组 #[组名]</span><button type="submit" class="primary small">评论</button></div>
      </form>
    </section>
  </div>`;
}

function fileExtLabel(name) {
  const index = String(name).lastIndexOf('.');
  return index > 0 ? String(name).slice(index + 1).toUpperCase().slice(0, 4) : 'FILE';
}

function fileRowHtml(file) {
  const canDelete = state.project?.role === 'owner' || file.uploadedBy?.id === state.actor?.id;
  return `<div class="file-row">
    <span class="file-ext">${esc(fileExtLabel(file.name))}</span>
    <div class="file-main">
      <span class="file-name" title="${esc(file.name)}">${esc(file.name)}</span>
      <span class="file-meta">${formatBytes(file.sizeBytes)} · ${esc(file.uploadedBy?.name ?? '未知')} · ${timeAgo(file.createdAt)}</span>
    </div>
    <div class="file-actions">
      <button type="button" class="ghost small" data-action="download-file" data-id="${esc(file.id)}" data-name="${esc(file.name)}">下载</button>
      ${canDelete ? `<button type="button" class="ghost small danger" data-action="delete-file" data-id="${esc(file.id)}" data-name="${esc(file.name)}">删除</button>` : ''}
    </div>
  </div>`;
}

function uploadProgressHtml(ref) {
  const upload = state.upload;
  if (!upload || upload.ref !== ref) return '';
  return `<div class="file-upload-progress" data-progress>
    <span class="bar" style="width:${upload.percent}%"></span>
    <span class="label">${esc(upload.name)} · ${upload.percent}%</span>
  </div>`;
}

function dependencyPanelHtml(task, dependencies) {
  return `<section class="dependencies">
    <div class="dependencies-head">
      <strong>任务依赖</strong>
      <span>前置未满足时，会阻塞开始或完成</span>
    </div>
    ${dependencyRowHtml(task, dependencies, 'predecessor', '前置任务', dependencies.predecessors)}
    ${dependencyRowHtml(task, dependencies, 'successor', '后置任务', dependencies.successors)}
  </section>`;
}

const STATUS_RANK = { todo: 0, doing: 1, review: 2, done: 3 };

function dependencyRequirement(link) {
  return link.type.startsWith('finish') ? 'done' : 'started';
}

function dependencyMet(link) {
  return dependencyRequirement(link) === 'done'
    ? link.task.status === 'done'
    : link.task.status !== 'todo';
}

function dependencyBlockers(task, targetStatus) {
  const predecessors = task.dependencies?.predecessors ?? [];
  if ((STATUS_RANK[targetStatus] ?? 0) <= (STATUS_RANK[task.status] ?? 0)) return [];
  return predecessors
    .filter((link) => !dependencyMet(link))
    .filter((link) => {
      const finishBound = link.type === 'finish_to_finish' || link.type === 'start_to_finish';
      return targetStatus === 'done' || !finishBound;
    })
    .map((link) => ({ ...link, requirement: dependencyRequirement(link) }));
}

function dependencyBlockLabel(blocker) {
  return `${blocker.task.ref}（${blocker.requirement === 'done' ? '未完成' : '未开始'}）`;
}

function dependencyBlockerHint(task) {
  const blockers = dependencyBlockers(task, 'done');
  if (blockers.length === 0 || task.status === 'done') return '';
  return `<p class="dependency-block-hint">完成前需先满足：${blockers
    .map((blocker) => `<span class="blocker-ref">${esc(blocker.task.ref)}</span> ${blocker.requirement === 'done' ? '未完成' : '未开始'}`)
    .join('、')}</p>`;
}

function dependencyRowHtml(task, dependencies, direction, label, links) {
  const linkedIds = new Set([
    task.id,
    ...dependencies.predecessors.map((link) => link.task.id),
    ...dependencies.successors.map((link) => link.task.id),
  ]);
  const candidates = boardTasks().filter((candidate) => !linkedIds.has(candidate.id));
  const options = candidates
    .map((candidate) => `<option value="${esc(candidate.ref)}">${esc(candidate.ref)} · ${esc(candidate.title)}</option>`)
    .join('');
  const types = Object.entries(DEPENDENCY_LABEL)
    .map(([value, text]) => `<option value="${value}">${text}</option>`)
    .join('');
  const items = links.length
    ? links
        .map(
          (link) => {
            const blocked = direction === 'predecessor' && !dependencyMet(link);
            const unmet = blocked
              ? `<span class="dependency-unmet">${dependencyRequirement(link) === 'done' ? '未完成' : '未开始'}</span>`
              : '';
            return `<div class="dependency-item${blocked ? ' is-blocking' : ''}">
            <span class="status-dot ${link.task.status}"></span>
            <a class="dependency-task" href="${esc(taskLinkPath(link.task.ref))}" data-link>
              <span class="dependency-ref">${esc(link.task.ref)}</span>
              <span class="dependency-title">${esc(link.task.title)}</span>
            </a>
            ${unmet}
            <span class="dependency-type">${esc(DEPENDENCY_LABEL[link.type] ?? link.type)}</span>
            <button type="button" class="dependency-remove" data-action="remove-dependency" data-id="${esc(link.id)}" aria-label="移除${label}">×</button>
          </div>`;
          },
        )
        .join('')
    : '<p class="empty small">暂无</p>';
  return `<div class="dependency-row">
    <div class="dependency-row-head"><strong>${label}</strong><span class="count">${links.length}</span></div>
    <div class="dependency-list">${items}</div>
    <form class="dependency-form" data-direction="${direction}">
      <select name="task" aria-label="选择任务" ${candidates.length ? '' : 'disabled'}>
        ${candidates.length ? options : '<option value="">没有可添加的任务</option>'}
      </select>
      <select name="type" aria-label="依赖类型">${types}</select>
      <button type="submit" class="primary small" ${candidates.length ? '' : 'disabled'}>添加</button>
    </form>
  </div>`;
}

function memberOptions(selectedId) {
  const members = state.project?.members ?? [];
  const options = members
    .map(({ actor }) => `<option value="${esc(actor.name)}" ${actor.id === selectedId ? 'selected' : ''}>${esc(actor.name)}${actor.kind === 'agent' ? ' · Agent' : ''}</option>`)
    .join('');
  return `<option value="">未分配</option>${options}`;
}

function memberChecks(selectedIds = []) {
  const members = state.project?.members ?? [];
  if (!members.length) return '<p class="empty small">当前项目还没有成员，请先到「成员」视图添加。</p>';
  return members
    .map(({ actor }) => `<label class="check-chip">
      <input type="checkbox" name="assignees" value="${esc(actor.name)}" ${selectedIds.includes(actor.id) ? 'checked' : ''}>
      <span>${avatar(actor, 'xs')}<span>${esc(actor.name)}</span>${actor.kind === 'agent' ? '<span class="kind">Agent</span>' : ''}</span>
    </label>`)
    .join('');
}

function commentItem(comment) {
  return `<li class="comment">
    <div class="comment-head">
      ${avatar(comment.author, 'xs')}<strong>${esc(comment.author.name)}</strong>
      ${comment.author.kind === 'agent' ? '<span class="kind">Agent</span>' : ''}
      <time datetime="${esc(comment.createdAt)}" title="${esc(fullDate(comment.createdAt))}">${timeAgo(comment.createdAt)}</time>
    </div>
    <div class="comment-body">${renderRichTextHtml(comment.body)}</div>
  </li>`;
}

function commentDraftFor(ref) {
  return state.commentDraft?.ref === ref ? state.commentDraft.body : '';
}

function mentionMembers() {
  return (state.project?.members ?? []).filter(({ actor }) => actor.id !== state.actor?.id);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionedMembers(body) {
  const members = [...mentionMembers()].sort(
    (a, b) => b.actor.name.length - a.actor.name.length,
  );
  let remaining = String(body ?? '');
  const found = [];
  for (const { actor } of members) {
    const pattern = new RegExp(`@${escapeRegExp(actor.name)}(?![\\p{L}\\p{N}_])`, 'iu');
    if (!pattern.test(remaining)) continue;
    found.push(actor);
    remaining = remaining.replace(pattern, ' ');
  }
  return found;
}

function mentionTokensHtml(body) {
  const linked = mentionedMembers(body);
  if (linked.length === 0) {
    return '<span class="mention-token-hint">输入 @ 或从列表选择成员；@Agent 会结合任务上下文回复</span>';
  }
  return linked
    .map(
      (actor) =>
        `<span class="mention-chip is-linked${actor.kind === 'agent' ? ' is-agent' : ''}">@${esc(actor.name)}<span class="mention-chip-kind">${actor.kind === 'agent' ? 'Agent 回复' : '已关联'}</span></span>`,
    )
    .join('');
}

function mentionHintsHtml(body = '') {
  const members = mentionMembers();
  if (members.length === 0) return '';
  return `<div class="mention-hints" aria-label="提及成员">
    <button type="button" class="ghost small mention-trigger" data-action="toggle-mention-picker" aria-expanded="false" aria-controls="mention-picker">@ 提及成员</button>
    <div class="mention-tokens" data-mention-tokens aria-live="polite">${mentionTokensHtml(body)}</div>
  </div>
  <div class="mention-picker" id="mention-picker" hidden>
    <input type="search" class="mention-search" data-mention-search placeholder="搜索成员或 Agent…" autocomplete="off" aria-label="搜索要提及的成员">
    <div class="mention-options" role="listbox" aria-label="成员列表">
      ${members
        .map(
          ({ actor, roleTag }) => `<button type="button" class="mention-option" role="option" data-action="pick-mention" data-name="${esc(actor.name)}" data-kind="${esc(actor.kind)}" data-search="${esc(`${actor.name} ${actor.title ?? ''} ${roleTag ?? ''} ${KIND_LABEL[actor.kind] ?? actor.kind}`.toLowerCase())}">
            ${avatar(actor, 'xs')}
            <span class="mention-option-name">${esc(actor.name)}</span>
            <span class="mention-option-meta">${actor.kind === 'agent' ? 'Agent' : '成员'}${roleTag ? ` · ${esc(roleTag)}` : actor.title ? ` · ${esc(actor.title)}` : ''}</span>
          </button>`,
        )
        .join('')}
    </div>
    <p class="mention-empty" data-mention-empty hidden>没有匹配的成员</p>
  </div>`;
}

function syncMentionTokens(textarea) {
  const tokens = textarea?.closest('#comment-form')?.querySelector('[data-mention-tokens]');
  if (tokens) tokens.innerHTML = mentionTokensHtml(textarea.value);
}

function closeMentionPicker() {
  const picker = document.querySelector('#mention-picker');
  if (!picker || picker.hidden) return;
  picker.hidden = true;
  document
    .querySelector('[data-action="toggle-mention-picker"]')
    ?.setAttribute('aria-expanded', 'false');
}

function toggleMentionPicker(open) {
  const picker = document.querySelector('#mention-picker');
  if (!picker) return;
  const next = open ?? picker.hidden;
  picker.hidden = !next;
  document
    .querySelector('[data-action="toggle-mention-picker"]')
    ?.setAttribute('aria-expanded', String(next));
  if (!next) return;
  const search = picker.querySelector('[data-mention-search]');
  if (search) {
    search.value = '';
    filterMentionOptions('');
    search.focus();
  }
}

function filterMentionOptions(query) {
  const picker = document.querySelector('#mention-picker');
  if (!picker) return;
  const normalized = String(query ?? '').trim().toLowerCase();
  let visible = 0;
  for (const option of picker.querySelectorAll('.mention-option')) {
    const matches =
      !normalized ||
      option.dataset.name.toLowerCase().includes(normalized) ||
      (option.dataset.search ?? '').includes(normalized);
    option.hidden = !matches;
    if (matches) visible += 1;
  }
  const empty = picker.querySelector('[data-mention-empty]');
  if (empty) empty.hidden = visible > 0;
}

function boardTasks() {
  return (state.board?.columns ?? []).flatMap((column) => column.tasks);
}

function taskOptions(tasks, selected = '') {
  if (!tasks.length) return '<option value="">暂无任务</option>';
  return tasks
    .map((task) => `<option value="${esc(task.ref)}" ${task.ref === selected ? 'selected' : ''}>${esc(task.ref)} · ${esc(task.title)}</option>`)
    .join('');
}

function openTaskModal(parent = null) {
  state.taskParentPreset = parent
    ? { ref: parent.ref, title: parent.title ?? '', groupId: parent.groupId ?? '' }
    : null;
  state.modal = 'task';
  state.pendingAutomationDelete = null;
  renderModal();
  syncLayers();
}

function openGroupModal(groupId = null) {
  state.groupEdit = groupId
    ? (state.board?.groups ?? []).find((group) => group.id === groupId) ?? null
    : null;
  state.modal = 'group';
  state.pendingAutomationDelete = null;
  renderModal();
  syncLayers();
}

function openDeleteGroup(id, name, count) {
  if (!id) return;
  state.pendingGroupDelete = { id, name: name || '未命名任务组', count: Number(count) || 0 };
  state.modal = 'delete-group';
  renderModal();
  syncLayers();
}

function openAutomationModal() {
  state.modal = 'automation';
  state.pendingAutomationDelete = null;
  state.automationTasks = boardTasks();
  renderModal();
  syncLayers();
  loadAutomationTasks();
}

async function loadAutomationTasks() {
  const key = state.projectKey;
  if (!key) return;
  try {
    const tasks = await api('GET', `/projects/${encodeURIComponent(key)}/tasks?includeSubtasks=true&limit=100`);
    if (state.modal !== 'automation' || state.projectKey !== key) return;
    state.automationTasks = tasks;
    const select = modal.querySelector('select[name="taskRef"]');
    if (select) select.innerHTML = taskOptions(tasks, select.value);
  } catch {}
}

function openDeleteAutomation(id, name) {
  if (!id) return;
  state.pendingAutomationDelete = { id, name: name || '未命名自动化' };
  state.modal = 'delete-automation';
  renderModal();
  syncLayers();
}

function closeModal() {
  state.modal = null;
  state.taskParentPreset = null;
  state.groupEdit = null;
  state.pendingAutomationDelete = null;
  state.pendingGroupDelete = null;
  state.pendingMemberRemove = null;
  state.pendingMemberPreselect = '';
  state.editingActor = null;
  state.actorMemberships = null;
  state.actorRoleProject = '';
  state.actorRoleDrafts = null;
  modal.hidden = true;
  modal.innerHTML = '';
  syncLayers();
}

function renderModal() {
  if (!state.modal) {
    modal.hidden = true;
    modal.innerHTML = '';
    return;
  }
  if (state.modal === 'task') return renderTaskModal();
  if (state.modal === 'project-info') return renderProjectInfoModal();
  if (state.modal === 'new-project') return renderNewProjectModal();
  if (state.modal === 'group') return renderGroupModal();
  if (state.modal === 'automation') return renderAutomationModal();
  if (state.modal === 'delete-automation') return renderDeleteAutomationModal();
  if (state.modal === 'delete-group') return renderDeleteGroupModal();
  if (state.modal === 'assignees') return renderAssigneesModal();
  if (state.modal === 'member') return renderMemberModal();
  if (state.modal === 'actor') return renderActorModal();
  if (state.modal === 'remove-member') return renderRemoveMemberModal();
  closeModal();
}

function renderTaskModal() {
  const preset = state.taskParentPreset;
  const parents = (state.board?.columns ?? []).flatMap((column) => column.tasks).filter((task) => task.status !== 'done');
  if (preset && !parents.some((task) => task.ref === preset.ref)) {
    parents.push({ ref: preset.ref, title: preset.title, groupId: preset.groupId });
  }
  const groups = state.board?.groups ?? [];
  const groupOptions = groups
    .map((group) => `<option value="${esc(group.id)}" ${group.id === preset?.groupId ? 'selected' : ''}>${esc(group.name)}</option>`)
    .join('');
  const parentOptions = parents
    .map((task) => `<option value="${esc(task.ref)}" ${task.ref === preset?.ref ? 'selected' : ''}>${esc(task.ref)} · ${esc(task.title)}</option>`)
    .join('');
  modal.hidden = false;
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${preset ? '新建子任务' : '新建任务'}">
    <div class="modal-head">
      <h2>${preset ? '新建子任务' : '新建任务'}</h2>
      <button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button>
    </div>
    <form id="task-form">
      <label class="field"><span>标题</span><input name="title" maxlength="200" required placeholder="要做什么？"></label>
      <label class="field"><span>描述</span><textarea name="description" rows="3" placeholder="可选"></textarea></label>
      <div class="field-row">
        <label class="field"><span>类型</span><select name="kind"><option value="task" selected>普通任务</option><option value="milestone">里程碑任务</option></select></label>
        <label class="field"><span>优先级</span><select name="priority">${['low', 'medium', 'high', 'urgent'].map((priority) => `<option value="${priority}" ${priority === 'medium' ? 'selected' : ''}>${PRIORITY_LABEL[priority]}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>任务组</span><select name="group"><option value="" ${preset?.groupId ? '' : 'selected'}>未分组</option>${groupOptions}</select></label>
      <div class="field"><span>负责人（可多选）</span><div class="check-grid">${memberChecks()}</div></div>
      <label class="field"><span>父任务</span><select name="parent"><option value="" ${preset ? '' : 'selected'}>无（顶层任务）</option>${parentOptions}</select></label>
      <p class="hint">子任务可以继续嵌套；父任务需先完成全部直接子任务。成员名称以 <code>Agent</code> 结尾时，创建任务会自动生成一条自动评审规则。</p>
      <div class="modal-actions">
        <button type="button" class="ghost" data-action="close-modal">取消</button>
        <button type="submit" class="primary">${preset ? '创建子任务' : '创建任务'}</button>
      </div>
    </form>
  </div>`;
  requestAnimationFrame(() => modal.querySelector('input[name="title"]')?.focus());
}

function renderProjectInfoModal() {
  const project = state.project;
  if (!project) {
    closeModal();
    return;
  }
  modal.hidden = false;
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="编辑项目">
    <div class="modal-head">
      <h2>编辑项目</h2>
      <button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button>
    </div>
    <form id="project-info-form">
      <label class="field"><span>项目名称</span><input name="name" maxlength="120" required value="${esc(project.name)}"></label>
      <label class="field"><span>项目代号</span><input name="key" maxlength="20" minlength="2" required value="${esc(project.key)}" pattern="[A-Za-z][A-Za-z0-9]*(-[A-Za-z][A-Za-z0-9]*)*" autocomplete="off" spellcheck="false" style="text-transform:uppercase"></label>
      <p class="hint">代号用于任务引用（如 ${esc(project.key)}-12）和 URL；支持尾标子项目，如 <code>MOUSE-REQ</code> 的任务为 <code>MOUSE-REQ-1</code>。修改后旧代号立即失效，任务编号保持不变；已有引用文本不会自动改写。</p>
      <label class="field"><span>项目说明</span><textarea name="description" rows="5" maxlength="20000" placeholder="写下项目说明… 支持 Markdown，可用 @姓名 提及、ORB-12 引用任务、#ORB 引用项目、#[任务组名称] 引用任务组">${esc(project.description ?? '')}</textarea></label>
      <p class="hint">支持 Markdown；输入 <code>@姓名</code> 提及成员，任务引用 <code>ORB-12</code>，项目引用 <code>#ORB</code>，任务组引用 <code>#[组名]</code>。</p>
      <div class="modal-actions">
        <button type="button" class="ghost" data-action="close-modal">取消</button>
        <button type="submit" class="primary">保存</button>
      </div>
    </form>
  </div>`;
  requestAnimationFrame(() => modal.querySelector('input[name="name"]')?.select());
}

function openProjectInfoModal() {
  if (!state.project) return;
  state.modal = 'project-info';
  renderModal();
  syncLayers();
}

function openNewProjectModal() {
  state.modal = 'new-project';
  renderModal();
  syncLayers();
}

function renderNewProjectModal() {
  modal.hidden = false;
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="新建项目">
    <div class="modal-head">
      <h2>新建项目</h2>
      <button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button>
    </div>
    <form id="new-project-form">
      <label class="field"><span>项目名称</span><input name="name" maxlength="120" required placeholder="例如：鼠标需求"></label>
      <label class="field"><span>项目代号</span><input name="key" maxlength="20" minlength="2" required pattern="[A-Za-z][A-Za-z0-9]*(-[A-Za-z][A-Za-z0-9]*)*" autocomplete="off" spellcheck="false" placeholder="例如：MOUSE 或 MOUSE-REQ" style="text-transform:uppercase"></label>
      <p class="hint">代号用于任务引用和 URL，支持尾标子项目：项目 <code>MOUSE-REQ</code> 的首个任务为 <code>MOUSE-REQ-1</code>。创建后你会成为项目负责人。</p>
      <label class="field"><span>项目说明（可选）</span><textarea name="description" rows="4" maxlength="20000" placeholder="写下项目说明… 支持 Markdown、@提及和任务/项目/任务组引用"></textarea></label>
      <div class="modal-actions">
        <button type="button" class="ghost" data-action="close-modal">取消</button>
        <button type="submit" class="primary">创建项目</button>
      </div>
    </form>
  </div>`;
  requestAnimationFrame(() => modal.querySelector('input[name="name"]')?.focus());
}

function renderGroupModal() {
  const editing = state.groupEdit;
  const action = editing ? '编辑任务组' : '新建任务组';
  modal.hidden = false;
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${action}">
    <div class="modal-head">
      <h2>${action}</h2>
      <button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button>
    </div>
    <form id="group-form">
      <label class="field"><span>名称</span><input name="name" maxlength="120" required placeholder="例如：概念阶段" value="${esc(editing?.name ?? '')}"></label>
      <label class="field"><span>描述</span><textarea name="description" rows="4" maxlength="20000" placeholder="这个任务组负责什么？支持 Markdown，可用 @姓名 提及、ORB-12 引用任务、#ORB 引用项目、#[任务组名称] 引用任务组">${esc(editing?.description ?? '')}</textarea></label>
      <p class="hint">${editing ? '修改名称和描述不会移动或改变组内任务。' : '任务组用于把同一阶段或同一交付物下的任务聚合到看板左侧。'}描述同样支持 Markdown、@提及与项目/任务/任务组引用。</p>
      <div class="modal-actions">
        <button type="button" class="ghost" data-action="close-modal">取消</button>
        <button type="submit" class="primary">${editing ? '保存修改' : '创建任务组'}</button>
      </div>
    </form>
  </div>`;
  requestAnimationFrame(() => {
    const input = modal.querySelector('input[name="name"]');
    input?.focus();
    if (editing) input?.select();
  });
}

function agentOptions() {
  const agents = (state.project?.members ?? []).filter(({ actor }) => actor.kind === 'agent');
  if (!agents.length) return '<option value="">暂无 Agent 成员</option>';
  return agents
    .map(({ actor }) => `<option value="${esc(actor.name)}">${esc(actor.name)}</option>`)
    .join('');
}

function renderAutomationModal() {
  const eventOptions = HOOK_EVENTS
    .map((value) => `<option value="${esc(value)}" ${value === 'task.status_changed' ? 'selected' : ''}>${esc(EVENT_LABEL[value] ?? value)} · ${esc(value)}</option>`)
    .join('');
  modal.hidden = false;
  modal.innerHTML = `<div class="modal wide" role="dialog" aria-modal="true" aria-label="添加自动化">
    <div class="modal-head">
      <h2>添加自动化</h2>
      <button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button>
    </div>
    <form id="automation-form">
      <label class="field"><span>名称</span><input name="name" maxlength="120" required placeholder="例如：工作日晨间摘要"></label>
      <label class="field"><span>适用范围</span>
        <select name="scope" id="automation-scope">
          <option value="global">全局规则（项目内所有任务）</option>
          <option value="task">指定任务</option>
        </select>
      </label>
      <label class="field" data-scope="task" hidden><span>指定任务</span><select name="taskRef">${taskOptions(state.automationTasks, '')}</select></label>
      <div class="field-row">
        <label class="field"><span>触发方式</span>
          <select name="triggerType" id="automation-trigger-type">
            <option value="hook">事件（hook）</option>
            <option value="cron">定时（cron）</option>
          </select>
        </label>
        <label class="field"><span>动作</span>
          <select name="actionType" id="automation-action-type">
            <option value="enqueue_agent">派发 Agent Job</option>
            <option value="add_comment">添加评论</option>
            <option value="create_task">创建任务</option>
          </select>
        </label>
      </div>
      <div class="automation-fields" data-trigger="hook">
        <label class="field"><span>事件</span><select name="event">${eventOptions}</select></label>
        <label class="field"><span>过滤条件（JSON，可选）</span><input name="filter" placeholder='{"to":"done"}'></label>
      </div>
      <div class="automation-fields" data-trigger="cron" hidden>
        <div class="field-row">
          <label class="field"><span>Cron 表达式</span><input name="expression" value="0 9 * * 1-5" placeholder="0 9 * * 1-5"></label>
          <label class="field"><span>时区</span><input name="timezone" value="Asia/Shanghai" placeholder="Asia/Shanghai"></label>
        </div>
        <p class="hint">常用：每天 <code>0 9 * * *</code> · 工作日 <code>0 9 * * 1-5</code> · 每周一 <code>0 10 * * 1</code></p>
      </div>
      <div class="automation-fields" data-action-field="enqueue_agent">
        <div class="field-row">
          <label class="field"><span>Agent</span><select name="agent">${agentOptions()}</select></label>
          <label class="field"><span>Job 标题（可选）</span><input name="jobTitle" maxlength="200" placeholder="默认使用自动化名称"></label>
        </div>
        <label class="field"><span>Prompt</span><textarea name="prompt" rows="3" placeholder="支持 {{task.ref}}、{{project.name}} 等变量"></textarea></label>
      </div>
      <div class="automation-fields" data-action-field="add_comment" hidden>
        <label class="field"><span>评论内容</span><textarea name="body" rows="3" placeholder="支持 {{task.ref}}、{{actor.name}} 等变量"></textarea></label>
      </div>
      <div class="automation-fields" data-action-field="create_task" hidden>
        <label class="field"><span>任务标题</span><input name="taskTitle" maxlength="200" placeholder="新建任务的标题"></label>
        <label class="field"><span>描述（可选）</span><textarea name="taskDescription" rows="2"></textarea></label>
        <div class="field-row">
          <label class="field"><span>优先级</span><select name="taskPriority">${['low', 'medium', 'high', 'urgent'].map((priority) => `<option value="${priority}" ${priority === 'medium' ? 'selected' : ''}>${PRIORITY_LABEL[priority]}</option>`).join('')}</select></label>
          <label class="field"><span>负责人</span><select name="taskAssignee">${memberOptions('')}</select></label>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="ghost" data-action="close-modal">取消</button>
        <button type="submit" class="primary">创建自动化</button>
      </div>
    </form>
  </div>`;
  const form = modal.querySelector('#automation-form');
  if (form) syncAutomationForm(form);
  requestAnimationFrame(() => modal.querySelector('input[name="name"]')?.focus());
}

function syncAutomationForm(form) {
  const trigger = form.querySelector('[name="triggerType"]').value;
  const scope = form.querySelector('[name="scope"]').value;
  const scoped = scope === 'task';
  form.querySelectorAll('[data-scope="task"]').forEach((section) => {
    section.hidden = !scoped;
    section.querySelectorAll('input, select, textarea').forEach((field) => {
      field.disabled = !scoped;
    });
  });

  const actionSelect = form.querySelector('[name="actionType"]');
  const addComment = actionSelect.querySelector('option[value="add_comment"]');
  addComment.disabled = trigger === 'cron' && !scoped;
  if (addComment.disabled && actionSelect.value === 'add_comment') {
    actionSelect.value = 'enqueue_agent';
  }
  const action = actionSelect.value;

  form.querySelectorAll('[data-trigger]').forEach((section) => {
    const active = section.dataset.trigger === trigger;
    section.hidden = !active;
    section.querySelectorAll('input, select, textarea').forEach((field) => {
      field.disabled = !active;
    });
  });
  form.querySelectorAll('[data-action-field]').forEach((section) => {
    const active = section.dataset.actionField === action;
    section.hidden = !active;
    section.querySelectorAll('input, select, textarea').forEach((field) => {
      field.disabled = !active;
    });
  });
}

function renderDeleteAutomationModal() {
  const target = state.pendingAutomationDelete;
  if (!target) {
    closeModal();
    return;
  }
  modal.hidden = false;
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="删除自动化">
    <div class="modal-head">
      <h2>删除自动化</h2>
      <button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button>
    </div>
    <p class="confirm-copy">确定删除「<strong>${esc(target.name)}</strong>」？运行记录会一并删除，此操作不可撤销。</p>
    <div class="modal-actions">
      <button type="button" class="ghost" data-action="close-modal">取消</button>
      <button type="button" class="primary danger" data-action="confirm-delete-automation">删除</button>
    </div>
  </div>`;
  requestAnimationFrame(() => modal.querySelector('[data-action="confirm-delete-automation"]')?.focus());
}

function renderDeleteGroupModal() {
  const target = state.pendingGroupDelete;
  if (!target) {
    closeModal();
    return;
  }
  const moveCopy = target.count > 0
    ? `组内 ${target.count} 个任务会自动移入「未分组」，不会被删除。`
    : '该任务组当前没有任务。';
  modal.hidden = false;
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="删除任务组">
    <div class="modal-head">
      <h2>删除任务组</h2>
      <button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button>
    </div>
    <p class="confirm-copy">确定删除「<strong>${esc(target.name)}</strong>」？${moveCopy}此操作不可撤销。</p>
    <div class="modal-actions">
      <button type="button" class="ghost" data-action="close-modal">取消</button>
      <button type="button" class="primary danger" data-action="confirm-delete-group">删除</button>
    </div>
  </div>`;
  requestAnimationFrame(() => modal.querySelector('[data-action="confirm-delete-group"]')?.focus());
}

function renderAssigneesModal() {
  const task = state.openTask;
  if (!task) {
    closeModal();
    return;
  }
  const selected = (task.assignees ?? (task.assignee ? [task.assignee] : [])).map((assigned) => assigned.id);
  modal.hidden = false;
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="编辑负责人">
    <div class="modal-head">
      <h2>编辑负责人 · ${esc(task.ref)}</h2>
      <button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button>
    </div>
    <form id="assignee-form">
      <p class="hint">勾选加入，取消勾选移除。Agent 名称以「Agent」结尾时会自动生成自动评审规则。</p>
      <div class="check-grid">${memberChecks(selected)}</div>
      <div class="modal-actions">
        <button type="button" class="ghost" data-action="close-modal">取消</button>
        <button type="submit" class="primary">保存</button>
      </div>
    </form>
  </div>`;
}

function renderMemberModal() {
  const memberIds = new Set((state.project?.members ?? []).map((member) => member.actor.id));
  const available = (state.actors ?? []).filter((actor) => !memberIds.has(actor.id));
  if (!available.length) {
    closeModal();
    toast('所有人员都已在当前项目中', 'error');
    return;
  }
  const options = available
    .map((actor) => `<option value="${esc(actor.id)}" ${actor.id === state.pendingMemberPreselect ? 'selected' : ''}>${esc(actor.name)} · ${KIND_LABEL[actor.kind] ?? actor.kind}</option>`)
    .join('');
  modal.hidden = false;
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="添加成员">
    <div class="modal-head">
      <h2>添加成员</h2>
      <button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button>
    </div>
    <form id="member-form">
      <label class="field"><span>人员 / Agent</span><select name="actor">${options}</select></label>
      <label class="field"><span>项目角色</span>
        <select name="role">
          <option value="member">成员</option>
          <option value="owner">项目负责人</option>
        </select>
      </label>
      <label class="field"><span>角色标签（可选）</span><input name="roleTag" maxlength="40" placeholder="如：产品经理"></label>
      <p class="hint">项目负责人可以管理成员；角色标签描述该成员在本项目中的职责分工，与职位不同，每个项目最多一个。</p>
      <div class="modal-actions">
        <button type="button" class="ghost" data-action="close-modal">取消</button>
        <button type="submit" class="primary">加入项目</button>
      </div>
    </form>
  </div>`;
}

function renderRemoveMemberModal() {
  const target = state.pendingMemberRemove;
  if (!target) {
    closeModal();
    return;
  }
  modal.hidden = false;
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="移除成员">
    <div class="modal-head">
      <h2>移除成员</h2>
      <button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button>
    </div>
    <p class="confirm-copy">确定将「<strong>${esc(target.name)}</strong>」移出当前项目？如果该成员仍负责任务，需要先取消任务指派。</p>
    <div class="modal-actions">
      <button type="button" class="ghost" data-action="close-modal">取消</button>
      <button type="button" class="primary danger" data-action="confirm-remove-member">移除</button>
    </div>
  </div>`;
  requestAnimationFrame(() => modal.querySelector('[data-action="confirm-remove-member"]')?.focus());
}

function openMemberModal(actorId = '') {
  state.modal = 'member';
  state.pendingMemberPreselect = actorId;
  state.pendingMemberRemove = null;
  state.editingActor = null;
  renderModal();
  syncLayers();
}

function openActorModal(actorId = '') {
  state.editingActor = actorId ? (state.actors ?? []).find((actor) => actor.id === actorId) ?? null : null;
  state.actorMemberships = null;
  state.actorRoleProject = '';
  state.actorRoleDrafts = null;
  state.modal = 'actor';
  state.pendingMemberRemove = null;
  renderModal();
  syncLayers();
  if (state.editingActor) void loadActorMemberships(state.editingActor);
}

async function loadActorMemberships(actor) {
  try {
    const memberships = await api('GET', `/actors/${encodeURIComponent(actor.id)}/memberships`);
    if (state.modal !== 'actor' || state.editingActor?.id !== actor.id) return;
    state.actorMemberships = memberships;
    state.actorRoleDrafts = Object.fromEntries(
      memberships.map((membership) => [membership.project.key, membership.roleTag ?? '']),
    );
    if (!memberships.some((membership) => membership.project.key === state.actorRoleProject)) {
      state.actorRoleProject = memberships[0]?.project.key ?? '';
    }
    renderModal();
    syncLayers();
  } catch (error) {
    if (state.modal !== 'actor' || state.editingActor?.id !== actor.id) return;
    state.actorMemberships = [];
    state.actorRoleDrafts = {};
    state.actorRoleProject = '';
    renderModal();
    syncLayers();
    if (error.status !== 401) toast(friendlyError(error), 'error');
  }
}

function actorRoleTagsHtml(actor) {
  const memberships = state.actorMemberships;
  if (memberships === null) {
    return `<div class="field actor-role-tags"><span>项目角色标签</span><p class="hint">正在加载项目…</p></div>`;
  }
  if (memberships.length === 0) {
    return `<div class="field actor-role-tags"><span>项目角色标签</span><p class="hint">你们还没有共同项目，暂时无法设置角色标签。</p></div>`;
  }
  const current =
    memberships.find((membership) => membership.project.key === state.actorRoleProject) ??
    memberships[0];
  const drafts = state.actorRoleDrafts ?? {};
  return `<div class="field actor-role-tags">
    <span>项目角色标签</span>
    <div class="actor-role-picker">
      <select data-role-tag-select aria-label="选择项目">
        ${memberships
          .map(
            (membership) => `<option value="${esc(membership.project.key)}" ${membership.project.key === current.project.key ? 'selected' : ''}>${esc(membership.project.name)} · ${esc(membership.project.key)}</option>`,
          )
          .join('')}
      </select>
      <input data-role-tag-input data-project="${esc(current.project.key)}" maxlength="40" value="${esc(drafts[current.project.key] ?? current.roleTag ?? '')}" placeholder="如：产品经理">
    </div>
    <p class="hint">每个项目最多一个标签，可留空；标签描述 ${esc(actor.name)} 在该项目中的职责分工，与职位不同。切换项目可分别编辑。</p>
  </div>`;
}

function renderActorModal() {
  const editing = state.editingActor;
  const kind = editing?.kind ?? 'human';
  modal.hidden = false;
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${editing ? '编辑人员' : '新建人员'}">
    <div class="modal-head">
      <h2>${editing ? `编辑 · ${esc(editing.name)}` : '新建人员 / Agent'}</h2>
      <button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">×</button>
    </div>
    <form id="actor-form">
      ${editing
        ? `<p class="hint">类型：${KIND_LABEL[editing.kind] ?? editing.kind}（创建后不可修改）</p>`
        : `<label class="field"><span>类型</span>
            <select name="kind" id="actor-kind">
              <option value="human">人员</option>
              <option value="agent">Agent</option>
            </select>
          </label>`}
      <label class="field"><span>名称</span><input name="name" maxlength="80" required value="${esc(editing?.name ?? '')}" placeholder="例如：Review Agent"></label>
      <label class="field"><span>职位 / 说明</span><input name="title" maxlength="120" value="${esc(editing?.title ?? '')}" placeholder="例如：项目运营 Agent"></label>
      ${editing ? actorRoleTagsHtml(editing) : ''}
      <label class="field" data-kind-field="agent" ${kind === 'agent' ? '' : 'hidden'}><span>WeKnora Agent ID</span><input name="externalAgentId" maxlength="120" value="${esc(editing?.externalAgentId ?? '')}" placeholder="留空则使用环境变量中的默认 Agent"></label>
      ${editing
        ? ''
        : `<label class="field"><span>加入当前项目</span>
            <select name="joinRole">
              <option value="member">作为成员加入</option>
              <option value="owner">作为项目负责人加入</option>
              <option value="skip">暂不加入</option>
            </select>
          </label>
          <label class="field"><span>当前项目角色标签（可选）</span><input name="joinRoleTag" maxlength="40" placeholder="如：产品经理"></label>`}
      <p class="hint">Agent 由管理员手动添加，无需 Token 登录；名称以「Agent」结尾会触发自动评审规则。</p>
      <div class="modal-actions">
        <button type="button" class="ghost" data-action="close-modal">取消</button>
        <button type="submit" class="primary">${editing ? '保存' : '创建'}</button>
      </div>
    </form>
  </div>`;
  requestAnimationFrame(() => modal.querySelector('input[name="name"]')?.focus());
}

function openRemoveMember(actorId, name) {
  if (!actorId) return;
  state.pendingMemberRemove = { id: actorId, name: name || '成员' };
  state.modal = 'remove-member';
  renderModal();
  syncLayers();
}

async function submitNewMember(form) {
  if (state.busy) return;
  const data = new FormData(form);
  const actor = String(data.get('actor') ?? '');
  const role = String(data.get('role') ?? 'member');
  const roleTag = String(data.get('roleTag') ?? '').trim();
  if (!actor) return;
  state.busy = true;
  setFormBusy(form, true);
  try {
    const members = await api('POST', `/projects/${encodeURIComponent(state.project.key)}/members`, { actor, role, roleTag: roleTag || null });
    state.project.members = members;
    closeModal();
    toast(role === 'owner' ? '已添加项目负责人' : '成员已加入项目');
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
  } finally {
    state.busy = false;
    if (form.isConnected) setFormBusy(form, false);
  }
}

async function submitActor(form) {
  if (state.busy) return;
  const data = new FormData(form);
  const value = (name) => String(data.get(name) ?? '').trim();
  const name = value('name');
  if (!name) return;
  const editing = state.editingActor;
  const kind = editing?.kind ?? value('kind');
  const payload = { name, title: value('title') || null };
  if (kind === 'agent') payload.externalAgentId = value('externalAgentId') || null;
  state.busy = true;
  setFormBusy(form, true);
  try {
    if (editing) {
      await api('PATCH', `/actors/${encodeURIComponent(editing.id)}`, payload);
      const tagInput = form.querySelector('[data-role-tag-input]');
      if (tagInput) {
        state.actorRoleDrafts = {
          ...(state.actorRoleDrafts ?? {}),
          [tagInput.dataset.project]: tagInput.value,
        };
      }
      const drafts = state.actorRoleDrafts ?? {};
      let roleTagsChanged = false;
      for (const membership of state.actorMemberships ?? []) {
        const next = String(drafts[membership.project.key] ?? membership.roleTag ?? '').trim();
        if (next === (membership.roleTag ?? '')) continue;
        await api('PATCH', `/projects/${encodeURIComponent(membership.project.key)}/members/${encodeURIComponent(editing.id)}`, {
          roleTag: next || null,
        });
        roleTagsChanged = true;
      }
      closeModal();
      toast(roleTagsChanged ? '人员信息与角色标签已更新' : '人员信息已更新');
    } else {
      const created = await api('POST', '/actors', { ...payload, kind });
      const joinRole = value('joinRole');
      if (joinRole && joinRole !== 'skip') {
        await api('POST', `/projects/${encodeURIComponent(state.project.key)}/members`, {
          actor: created.id,
          role: joinRole,
          roleTag: value('joinRoleTag') || null,
        });
      }
      closeModal();
      toast(`${kind === 'agent' ? 'Agent' : '人员'}「${created.name}」已创建${joinRole && joinRole !== 'skip' ? '并加入项目' : ''}`);
    }
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
  } finally {
    state.busy = false;
    if (form.isConnected) setFormBusy(form, false);
  }
}

async function removeMember() {
  const target = state.pendingMemberRemove;
  if (!target || state.busy) return;
  const button = modal.querySelector('[data-action="confirm-remove-member"]');
  if (button) {
    button.disabled = true;
    button.textContent = '移除中…';
  }
  state.busy = true;
  try {
    await api('DELETE', `/projects/${encodeURIComponent(state.project.key)}/members/${encodeURIComponent(target.id)}`);
    closeModal();
    toast(`已移除 ${target.name}`);
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = '移除';
    }
  } finally {
    state.busy = false;
  }
}

function syncLayers() {
  const drawerOpen = Boolean(state.openTaskRef);
  overlay.hidden = !drawerOpen;
  drawer.hidden = !drawerOpen;
  modal.hidden = !state.modal;
  document.body.classList.toggle('locked', drawerOpen || Boolean(state.modal));
}

function setView(view) {
  if (!VIEWS.has(view)) return;
  if (!state.projectKey) {
    navigate(UI_ROOT);
    return;
  }
  navigate(projectPath(state.projectKey, view));
}

function setBoardMode(mode) {
  if (mode !== 'groups' && mode !== 'focus') return;
  if (state.boardMode === mode) return;
  state.boardMode = mode;
  localStorage.setItem(STORAGE_BOARD_MODE, mode);
  render();
}

function toggleBoardFilesFilter() {
  state.boardHasFiles = !state.boardHasFiles;
  render();
}

function selectFocusGroup(key) {
  if (!key) return;
  state.focusGroupId = key;
  if (state.projectKey) {
    localStorage.setItem(focusGroupStorageKey(state.projectKey), key);
  }
  const list = document.querySelector('.focus-group-list');
  const scrollTop = list?.scrollTop ?? 0;
  render();
  const nextList = document.querySelector('.focus-group-list');
  if (nextList) nextList.scrollTop = scrollTop;
  const active = [...document.querySelectorAll('.focus-group-item')].find(
    (item) => item.dataset.group === key,
  );
  active?.focus({ preventScroll: true });
}

function switchProject(key) {
  if (!key) return;
  if (key === state.projectKey && state.page === 'project') return;
  navigate(projectPath(key, 'board'));
}

async function refreshAll() {
  if (state.page === 'me') {
    await loadMyTasks({ silent: true });
    return;
  }
  if (state.page === 'task') {
    if (state.openTaskRef) await loadDetail(state.openTaskRef, { silent: true });
    return;
  }
  if (!state.projectKey) return;
  const detail = state.openTaskRef ? loadDetail(state.openTaskRef, { silent: true }) : Promise.resolve();
  await Promise.all([refreshProject(), detail]);
}

async function updateTaskTime(field, value) {
  const task = state.openTask;
  if (!task || state.busy) return;
  if (field === 'startAt' && !value) {
    renderDrawer();
    return;
  }
  const iso = value ? new Date(value).toISOString() : null;
  const current = field === 'startAt' ? task.startAt : task.dueAt;
  const currentMinute = current ? Math.floor(new Date(current).getTime() / 60_000) : null;
  const nextMinute = iso ? Math.floor(new Date(iso).getTime() / 60_000) : null;
  if (currentMinute === nextMinute) return;
  state.busy = true;
  try {
    const updated = await api('PATCH', `/tasks/${encodeURIComponent(task.ref)}`, {
      [field]: iso,
      version: task.version,
    });
    state.openTask = updated;
    renderDrawer();
    toast(field === 'startAt' ? '开始时间已更新' : '截止时间已更新');
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
    if (error.code === 'version_conflict') {
      await loadDetail(task.ref, { silent: true });
    } else {
      renderDrawer();
    }
  } finally {
    state.busy = false;
  }
}

async function updateStatus(status) {
  const task = state.openTask;
  if (!task || state.busy || task.status === status) return;
  state.busy = true;
  try {
    const updated = await api('PATCH', `/tasks/${encodeURIComponent(task.ref)}`, { status, version: task.version });
    state.openTask = updated;
    renderDrawer();
    toast(`已移动到「${STATUS_LABEL[status]}」`);
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    if (error.code === 'dependency_blocked') {
      const unmet = error.details?.unmet ?? [];
      const refs = unmet.map((item) => `${item.task.ref}（${item.requirement === 'done' ? '未完成' : '未开始'}）`);
      toast(refs.length > 0 ? `依赖未满足：${refs.join('、')}` : friendlyError(error), 'error');
      state.dependenciesOpen = true;
      renderDrawer();
      return;
    }
    toast(friendlyError(error), 'error');
    if (error.code === 'version_conflict' || error.code === 'subtasks_incomplete') {
      await loadDetail(task.ref, { silent: true });
    }
  } finally {
    state.busy = false;
  }
}

async function submitDependency(form) {
  const task = state.openTask;
  if (!task || state.busy) return;
  const taskRef = form.querySelector('select[name="task"]').value;
  const type = form.querySelector('select[name="type"]').value;
  const direction = form.dataset.direction;
  if (!taskRef || !direction) return;
  state.busy = true;
  setFormBusy(form, true);
  try {
    const updated = await api('POST', `/tasks/${encodeURIComponent(task.ref)}/dependencies`, {
      task: taskRef,
      direction,
      type,
    });
    state.openTask = updated;
    state.dependenciesOpen = true;
    renderDrawer();
    toast(direction === 'predecessor' ? '已添加前置任务' : '已添加后置任务');
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
    if (error.code === 'dependency_cycle') await loadDetail(task.ref, { silent: true });
  } finally {
    state.busy = false;
    if (form.isConnected) setFormBusy(form, false);
  }
}

async function removeDependency(id) {
  const task = state.openTask;
  if (!task || !id || state.busy) return;
  state.busy = true;
  try {
    await api('DELETE', `/tasks/${encodeURIComponent(task.ref)}/dependencies/${encodeURIComponent(id)}`);
    toast('依赖已移除');
    await Promise.all([loadDetail(task.ref, { silent: true }), refreshProject()]);
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
  } finally {
    state.busy = false;
  }
}

function openAssigneeModal() {
  if (!state.openTask) return;
  state.modal = 'assignees';
  state.pendingAutomationDelete = null;
  renderModal();
  syncLayers();
}

async function submitAssignees(form) {
  const task = state.openTask;
  if (!task || state.busy) return;
  const before = new Set((task.assignees ?? []).map((assigned) => assigned.id));
  const assignees = [...form.querySelectorAll('input[name="assignees"]:checked')].map((input) => input.value);
  state.busy = true;
  setFormBusy(form, true);
  try {
    const updated = await api('PATCH', `/tasks/${encodeURIComponent(task.ref)}`, {
      assignees,
      version: task.version,
    });
    state.openTask = updated;
    closeModal();
    renderDrawer();
    const autoAgent = (updated.assignees ?? []).find(
      (assigned) =>
        !before.has(assigned.id) &&
        assigned.kind === 'agent' &&
        assigned.name.trim().toLowerCase().endsWith('agent'),
    );
    toast(autoAgent ? `已添加 ${autoAgent.name}，并自动生成 Agent 评审规则` : '负责人已更新');
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
    if (error.code === 'version_conflict') await loadDetail(task.ref, { silent: true });
  } finally {
    state.busy = false;
    if (form.isConnected) setFormBusy(form, false);
  }
}

async function submitComment(form) {
  if (state.busy) return;
  const textarea = form.querySelector('textarea[name="body"]');
  const body = textarea.value.trim();
  if (!body) return;
  const ref = form.dataset.ref;
  state.busy = true;
  setFormBusy(form, true);
  try {
    await api('POST', `/tasks/${encodeURIComponent(ref)}/comments`, { body });
    textarea.value = '';
    state.commentDraft = null;
    toast('评论已发送');
    await Promise.all([loadDetail(ref, { silent: true }), refreshProject()]);
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
  } finally {
    state.busy = false;
    if (form.isConnected) setFormBusy(form, false);
  }
}

function submitFile(form) {
  const input = form.querySelector('input[type="file"]');
  const file = input?.files?.[0];
  if (!file || state.upload) return;
  const ref = form.dataset.ref;
  if (!ref || state.openTaskRef !== ref) return;
  const maxBytes = Number(state.fileLimits.maxUploadBytes) || 0;
  if (maxBytes && file.size > maxBytes) {
    toast(`文件超过 ${formatBytes(maxBytes)} 上限`, 'error');
    input.value = '';
    return;
  }
  const body = new FormData();
  body.append('file', file, file.name);
  state.upload = { ref, name: file.name, percent: 0 };
  renderDrawer();
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/v1/tasks/${encodeURIComponent(ref)}/files`);
  xhr.setRequestHeader('authorization', `Bearer ${state.token}`);
  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable || !state.upload || state.upload.ref !== ref) return;
    state.upload.percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
    const holder = drawer.querySelector('[data-progress]');
    const bar = holder?.querySelector('.bar');
    const label = holder?.querySelector('.label');
    if (bar) bar.style.width = `${state.upload.percent}%`;
    if (label) label.textContent = `${state.upload.name} · ${state.upload.percent}%`;
  };
  xhr.onload = async () => {
    state.upload = null;
    if (xhr.status >= 200 && xhr.status < 300) {
      toast('附件已上传');
      await loadDetail(ref, { silent: true });
      return;
    }
    if (xhr.status === 401) {
      logout();
      return;
    }
    let message = `上传失败 (${xhr.status})`;
    try {
      message = JSON.parse(xhr.responseText)?.error?.message || message;
    } catch {
      // Keep the generic message for non-JSON failures.
    }
    renderDrawer();
    toast(message, 'error');
  };
  xhr.onerror = () => {
    state.upload = null;
    renderDrawer();
    toast('上传失败，请检查网络连接', 'error');
  };
  xhr.send(body);
}

async function downloadFile(id, name) {
  if (!id) return;
  try {
    const response = await fetch(`/api/v1/files/${encodeURIComponent(id)}/download`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    if (!response.ok) {
      if (response.status === 401) {
        logout();
        return;
      }
      const payload = await response.json().catch(() => null);
      throw new ApiError(
        payload?.error?.message || `下载失败 (${response.status})`,
        payload?.error?.code,
        response.status,
      );
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name || 'attachment';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast(friendlyError(error), 'error');
  }
}

async function deleteFile(id, name) {
  const ref = state.openTaskRef;
  if (!ref || !id) return;
  if (!window.confirm(`确定删除附件「${name}」？此操作不可撤销。`)) return;
  try {
    await api('DELETE', `/tasks/${encodeURIComponent(ref)}/files/${encodeURIComponent(id)}`);
    toast('附件已删除');
    await loadDetail(ref, { silent: true });
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
  }
}

async function requestAiSuggestion(ref) {
  if (!ref || state.aiSuggestion?.ref === ref) return;
  state.aiSuggestion = { ref, jobId: null };
  renderDrawer();
  try {
    const job = await api('POST', `/tasks/${encodeURIComponent(ref)}/ai-suggestion`, {});
    if (!state.aiSuggestion || state.aiSuggestion.ref !== ref) return;
    state.aiSuggestion = { ref, jobId: job.id };
    renderDrawer();
    toast('AI 建议已提交，Agent 正在生成…');
    void pollAiSuggestion(job.id, ref);
  } catch (error) {
    if (state.aiSuggestion?.ref === ref) state.aiSuggestion = null;
    renderDrawer();
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
  }
}

async function pollAiSuggestion(jobId, ref) {
  const startedAt = Date.now();
  while (state.aiSuggestion?.jobId === jobId) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (state.aiSuggestion?.jobId !== jobId) return;
    try {
      const job = await api('GET', `/jobs/${encodeURIComponent(jobId)}`);
      if (job.status === 'done') {
        state.aiSuggestion = null;
        toast('AI 建议已作为评论发送');
        await Promise.all([loadDetail(ref, { silent: true }), refreshProject()]);
        return;
      }
      if (job.status === 'failed') {
        state.aiSuggestion = null;
        renderDrawer();
        toast(job.result || 'AI 建议生成失败', 'error');
        return;
      }
    } catch (error) {
      state.aiSuggestion = null;
      renderDrawer();
      if (error.status === 401) {
        logout();
        return;
      }
      toast(friendlyError(error), 'error');
      return;
    }
    if (Date.now() - startedAt > 120000) {
      state.aiSuggestion = null;
      renderDrawer();
      toast('AI 建议生成超时，请稍后刷新任务', 'error');
      return;
    }
  }
}

async function submitConnect(form) {
  const token = form.querySelector('input[name="token"]').value.trim();
  if (!token) return;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = '连接中…';
  const previous = state.token;
  state.token = token;
  try {
    state.actor = await api('GET', '/me');
    localStorage.setItem(STORAGE_TOKEN, token);
    await loadWorkspace();
  } catch (error) {
    state.token = previous;
    state.actor = null;
    localStorage.removeItem(STORAGE_TOKEN);
    button.disabled = false;
    button.textContent = '连接';
    renderConnect(error.status === 401 ? 'Token 无效，请检查后重试。' : error.message);
  }
}

async function submitNewTask(form) {
  if (state.busy) return;
  const data = new FormData(form);
  const title = String(data.get('title') ?? '').trim();
  if (!title) return;
  const payload = {
    title,
    kind: String(data.get('kind') ?? 'task'),
    priority: String(data.get('priority') ?? 'medium'),
    assignees: data.getAll('assignees').map(String),
    parent: String(data.get('parent') ?? '') || null,
  };
  const description = String(data.get('description') ?? '').trim();
  if (description) payload.description = description;
  const group = String(data.get('group') ?? '');
  if (group) payload.group = group;
  state.busy = true;
  setFormBusy(form, true);
  try {
    const created = await api('POST', `/projects/${encodeURIComponent(state.project.key)}/tasks`, payload);
    const parentRef = payload.parent;
    const currentRef = state.openTask?.ref ?? null;
    closeModal();
    toast(`已创建 ${created.ref}`);
    await refreshProject();
    if (parentRef && parentRef === currentRef) {
      await loadDetail(currentRef, { silent: true });
    } else {
      openTask(created.ref);
    }
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
  } finally {
    state.busy = false;
    if (form.isConnected) setFormBusy(form, false);
  }
}

async function submitGroup(form) {
  if (state.busy) return;
  const editing = state.groupEdit;
  const data = new FormData(form);
  const name = String(data.get('name') ?? '').trim();
  if (!name) return;
  const description = String(data.get('description') ?? '').trim();
  const payload = { name };
  if (editing) payload.description = description;
  else if (description) payload.description = description;
  state.busy = true;
  setFormBusy(form, true);
  try {
    await api(
      editing ? 'PATCH' : 'POST',
      editing ? `/groups/${encodeURIComponent(editing.id)}` : `/projects/${encodeURIComponent(state.project.key)}/groups`,
      payload,
    );
    closeModal();
    toast(editing ? `已更新任务组「${name}」` : `已创建任务组「${name}」`);
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
  } finally {
    state.busy = false;
    if (form.isConnected) setFormBusy(form, false);
  }
}

async function submitProjectInfo(form) {
  const project = state.project;
  if (!project || state.busy) return;
  const data = new FormData(form);
  const name = String(data.get('name') ?? '').trim();
  const key = String(data.get('key') ?? '').trim().toUpperCase();
  const description = String(data.get('description') ?? '').trim();
  if (!name || !key) return;
  if (name === project.name && key === project.key && description === (project.description ?? '')) {
    closeModal();
    return;
  }
  state.busy = true;
  setFormBusy(form, true);
  try {
    const updated = await api('PATCH', `/projects/${encodeURIComponent(project.key)}`, {
      name,
      key,
      description,
    });
    state.projects = state.projects.map((entry) =>
      entry.id === updated.id
        ? { ...entry, name: updated.name, key: updated.key, description: updated.description }
        : entry,
    );
    if (updated.key !== project.key) {
      closeModal();
      toast(`项目代号已改为 ${updated.key}`);
      await navigate(projectPath(updated.key, state.view), { replace: true });
      return;
    }
    state.project = updated;
    closeModal();
    toast('项目信息已更新');
    render();
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
  } finally {
    state.busy = false;
    if (form.isConnected) setFormBusy(form, false);
  }
}

async function submitNewProject(form) {
  if (state.busy) return;
  const data = new FormData(form);
  const name = String(data.get('name') ?? '').trim();
  const key = String(data.get('key') ?? '').trim().toUpperCase();
  const description = String(data.get('description') ?? '').trim();
  if (!name || !key) return;
  state.busy = true;
  setFormBusy(form, true);
  try {
    const created = await api('POST', '/projects', { name, key, description });
    state.projects = await api('GET', '/projects');
    closeModal();
    toast(`项目 ${created.key} 已创建`);
    await navigate(projectPath(created.key, 'board'));
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
  } finally {
    state.busy = false;
    if (form.isConnected) setFormBusy(form, false);
  }
}

async function saveTaskDescription(form) {
  const task = state.openTask;
  if (!task || state.busy) return;
  const description = String(new FormData(form).get('description') ?? '').trim();
  if (description === (task.description ?? '')) {
    state.descriptionEditing = false;
    state.descriptionDraft = null;
    renderDrawer();
    return;
  }
  state.busy = true;
  setFormBusy(form, true);
  try {
    const updated = await api('PATCH', `/tasks/${encodeURIComponent(task.ref)}`, {
      description,
      version: task.version,
    });
    state.openTask = updated;
    state.descriptionEditing = false;
    state.descriptionDraft = null;
    toast('任务说明已更新');
    renderDrawer();
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
    if (error.code === 'version_conflict') {
      state.descriptionEditing = false;
      state.descriptionDraft = null;
      await loadDetail(task.ref, { silent: true });
    }
  } finally {
    state.busy = false;
    if (form.isConnected) setFormBusy(form, false);
  }
}

function parseAutomationFilter(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('过滤条件必须是合法的 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('过滤条件必须是 JSON 对象');
  }
  for (const value of Object.values(parsed)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error('过滤条件的值只能是字符串、数字或布尔');
    }
  }
  return parsed;
}

async function submitNewAutomation(form) {
  if (state.busy) return;
  const data = new FormData(form);
  const value = (name) => String(data.get(name) ?? '').trim();

  const name = value('name');
  if (!name) {
    toast('请填写自动化名称', 'error');
    return;
  }

  const scope = value('scope');
  const task = scope === 'task' ? value('taskRef') : null;
  if (scope === 'task' && !task) {
    toast('请选择指定任务', 'error');
    return;
  }

  const triggerType = value('triggerType');
  let trigger;
  if (triggerType === 'cron') {
    const expression = value('expression');
    if (!expression) {
      toast('请填写 cron 表达式', 'error');
      return;
    }
    trigger = {
      type: 'cron',
      expression,
      timezone: value('timezone') || 'Asia/Shanghai',
    };
  } else {
    try {
      trigger = {
        type: 'hook',
        event: value('event'),
        filter: parseAutomationFilter(value('filter')),
      };
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
  }

  const actionType = value('actionType');
  let action;
  if (actionType === 'add_comment') {
    const body = value('body');
    if (!body) {
      toast('请填写评论内容', 'error');
      return;
    }
    action = { type: 'add_comment', config: { body } };
  } else if (actionType === 'create_task') {
    const title = value('taskTitle');
    if (!title) {
      toast('请填写任务标题', 'error');
      return;
    }
    const config = { title, priority: value('taskPriority') || 'medium' };
    const description = value('taskDescription');
    if (description) config.description = description;
    const assignee = value('taskAssignee');
    if (assignee) config.assignee = assignee;
    action = { type: 'create_task', config };
  } else {
    const agent = value('agent');
    const prompt = value('prompt');
    if (!agent || !prompt) {
      toast('请选择 Agent 并填写 Prompt', 'error');
      return;
    }
    const config = { agent, prompt };
    const title = value('jobTitle');
    if (title) config.title = title;
    action = { type: 'enqueue_agent', config };
  }

  state.busy = true;
  setFormBusy(form, true);
  try {
    await api('POST', `/projects/${encodeURIComponent(state.project.key)}/automations`, {
      name,
      task,
      trigger,
      action,
    });
    closeModal();
    toast(`已创建自动化「${name}」`);
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
  } finally {
    state.busy = false;
    if (form.isConnected) setFormBusy(form, false);
  }
}

async function deleteAutomation() {
  const target = state.pendingAutomationDelete;
  if (!target || state.busy) return;
  const button = modal.querySelector('[data-action="confirm-delete-automation"]');
  if (button) {
    button.disabled = true;
    button.textContent = '删除中…';
  }
  state.busy = true;
  try {
    await api('DELETE', `/automations/${encodeURIComponent(target.id)}`);
    closeModal();
    toast(`已删除「${target.name}」`);
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = '删除';
    }
  } finally {
    state.busy = false;
  }
}

async function deleteTaskGroup() {
  const target = state.pendingGroupDelete;
  if (!target || state.busy) return;
  const button = modal.querySelector('[data-action="confirm-delete-group"]');
  if (button) {
    button.disabled = true;
    button.textContent = '删除中…';
  }
  state.busy = true;
  try {
    await api('DELETE', `/groups/${encodeURIComponent(target.id)}`);
    if (state.focusGroupId === target.id) {
      state.focusGroupId = null;
      if (state.projectKey) localStorage.removeItem(focusGroupStorageKey(state.projectKey));
    }
    closeModal();
    toast(`已删除任务组「${target.name}」，组内任务已移入未分组`);
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = '删除';
    }
  } finally {
    state.busy = false;
  }
}

async function runAutomation(id) {
  if (!id || state.busy) return;
  state.busy = true;
  try {
    const run = await api('POST', `/automations/${encodeURIComponent(id)}/run`);
    toast(run.status === 'success' ? '自动化已执行' : '自动化执行未成功', run.status === 'success' ? 'info' : 'error');
    await refreshProject();
  } catch (error) {
    if (error.status === 401) {
      logout();
      return;
    }
    toast(friendlyError(error), 'error');
  } finally {
    state.busy = false;
  }
}

const FRIENDLY = {
  subtasks_incomplete: '请先完成所有子任务',
  dependency_blocked: '前置依赖未满足，暂时不能推进状态',
  version_conflict: '任务已被其他人更新，已刷新最新状态',
  job_assigned_elsewhere: '该 Agent 任务已分配给其他成员',
  ai_suggestion_in_progress: '该任务已有 AI 建议正在生成，请稍候',
  dependency_exists: '这两项任务之间已经存在依赖',
  dependency_cycle: '该依赖会形成循环，无法添加',
  parent_done: '不能在已完成的任务下创建子任务',
  unauthorized: 'Token 无效或已过期',
  validation_error: '请检查表单内容是否完整、格式是否正确',
  actor_name_taken: '该名称已存在，请换一个名称',
  project_key_taken: '该代号已被占用，请换一个代号',
  member_assigned: '该成员仍负责任务，请先在任务中取消指派',
  last_owner: '项目至少需要保留一名负责人',
};

function friendlyError(error) {
  return FRIENDLY[error.code] || error.message || '操作失败';
}

function setFormBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = busy;
}

let toastTimer;
function toast(message, tone = 'info') {
  toastEl.textContent = message;
  toastEl.className = `toast show${tone === 'error' ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 3200);
}

function logout() {
  navigationSeq += 1;
  stopLiveStream();
  stopPresencePolling();
  localStorage.removeItem(STORAGE_TOKEN);
  localStorage.removeItem(STORAGE_PROJECT);
  Object.assign(state, {
    token: '',
    actor: null,
    weknoraUiUrl: '',
    citationKnowledge: {},
    projects: [],
    projectKey: null,
    project: null,
    board: null,
    activity: [],
    automations: [],
    jobs: [],
    actors: [],
    notifications: [],
    notificationsUnread: 0,
    notificationsOpen: false,
    onlineActors: [],
    presenceOpen: false,
    commentDraft: null,
    lastEventId: 0,
    liveConnected: false,
    page: 'project',
    view: 'board',
    myTasks: null,
    myTasksScope: 'related',
    myTasksStatus: '',
    myTasksKind: '',
    myTasksQuery: '',
    loading: false,
    error: null,
    openTaskRef: null,
    openTask: null,
    openTaskLoading: false,
    descriptionEditing: false,
    descriptionDraft: null,
    upload: null,
    taskParentPreset: null,
    modal: null,
    pendingAutomationDelete: null,
    pendingGroupDelete: null,
    pendingMemberRemove: null,
    pendingMemberPreselect: '',
    editingActor: null,
    actorMemberships: null,
    actorRoleProject: '',
    actorRoleDrafts: null,
    automationTasks: [],
    busy: false,
  });
  drawer.hidden = true;
  drawer.innerHTML = '';
  modal.hidden = true;
  modal.innerHTML = '';
  overlay.hidden = true;
  document.body.classList.remove('locked');
  renderConnect('已断开连接，输入 Token 重新开始。');
}

document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[data-link]');
  if (
    link &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !(event.button > 0)
  ) {
    event.preventDefault();
    if (link.dataset.groupFocus) {
      state.boardMode = 'focus';
      localStorage.setItem(STORAGE_BOARD_MODE, 'focus');
      state.focusGroupId = link.dataset.groupFocus;
      if (state.projectKey) {
        localStorage.setItem(focusGroupStorageKey(state.projectKey), link.dataset.groupFocus);
      }
    }
    navigate(link.getAttribute('href'));
    return;
  }
  if (event.target === modal) {
    closeModal();
    return;
  }
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  switch (action) {
    case 'retry-boot':
      init();
      break;
    case 'refresh':
      refreshAll();
      break;
    case 'my-scope':
      setMyTasksScope(target.dataset.scope);
      break;
    case 'my-stat':
      setMyTasksStatus(target.dataset.status ?? '');
      break;
    case 'logout':
      logout();
      break;
    case 'home':
      navigate(state.projectKey ? projectPath(state.projectKey, 'board') : UI_ROOT);
      break;
    case 'view':
      setView(target.dataset.view);
      break;
    case 'board-mode':
      setBoardMode(target.dataset.mode);
      break;
    case 'board-files-filter':
      toggleBoardFilesFilter();
      break;
    case 'focus-group':
      selectFocusGroup(target.dataset.group);
      break;
    case 'open-task':
      openTask(target.dataset.ref);
      break;
    case 'close-drawer':
      dismissTask();
      break;
    case 'new-task':
      openTaskModal();
      break;
    case 'new-subtask':
      openTaskModal({
        ref: target.dataset.parent ?? '',
        title: target.dataset.title ?? '',
        groupId: target.dataset.group ?? '',
      });
      break;
    case 'new-group':
      openGroupModal();
      break;
    case 'edit-group':
      openGroupModal(target.dataset.group);
      break;
    case 'delete-group':
      openDeleteGroup(target.dataset.group, target.dataset.name, target.dataset.count);
      break;
    case 'confirm-delete-group':
      deleteTaskGroup();
      break;
    case 'new-automation':
      openAutomationModal();
      break;
    case 'edit-assignees':
      openAssigneeModal();
      break;
    case 'new-project':
      openNewProjectModal();
      break;
    case 'edit-project':
      openProjectInfoModal();
      break;
    case 'edit-description':
      state.descriptionEditing = true;
      state.descriptionDraft = state.openTask?.description ?? '';
      renderDrawer();
      requestAnimationFrame(() => drawer.querySelector('#description-form textarea')?.focus());
      break;
    case 'cancel-description':
      state.descriptionEditing = false;
      state.descriptionDraft = null;
      renderDrawer();
      break;
    case 'new-actor':
      openActorModal();
      break;
    case 'edit-actor':
      openActorModal(target.dataset.actor);
      break;
    case 'add-member':
      openMemberModal(target.dataset.actor || '');
      break;
    case 'remove-member':
      openRemoveMember(target.dataset.actor, target.dataset.name);
      break;
    case 'confirm-remove-member':
      removeMember();
      break;
    case 'delete-automation':
      openDeleteAutomation(target.dataset.id, target.dataset.name);
      break;
    case 'confirm-delete-automation':
      deleteAutomation();
      break;
    case 'close-modal':
      closeModal();
      break;
    case 'set-status':
      updateStatus(target.dataset.status);
      break;
    case 'ai-suggestion':
      requestAiSuggestion(target.dataset.ref);
      break;
    case 'toggle-dependencies':
      state.dependenciesOpen = !state.dependenciesOpen;
      renderDrawer();
      break;
    case 'remove-dependency':
      removeDependency(target.dataset.id);
      break;
    case 'download-file':
      void downloadFile(target.dataset.id, target.dataset.name);
      break;
    case 'delete-file':
      void deleteFile(target.dataset.id, target.dataset.name);
      break;
    case 'run-automation':
      runAutomation(target.dataset.id);
      break;
    case 'toggle-notifications':
      state.notificationsOpen = !state.notificationsOpen;
      if (state.notificationsOpen) state.presenceOpen = false;
      render();
      if (state.notificationsOpen) void loadNotifications();
      break;
    case 'toggle-presence':
      state.presenceOpen = !state.presenceOpen;
      if (state.presenceOpen) state.notificationsOpen = false;
      render();
      if (state.presenceOpen) void loadPresence();
      break;
    case 'enable-browser-notifications':
      void enableBrowserNotifications();
      break;
    case 'notifications-read-all':
      void markNotificationsRead({});
      break;
    case 'open-notification':
      void openNotification(target.dataset.id, target.dataset.ref);
      break;
    case 'toggle-mention-picker':
      toggleMentionPicker();
      break;
    case 'pick-mention':
      insertMention(target.dataset.name);
      break;
    case 'insert-mention':
      insertMention(target.dataset.name);
      break;
    default:
      return;
  }
  event.preventDefault();
});

document.addEventListener('click', (event) => {
  if (!state.notificationsOpen && !state.presenceOpen) return;
  if (event.target.closest?.('.notify-wrap') || event.target.closest?.('.presence-wrap')) return;
  state.notificationsOpen = false;
  state.presenceOpen = false;
  render();
});

document.addEventListener('click', (event) => {
  if (event.target.closest?.('#mention-picker')) return;
  if (event.target.closest?.('[data-action="toggle-mention-picker"]')) return;
  closeMentionPicker();
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.id === 'my-task-filter') {
    setMyTasksQuery(target.value);
    return;
  }
  if (target.matches?.('#description-form textarea')) {
    state.descriptionDraft = target.value;
    return;
  }
  if (target.matches?.('#comment-form textarea')) {
    state.commentDraft = {
      ref: target.closest('form')?.dataset.ref ?? '',
      body: target.value,
    };
    syncMentionTokens(target);
    return;
  }
  if (target.matches?.('[data-mention-search]')) {
    filterMentionOptions(target.value);
  }
});

document.addEventListener('focusout', (event) => {
  if (!event.target.matches?.('#comment-form textarea')) return;
  setTimeout(applyPendingDrawerRefresh, 0);
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.id === 'project-select') {
    switchProject(target.value);
    return;
  }
  if (target.id === 'my-status-filter') {
    setMyTasksStatus(target.value);
    return;
  }
  if (target.id === 'my-kind-filter') {
    setMyTasksKind(target.value);
    return;
  }
  if (target.dataset?.taskTime) {
    void updateTaskTime(target.dataset.taskTime, target.value);
    return;
  }
  if (
    target.id === 'automation-trigger-type' ||
    target.id === 'automation-action-type' ||
    target.id === 'automation-scope'
  ) {
    const form = target.closest('#automation-form');
    if (form) syncAutomationForm(form);
    return;
  }
  if (target.matches?.('#file-form input[type="file"]')) {
    const form = target.closest('#file-form');
    if (form) submitFile(form);
    return;
  }
  if (target.matches?.('[data-role-tag-select]')) {
    const form = target.closest('#actor-form');
    const input = form?.querySelector('[data-role-tag-input]');
    if (!input) return;
    state.actorRoleDrafts = {
      ...(state.actorRoleDrafts ?? {}),
      [input.dataset.project]: input.value,
    };
    state.actorRoleProject = target.value;
    input.dataset.project = target.value;
    const membership = (state.actorMemberships ?? []).find((entry) => entry.project.key === target.value);
    input.value = state.actorRoleDrafts[target.value] ?? membership?.roleTag ?? '';
    return;
  }
  if (target.id === 'actor-kind') {
    const form = target.closest('#actor-form');
    if (form) {
      form.querySelectorAll('[data-kind-field="agent"]').forEach((section) => {
        section.hidden = target.value !== 'agent';
      });
    }
    return;
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (form.id === 'connect-form') {
    event.preventDefault();
    submitConnect(form);
  } else if (form.id === 'task-form') {
    event.preventDefault();
    submitNewTask(form);
  } else if (form.id === 'group-form') {
    event.preventDefault();
    submitGroup(form);
  } else if (form.id === 'new-project-form') {
    event.preventDefault();
    submitNewProject(form);
  } else if (form.id === 'project-info-form') {
    event.preventDefault();
    submitProjectInfo(form);
  } else if (form.id === 'description-form') {
    event.preventDefault();
    saveTaskDescription(form);
  } else if (form.id === 'automation-form') {
    event.preventDefault();
    submitNewAutomation(form);
  } else if (form.id === 'comment-form') {
    event.preventDefault();
    submitComment(form);
  } else if (form.id === 'file-form') {
    event.preventDefault();
    submitFile(form);
  } else if (form.classList.contains('dependency-form')) {
    event.preventDefault();
    submitDependency(form);
  } else if (form.id === 'assignee-form') {
    event.preventDefault();
    submitAssignees(form);
  } else if (form.id === 'member-form') {
    event.preventDefault();
    submitNewMember(form);
  } else if (form.id === 'actor-form') {
    event.preventDefault();
    submitActor(form);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.target.matches?.('[data-mention-search]') && event.key === 'Enter') {
    event.preventDefault();
    const first = [...document.querySelectorAll('#mention-picker .mention-option')].find(
      (option) => !option.hidden,
    );
    if (first) insertMention(first.dataset.name);
    return;
  }
  if (event.key === 'Escape' && document.querySelector('#mention-picker:not([hidden])')) {
    event.preventDefault();
    closeMentionPicker();
    return;
  }
  if (event.key === 'Escape') {
    if (state.modal) closeModal();
    else if (state.openTaskRef) dismissTask();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    const form = event.target.closest?.('#comment-form');
    if (form) {
      event.preventDefault();
      form.requestSubmit();
    }
  }
});

window.addEventListener('popstate', () => {
  closeModal();
  syncRoute();
});

init();
