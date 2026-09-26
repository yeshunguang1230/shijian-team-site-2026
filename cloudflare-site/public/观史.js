import { api, whoAmI, arrayOf, $, esc } from './site.js';

const state = { user: null, sources: [], aiConfigured: false };

function setStatus(text, mode = '') {
  $('#statusText').textContent = text;
  $('#statusDot').className = `status-dot ${mode}`;
}

function updateMemberLinks() {
  const ready = state.user && !state.user.mustChangePassword && state.user.role === 'developer';
  const label = ready ? '进入开发者后台' : state.user ? '完成初始密码设置' : '成员登录';
  const href = ready ? 'admin.html' : 'login.html';
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
  $('#sourceCount').textContent = String(state.sources.length);
  if (!state.sources.length) {
    target.innerHTML = '<div class="source-empty">团队正在核验首批史料。你可以先进入问史工作台，体验明确标注的规则演示。</div>';
    return;
  }
  target.innerHTML = state.sources.slice(0, 6).map(sourceCard).join('');
}

async function load() {
  try {
    const [auth, config, health, sources] = await Promise.all([
      whoAmI(),
      api('/api/config'),
      api('/api/health'),
      api('/api/sources')
    ]);
    state.user = auth;
    state.aiConfigured = Boolean(config.configured);
    state.sources = arrayOf(sources).filter((item) => item.visibility === 'published');
    const dbReady = Boolean(health.ok && health.db_configured);
    $('#dbStatus').textContent = dbReady ? '在线' : '待检查';
    setStatus(state.aiConfigured ? `AI 已接入 · ${config.model || '模型服务'}` : '云端资料在线 · AI 尚未配置', state.aiConfigured ? 'online' : 'warn');
    renderSources();
    updateMemberLinks();
  } catch {
    state.user = null;
    state.sources = [];
    $('#dbStatus').textContent = '暂不可用';
    setStatus('当前无法读取云端，公开页面仍可浏览', 'warn');
    renderSources();
    updateMemberLinks();
  }
}

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
