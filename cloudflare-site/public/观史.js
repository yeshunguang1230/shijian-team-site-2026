import { api, whoAmI, $, esc } from './site.js';

const state = {
  user: null, authStatus: 'loading', sources: [], sourcesStatus: 'loading',
  hasSourceSnapshot: false, loading: false
};

function setStatus(text, mode = '') {
  $('#statusText').textContent = text;
  $('#statusDot').className = `status-dot ${mode}`;
}

function updateMemberLinks() {
  const ready = state.user && !state.user.mustChangePassword && state.user.role === 'developer';
  const authUnknown = state.authStatus === 'error';
  const label = authUnknown ? '验证成员身份' : ready ? '进入开发者后台' : state.user?.mustChangePassword ? '完成初始密码设置' : '成员登录';
  const href = ready && !authUnknown ? 'admin.html' : 'login.html';
  for (const id of ['memberEntry', 'mobileMemberEntry', 'teamEntry']) {
    const element = $(`#${id}`);
    if (element) {
      element.textContent = id === 'teamEntry' ? `${label} ↗` : label;
      element.href = href;
    }
  }
}

function sourceCard(source) {
  const content = String(source.content || '').trim();
  const excerpt = content.length > 150 ? `${content.slice(0, 150)}…` : content;
  return `<a class="source-card" href="史鉴智能体.html#kb">
    <span class="source-type">${esc(source.reliability || '待核验')}</span>
    <h3>${esc(source.title || '未命名资料')}</h3>
    <p>${esc(excerpt || '这条资料暂未填写摘要。')}</p>
    <span class="source-meta">${esc(source.author || '来源待补充')} · ${esc(source.period || source.date || '时期待补充')}</span>
  </a>`;
}

function renderSources() {
  const target = $('#publicSources');
  target.setAttribute('aria-busy', String(state.loading));
  $('#sourceCount').textContent = state.hasSourceSnapshot ? String(state.sources.length) : '—';
  if (state.sourcesStatus === 'error') {
    const retry = '<button class="button light-outline" type="button" data-retry-services>重新读取资料</button>';
    if (state.hasSourceSnapshot && state.sources.length) {
      target.innerHTML = `<div class="source-notice"><p>暂时无法刷新。以下是本页上次成功读取的资料，可能还不是最新版本。</p>${retry}</div>${state.sources.slice(0, 6).map(sourceCard).join('')}`;
    } else {
      const text = state.hasSourceSnapshot
        ? '暂时无法刷新。上次成功读取时尚无已发布资料，请恢复网络后重试。'
        : '暂时无法读取公开资料，这不代表资料库为空。请检查网络后重试。';
      target.innerHTML = `<div class="source-empty"><p>${text}</p>${retry}</div>`;
    }
    return;
  }
  if (state.sourcesStatus === 'loading' && !state.hasSourceSnapshot) {
    target.innerHTML = '<div class="source-empty">正在读取公开资料…</div>';
    return;
  }
  const refreshing = state.sourcesStatus === 'loading'
    ? '<div class="source-notice"><p>正在刷新，先显示上次成功读取的结果…</p></div>' : '';
  if (!state.sources.length) {
    target.innerHTML = `${refreshing}<div class="source-empty">暂无已发布资料。团队可以登录后台整理并发布史料。</div>`;
    return;
  }
  target.innerHTML = refreshing + state.sources.slice(0, 6).map(sourceCard).join('');
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  state.sourcesStatus = 'loading';
  const retryButton = $('#retryServices');
  retryButton.disabled = true;
  retryButton.textContent = '正在检查…';
  $('#dbStatus').textContent = '检查中';
  $('.team-live').dataset.state = 'loading';
  setStatus('正在检查云端资料与服务状态…');
  renderSources();

  const [auth, config, health, sources] = await Promise.allSettled([
    whoAmI(), api('/api/config'), api('/api/health'), api('/api/sources')
  ]);
  const authKnown = auth.status === 'fulfilled';
  state.authStatus = authKnown ? 'ready' : 'error';
  if (authKnown) state.user = auth.value;

  const configKnown = config.status === 'fulfilled' && typeof config.value?.configured === 'boolean';
  const dbReady = health.status === 'fulfilled' && health.value?.ok === true && health.value?.db_configured === true;
  const sourceValue = sources.status === 'fulfilled' ? sources.value : null;
  const rows = Array.isArray(sourceValue) ? sourceValue : sourceValue?.items ?? sourceValue?.sources;
  const sourcesReady = Array.isArray(rows) && rows.every(item => item && typeof item === 'object' && !Array.isArray(item));
  state.sourcesStatus = sourcesReady ? 'ready' : 'error';
  if (sourcesReady) {
    state.sources = rows.filter(item => item.visibility === 'published');
    state.hasSourceSnapshot = true;
  }

  $('#dbStatus').textContent = dbReady ? '在线' : '状态待确认';
  $('.team-live').dataset.state = dbReady ? 'online' : 'warn';
  const needsRetry = !authKnown || !configKnown || !dbReady || !sourcesReady;
  let status;
  if (!sourcesReady) {
    status = state.hasSourceSnapshot ? '公开资料未能刷新，请稍后重试' : '公开资料暂时无法读取，页面仍可浏览';
  } else if (!dbReady) {
    status = '公开资料已读取 · 数据库状态待确认';
  } else if (!configKnown) {
    status = '云端资料在线 · AI 状态暂未确认';
  } else {
    status = config.value.configured ? '云端资料在线 · AI 已配置' : '云端资料在线 · AI 尚未配置';
  }
  if (!authKnown) status += ' · 成员身份待验证';
  setStatus(status, !needsRetry && config.value.configured ? 'online' : 'warn');
  state.loading = false;
  retryButton.hidden = !needsRetry;
  retryButton.disabled = false;
  retryButton.textContent = '重新检查连接';
  renderSources();
  updateMemberLinks();
}

$('#retryServices').addEventListener('click', load);
$('#publicSources').addEventListener('click', event => {
  if (event.target.closest('[data-retry-services]')) load();
});
const menu = $('#mobileMenu');
$('.menu-button').addEventListener('click', () => {
  const open = menu.hidden;
  menu.hidden = !open;
  $('.menu-button').setAttribute('aria-expanded', String(open));
});
menu.addEventListener('click', (event) => {
  if (event.target.closest('a')) {
    menu.hidden = true;
    $('.menu-button').setAttribute('aria-expanded', 'false');
  }
});
window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });
load();
