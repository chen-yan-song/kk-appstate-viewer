/**
 * KK AppState Viewer 前端
 * 默认全自动；失败必须 showError 上屏。
 */
import { KakaoDB } from './kakaoDb.js';
import { parseMessage, renderMessageText, messageTypeInfo } from './messageParser.js';

const $ = (id) => document.getElementById(id);

const el = {
  pageError: $('pageError'),
  pageErrorText: $('pageErrorText'),
  pageErrorClose: $('pageErrorClose'),
  autoPanel: $('autoPanel'),
  autoSteps: $('autoSteps'),
  btnAutoRetry: $('btnAutoRetry'),
  btnAutoContinue: $('btnAutoContinue'),
  btnShowManual: $('btnShowManual'),
  btnBackAuto: $('btnBackAuto'),
  btnDiscover: $('btnDiscover'),
  btnSelftest: $('btnSelftest'),
  discoverMeta: $('discoverMeta'),
  accountList: $('accountList'),
  accountEmpty: $('accountEmpty'),
  rootInput: $('rootInput'),
  btnImportRootJson: $('btnImportRootJson'),
  btnImportKeysJson: $('btnImportKeysJson'),
  btnFindRoot: $('btnFindRoot'),
  btnStopFindRoot: $('btnStopFindRoot'),
  keyStatus: $('keyStatus'),
  findRootLog: $('findRootLog'),
  btnDecrypt: $('btnDecrypt'),
  progressArea: $('progressArea'),
  progressText: $('progressText'),
  warnList: $('warnList'),
  setup: $('setup'),
  viewer: $('viewer'),
  btnBack: $('btnBack'),
  viewerStats: $('viewerStats'),
  chatSearch: $('chatSearch'),
  searchBtn: $('searchBtn'),
  statsBar: $('statsBar'),
  chatList: $('chatList'),
  chatTitle: $('chatTitle'),
  chatMeta: $('chatMeta'),
  msgList: $('msgList'),
  msgEmpty: $('msgEmpty'),
  loadMoreBtn: $('loadMoreBtn'),
};

const state = {
  accounts: [],
  selected: null,
  importedKeys: {},
  rootHex: '',
  db: null,
  currentChatId: null,
  msgOffset: 0,
  lastAutoPayload: null, // 失败时保留 keys，便于「退出后续跑」
  autoRunning: false,
};

function api() {
  if (!window.kkApp) {
    throw new Error('未检测到 Electron 桥接（window.kkApp）。请用 npm start 启动');
  }
  return window.kkApp;
}

function showError(err, context = '') {
  const msg = err && err.message ? err.message : String(err || '未知错误');
  const full = context ? `${context}\n${msg}` : msg;
  console.error('[页面错误]', full);
  el.pageErrorText.textContent = full;
  el.pageError.hidden = false;
  try { el.pageError.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { /* ignore */ }
}

function clearError() {
  el.pageError.hidden = true;
  el.pageErrorText.textContent = '';
}

function setKeyStatus(text) {
  el.keyStatus.textContent = text || '';
}

function showWarnings(list) {
  el.warnList.innerHTML = '';
  if (!list || !list.length) {
    el.warnList.hidden = true;
    return;
  }
  for (const w of list) {
    const li = document.createElement('li');
    li.textContent = w;
    el.warnList.appendChild(li);
  }
  el.warnList.hidden = false;
}

function setAutoStep(name, status, detail) {
  const li = el.autoSteps.querySelector(`[data-step="${name}"]`);
  if (!li) return;
  li.classList.remove('active', 'ok', 'fail');
  if (status) li.classList.add(status);
  const d = li.querySelector('.step-detail');
  if (d) d.textContent = detail || '';
}

function resetAutoSteps() {
  for (const li of el.autoSteps.querySelectorAll('.auto-step')) {
    li.classList.remove('active', 'ok', 'fail');
    const d = li.querySelector('.step-detail');
    if (d) d.textContent = '';
  }
}

function updateDecryptEnabled() {
  const hasAccount = !!(state.selected && state.selected.dir);
  const hasRoot = /^[0-9a-fA-F]{64}$/.test((el.rootInput.value || '').trim());
  const hasKeys = Object.keys(state.importedKeys).length > 0;
  el.btnDecrypt.disabled = !(hasAccount && (hasRoot || hasKeys));
}

function setProgress(visible, text) {
  el.progressArea.hidden = !visible;
  if (text != null) el.progressText.textContent = text;
}

function showAuto() {
  el.autoPanel.hidden = false;
  el.setup.hidden = true;
  el.viewer.hidden = true;
}

function showManual() {
  el.autoPanel.hidden = true;
  el.setup.hidden = false;
  el.viewer.hidden = true;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 全自动主流程 */
async function runAutoFlow(opts = {}) {
  if (state.autoRunning) return;
  state.autoRunning = true;
  clearError();
  showWarnings([]);
  resetAutoSteps();
  el.btnAutoContinue.hidden = true;
  showAuto();

  try {
    api().onAutoProgress((p) => {
      setAutoStep(p.step, p.state === 'ok' || p.state === 'fail' ? p.state : 'active', p.detail);
    });

    // 若上次因 Kakao 占用失败，带着已有 keys 直接解密
    if (opts.resumeWithKeys && state.lastAutoPayload && state.lastAutoPayload.keys) {
      setAutoStep('account', 'ok', '沿用上次账号');
      setAutoStep('appstate', 'ok', '跳过');
      setAutoStep('keys', 'ok', `沿用 ${Object.keys(state.lastAutoPayload.keys).length} 条密钥`);
      setAutoStep('findroot', 'ok', '跳过');
      setAutoStep('unwrap', 'ok', '跳过');
      setAutoStep('decrypt', 'active', '重新解密…');
      const acc = state.lastAutoPayload.account;
      const r = await api().decryptAccount({
        accountDir: acc.dir,
        appstatePath: acc.appstatePath,
        rootHex: state.lastAutoPayload.rootHex || undefined,
        keys: state.lastAutoPayload.keys,
      });
      if (!r.ok) {
        setAutoStep('decrypt', 'fail', r.reason || '解密失败');
        showError(r.reason || '解密失败', '自动解密（退出后续跑）');
        if (r.warnings) showWarnings(r.warnings);
        if (r.needExitKakao || /全零|锁定|KakaoTalk/.test(r.reason || '')) {
          el.btnAutoContinue.hidden = false;
        }
        return;
      }
      if (r.warnings) showWarnings(r.warnings);
      setAutoStep('decrypt', 'ok', `已解密 ${r.decrypted} 个库`);
      await openUnified(r);
      return;
    }

    const r = await api().runAuto({
      skipFindRoot: !!opts.skipFindRoot,
      forceAccountId: opts.forceAccountId,
    });

    if (!r.ok) {
      showError(r.reason || '自动流程失败', `自动流程 · 步骤 ${r.step || '?'}`);
      if (r.warnings) showWarnings(r.warnings);
      state.lastAutoPayload = r;
      if (r.needExitKakao || r.step === 'decrypt') {
        el.btnAutoContinue.hidden = false;
      }
      if (r.needManualRoot) {
        // 保留自动面板，同时提示可切手动
      }
      return;
    }

    state.lastAutoPayload = r;
    if (r.rootHex) {
      el.rootInput.value = r.rootHex;
      state.rootHex = r.rootHex;
    }
    if (r.keys) state.importedKeys = { ...state.importedKeys, ...r.keys };
    if (r.account) state.selected = r.account;
    if (r.warnings) showWarnings(r.warnings);
    await openUnified(r);
  } catch (e) {
    showError(e, '自动流程异常');
  } finally {
    state.autoRunning = false;
  }
}

async function openUnified(r) {
  try {
    setAutoStep('decrypt', 'active', '构建统一查询库…');
    const db = new KakaoDB();
    await db.openUnifiedWindows(
      r.files,
      r.unifyKey || r.rootHex || Object.values(r.keys || state.importedKeys)[0],
      null,
      (stage, detail) => setAutoStep('decrypt', 'active', `[${stage}] ${detail}`)
    );
    state.db = db;
    setAutoStep('decrypt', 'ok', '打开成功');
    enterViewer();
  } catch (e) {
    setAutoStep('decrypt', 'fail', e.message || String(e));
    showError(e, '打开统一库失败');
  }
}

async function runDiscover() {
  clearError();
  try {
    setProgress(true, '扫描账号…');
    const r = await api().discover();
    if (!r.ok) {
      showError(r.reason || '扫描失败', '账号扫描');
      state.accounts = [];
      renderAccounts();
      return;
    }
    state.accounts = r.accounts || [];
    renderAccounts();
    el.discoverMeta.textContent = `${state.accounts.length} 个账号 · ${r.kakaoRunning ? 'KakaoTalk 运行中' : '未运行'}`;
  } catch (e) {
    showError(e, '账号扫描异常');
  } finally {
    setProgress(false);
  }
}

function renderAccounts() {
  el.accountList.innerHTML = '';
  el.accountEmpty.hidden = state.accounts.length > 0;
  for (const acc of state.accounts) {
    const li = document.createElement('li');
    if (state.selected && state.selected.id === acc.id) li.classList.add('active');
    li.innerHTML = `
      <div class="acc-id">${escapeHtml(acc.id)}</div>
      <div class="acc-meta">appstate ${acc.appstateSize ? (acc.appstateSize / 1024).toFixed(1) + ' KB' : '无'}
        · EDB ${acc.edbCount}</div>`;
    li.addEventListener('click', () => selectAccount(acc));
    el.accountList.appendChild(li);
  }
  updateDecryptEnabled();
}

async function selectAccount(acc) {
  clearError();
  state.selected = acc;
  renderAccounts();
  updateDecryptEnabled();
  if (!acc.appstatePath) {
    showError('该账号没有 appstate.dat', '选择账号');
    return;
  }
  try {
    const info = await api().inspectAppstate(acc.appstatePath);
    if (!info.ok) {
      showError(info.reason || '解析失败', '解析 appstate');
      return;
    }
    setKeyStatus(`已选 ${acc.id.slice(0, 12)}… · ${info.infoPrefix} · 条目 ${info.entryCount}`);
  } catch (e) {
    showError(e, '解析 appstate 异常');
  }
}

async function importJsonFile() {
  clearError();
  try {
    const picked = await api().pickFile({
      title: '选择密钥 JSON',
      filters: [{ name: 'JSON', extensions: ['json'] }, { name: '全部', extensions: ['*'] }],
    });
    if (picked.canceled) return;
    if (!picked.ok) {
      showError(picked.reason || '选择失败', '导入 JSON');
      return;
    }
    const read = await api().readTextFile(picked.path);
    if (!read.ok) {
      showError(read.reason || '读取失败', '导入 JSON');
      return;
    }
    const parsed = await api().parseKeysJson(read.text);
    if (!parsed.ok) {
      showError(parsed.reason || '解析失败', '导入 JSON');
      return;
    }
    if (parsed.rootHex) {
      el.rootInput.value = parsed.rootHex;
      state.rootHex = parsed.rootHex;
    }
    if (parsed.keyCount) state.importedKeys = { ...state.importedKeys, ...parsed.keys };
    setKeyStatus(`已导入 · R=${parsed.rootHex ? '有' : '无'} · DEK ${parsed.keyCount}`);
    updateDecryptEnabled();
  } catch (e) {
    showError(e, '导入 JSON 异常');
  }
}

async function startFindRoot() {
  clearError();
  if (!state.selected || !state.selected.appstatePath) {
    showError('请先选择账号', '内存搜索 R');
    return;
  }
  // 走全自动里的内置搜钥：切回自动并只跑 find-root 路径
  showAuto();
  await runAutoFlow({ forceAccountId: state.selected.id });
}

async function runDecrypt() {
  clearError();
  showWarnings([]);
  if (!state.selected) {
    showError('请先选择账号', '解密');
    return;
  }
  const rootHex = (el.rootInput.value || '').trim();
  const keys = { ...state.importedKeys };
  if (!rootHex && !Object.keys(keys).length) {
    showError('请填写 R 或导入 keys', '解密');
    return;
  }
  if (rootHex && !/^[0-9a-fA-F]{64}$/.test(rootHex)) {
    showError('R 必须是 64 位十六进制', '解密');
    return;
  }
  el.btnDecrypt.disabled = true;
  setProgress(true, '解密中…');
  try {
    api().onDecryptProgress((d) => setProgress(true, `[${d.stage}] ${d.detail}`));
    const r = await api().decryptAccount({
      accountDir: state.selected.dir,
      appstatePath: state.selected.appstatePath,
      rootHex: rootHex || undefined,
      keys,
    });
    if (!r.ok) {
      showError(r.reason || '解密失败', '手动解密');
      if (r.warnings) showWarnings(r.warnings);
      return;
    }
    if (r.warnings) showWarnings(r.warnings);
    await openUnified(r);
  } catch (e) {
    showError(e, '手动解密异常');
  } finally {
    setProgress(false);
    updateDecryptEnabled();
  }
}

function enterViewer() {
  el.autoPanel.hidden = true;
  el.setup.hidden = true;
  el.viewer.hidden = false;
  try {
    const st = state.db.stats();
    el.viewerStats.textContent = `消息 ${st.messageCount ?? '?'} · 聊天室 ${st.chatCount ?? '?'} · 联系人 ${st.userCount ?? '?'}`;
    el.statsBar.textContent = el.viewerStats.textContent;
  } catch (e) {
    showError(e, '读取统计失败');
  }
  renderChatList();
}

function leaveViewer() {
  el.viewer.hidden = true;
  showAuto();
  state.currentChatId = null;
  el.msgList.innerHTML = '';
  el.msgEmpty.hidden = false;
}

function renderChatList() {
  el.chatList.innerHTML = '';
  if (!state.db) return;
  let chats;
  try {
    chats = state.db.listChats(500);
  } catch (e) {
    showError(e, '列出聊天室失败');
    return;
  }
  if (!chats.length) {
    const li = document.createElement('li');
    li.textContent = '没有聊天室';
    el.chatList.appendChild(li);
    return;
  }
  for (const c of chats) {
    const li = document.createElement('li');
    const title = c.chatName || c.directMemberName || `聊天室 ${c.chatId}`;
    li.innerHTML = `<div class="chat-name">${escapeHtml(title)}</div>
      <div class="chat-sub">#${escapeHtml(String(c.chatId))}</div>`;
    li.addEventListener('click', () => openChat(c));
    el.chatList.appendChild(li);
  }
}

function openChat(chat) {
  clearError();
  state.currentChatId = chat.chatId;
  state.msgOffset = 0;
  el.msgList.innerHTML = '';
  el.msgEmpty.hidden = true;
  el.chatTitle.textContent = chat.chatName || chat.directMemberName || `聊天室 ${chat.chatId}`;
  el.chatMeta.textContent = `chatId=${chat.chatId}`;
  loadMoreMessages();
}

function loadMoreMessages() {
  if (!state.db || state.currentChatId == null) return;
  try {
    const page = state.db.getMessages(state.currentChatId, { offset: state.msgOffset, limit: 40 });
    const rows = page.rows || page || [];
    if (!rows.length) {
      if (state.msgOffset === 0) {
        el.msgEmpty.hidden = false;
        el.msgEmpty.textContent = '该聊天室没有消息';
      }
      el.loadMoreBtn.hidden = true;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const m of [...rows].reverse()) frag.appendChild(renderMsgNode(m));
    el.msgList.insertBefore(frag, el.msgList.firstChild);
    state.msgOffset += rows.length;
    el.loadMoreBtn.hidden = page.hasMore === false ? true : rows.length < 40;
  } catch (e) {
    showError(e, '加载消息失败');
  }
}

function renderMsgNode(m) {
  const div = document.createElement('div');
  div.className = 'msg-item';
  const info = messageTypeInfo(m.type);
  let text = '';
  try {
    const parsed = parseMessage(m.message, m.type, m.attachment);
    text = renderMessageText(parsed, m.type) || parsed.text || '';
  } catch {
    text = typeof m.message === 'string' ? m.message : '[无法解析]';
  }
  const when = m.sentAt
    ? new Date(Number(m.sentAt) * (String(m.sentAt).length > 11 ? 1 : 1000)).toLocaleString()
    : '';
  div.innerHTML = `
    <div class="msg-meta">${escapeHtml(info.emoji || '')} ${escapeHtml(info.label || '')}
      · ${escapeHtml(String(m.authorId ?? ''))} · ${escapeHtml(when)}</div>
    <div class="msg-body">${escapeHtml(text)}</div>`;
  return div;
}

async function runSearch() {
  clearError();
  const kw = (el.chatSearch.value || '').trim();
  if (!kw) { renderChatList(); return; }
  if (!state.db) { showError('数据库未打开', '搜索'); return; }
  try {
    const hits = state.db.searchMessages(kw, 100);
    el.msgList.innerHTML = '';
    el.msgEmpty.hidden = true;
    el.chatTitle.textContent = `搜索：${kw}`;
    el.chatMeta.textContent = `${hits.length} 条结果`;
    if (!hits.length) {
      el.msgEmpty.hidden = false;
      el.msgEmpty.textContent = '没有匹配消息';
      return;
    }
    for (const m of hits) el.msgList.appendChild(renderMsgNode(m));
    el.loadMoreBtn.hidden = true;
  } catch (e) {
    showError(e, '搜索失败');
  }
}

// —— 事件 ——
el.pageErrorClose.addEventListener('click', clearError);
el.btnAutoRetry.addEventListener('click', () => runAutoFlow());
el.btnAutoContinue.addEventListener('click', () => runAutoFlow({ resumeWithKeys: true }));
el.btnShowManual.addEventListener('click', async () => {
  showManual();
  await runDiscover();
});
el.btnBackAuto.addEventListener('click', () => showAuto());
el.btnDiscover.addEventListener('click', () => runDiscover());
el.btnSelftest.addEventListener('click', async () => {
  clearError();
  try {
    const r = await api().selftest();
    if (!r.ok) showError(r.message || '自检失败', '加密自检');
    else setKeyStatus(r.message || '自检通过');
  } catch (e) {
    showError(e, '加密自检异常');
  }
});
el.rootInput.addEventListener('input', () => {
  state.rootHex = el.rootInput.value.trim();
  updateDecryptEnabled();
});
el.btnImportRootJson.addEventListener('click', () => importJsonFile());
el.btnImportKeysJson.addEventListener('click', () => importJsonFile());
el.btnFindRoot.addEventListener('click', () => startFindRoot());
el.btnStopFindRoot.addEventListener('click', async () => {
  try {
    await api().findRootStop();
    setKeyStatus('已请求停止');
  } catch (e) {
    showError(e, '停止搜索');
  }
});
el.btnDecrypt.addEventListener('click', () => runDecrypt());
el.btnBack.addEventListener('click', () => leaveViewer());
el.loadMoreBtn.addEventListener('click', () => loadMoreMessages());
el.searchBtn.addEventListener('click', () => runSearch());
el.chatSearch.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') runSearch();
});

window.addEventListener('error', (ev) => showError(ev.error || ev.message, '未捕获异常'));
window.addEventListener('unhandledrejection', (ev) => showError(ev.reason, '未处理的 Promise 拒绝'));

// 启动即全自动
(async () => {
  try {
    if (!window.kkApp) {
      showError('请使用 Electron 启动（npm start）', '环境检查');
      return;
    }
    await runAutoFlow();
  } catch (e) {
    showError(e, '启动失败');
  }
})();
