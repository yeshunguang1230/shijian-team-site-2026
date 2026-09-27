import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run: node --experimental-vm-modules tests/guanshi-home.mjs
// Real homepage + real site helper, isolated DOM and synthetic API responses.
// No network, browser, credentials, production account or database is used.
assert.equal(typeof vm.SourceTextModule, 'function',
  'Run node --experimental-vm-modules tests/guanshi-home.mjs');
const [source, siteSource, html, bridge, legacyHtml] = await Promise.all([
  readFile(new URL('../public/观史.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/site.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/观史团队网站.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/观史-bridge.css', import.meta.url), 'utf8'),
  readFile(new URL('../public/史鉴团队网站.html', import.meta.url), 'utf8'),
]);
const paths = ['/api/auth/me', '/api/config', '/api/health', '/api/sources'];
const member = { id: 'test-member', role: 'developer', mustChangePassword: false };
const material = (id, extra = {}) => ({
  id, title: '公开资料-' + id, content: '可核验的测试内容-' + id,
  author: '测试作者', period: '测试时期', reliability: '待核验',
  visibility: 'published', ...extra,
});
const published = material('initial');
const defaults = () => ({
  '/api/auth/me': { value: { user: null } },
  '/api/config': { value: { configured: true, model: 'synthetic-model' } },
  '/api/health': { value: { ok: true, db_configured: true } },
  '/api/sources': { value: [published] },
});
const failure = () => ({ error: new Error('Synthetic network failure') });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function harness(overrides = {}) {
  const plans = { ...defaults(), ...overrides };
  const elements = new Map(), requests = [], unexpected = [], windowHandlers = new Map();
  let reloads = 0;
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => '#' + match[1]));
  const element = selector => {
    assert.ok(ids.has(selector) || ['.team-live', '.menu-button'].includes(selector),
      'The real HTML must contain the UI element: ' + selector);
    if (!elements.has(selector)) {
      const handlers = new Map();
      elements.set(selector, {
        textContent: '', innerHTML: '', className: '', href: '',
        hidden: ['#mobileMenu', '#retryServices'].includes(selector),
        disabled: false, dataset: {}, attributes: {}, handlers,
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name] ?? null; },
        addEventListener(type, fn) {
          if (!handlers.has(type)) handlers.set(type, []);
          handlers.get(type).push(fn);
        },
        emit(type, event = {}) {
          return Promise.all((handlers.get(type) || []).map(fn => fn(event)));
        },
      });
    }
    return elements.get(selector);
  };
  const context = vm.createContext({
    console, AbortController, DOMException, setTimeout, clearTimeout,
    document: { querySelector: element },
    window: {
      addEventListener(type, fn) { windowHandlers.set(type, fn); },
      location: { reload() { reloads += 1; } },
    },
    fetch: async (path, options = {}) => {
      requests.push({ path, method: options.method || 'GET' });
      if (!paths.includes(path) || (options.method && options.method !== 'GET')) {
        unexpected.push({ path, method: options.method });
        throw new Error('Only the four mocked read-only API routes are allowed');
      }
      const plan = plans[path];
      if (plan.error) throw plan.error;
      const value = plan.wait ? await plan.wait : plan.value;
      const status = plan.status ?? 200;
      return { ok: status >= 200 && status < 300, status,
        json: async () => structuredClone(value) };
    },
  });
  const site = new vm.SourceTextModule(siteSource, { context, identifier: 'site.js' });
  await site.link(() => { throw new Error('Unexpected site helper dependency'); });
  const module = new vm.SourceTextModule(source, { context, identifier: '观史.js' });
  await module.link(specifier => { assert.equal(specifier, './site.js'); return site; });
  await module.evaluate();
  const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unexpected, [], 'Homepage checks must not perform writes or AI calls');
  };
  return {
    element, requests, plans, windowHandlers, reloads: () => reloads, flush,
    retry: () => element('#retryServices').emit('click'),
    retrySources: () => element('#publicSources').emit('click', {
      target: { closest: selector => selector === '[data-retry-services]' ? {} : null },
    }),
  };
}

function linksAre(h, href, label) {
  for (const id of ['memberEntry', 'mobileMemberEntry', 'teamEntry']) {
    assert.equal(h.element('#' + id).href, href, id);
    assert.equal(h.element('#' + id).textContent, id === 'teamEntry' ? label + ' ↗' : label, id);
  }
}
function completed(h) {
  assert.equal(h.element('#retryServices').disabled, false);
  assert.equal(h.element('#publicSources').getAttribute('aria-busy'), 'false');
}
let passed = 0;
async function test(name, run) {
  await run(); passed += 1; console.log('PASS ' + name);
}

await test('成功显示资料、游客入口以及准确的 AI 配置状态', async () => {
  const h = await harness(); await h.flush();
  assert.equal(h.requests.length, 4);
  assert.equal(h.element('#sourceCount').textContent, '1');
  assert.match(h.element('#publicSources').innerHTML, /公开资料-initial/);
  assert.equal(h.element('#dbStatus').textContent, '在线');
  assert.equal(h.element('.team-live').dataset.state, 'online');
  assert.match(h.element('#statusText').textContent, /AI 已配置/);
  assert.doesNotMatch(h.element('#statusText').textContent, /已接入|验证成功|模型可用/);
  assert.match(h.element('#statusDot').className, /online/);
  assert.equal(h.element('#retryServices').hidden, true);
  linksAre(h, 'login.html', '成员登录'); completed(h);
});

await test('config 失败不清空资料，不谎报未配置', async () => {
  const h = await harness({ '/api/config': failure() }); await h.flush();
  assert.match(h.element('#publicSources').innerHTML, /公开资料-initial/);
  assert.equal(h.element('#sourceCount').textContent, '1');
  assert.match(h.element('#statusText').textContent, /AI 状态暂未确认/);
  assert.doesNotMatch(h.element('#statusText').textContent, /AI 尚未配置/);
  assert.equal(h.element('.team-live').dataset.state, 'online');
  assert.match(h.element('#statusDot').className, /warn/);
  assert.equal(h.element('#retryServices').hidden, false); completed(h);
});

await test('auth 失败不影响公开资料，三个登录入口保持可用', async () => {
  const h = await harness({ '/api/auth/me': failure() }); await h.flush();
  assert.match(h.element('#publicSources').innerHTML, /公开资料-initial/);
  assert.match(h.element('#statusText').textContent, /成员身份待验证/);
  assert.equal(h.element('.team-live').dataset.state, 'online');
  linksAre(h, 'login.html', '验证成员身份'); completed(h);
});

await test('health 503 独立降级，不影响可读取的材料', async () => {
  const h = await harness({ '/api/health': { status: 503, value: {
    ok: false, db_configured: false, error: '模拟数据库状态失败',
  } } }); await h.flush();
  assert.match(h.element('#publicSources').innerHTML, /公开资料-initial/);
  assert.equal(h.element('#sourceCount').textContent, '1');
  assert.equal(h.element('#dbStatus').textContent, '状态待确认');
  assert.equal(h.element('.team-live').dataset.state, 'warn');
  assert.match(h.element('#statusText').textContent, /公开资料已读取 · 数据库状态待确认/);
  completed(h);
});

await test('首次资料读取失败显示未知数量和重试，不显示空库', async () => {
  const h = await harness({ '/api/sources': failure() }); await h.flush();
  const rendered = h.element('#publicSources').innerHTML;
  assert.equal(h.element('#sourceCount').textContent, '—');
  assert.match(rendered, /无法读取公开资料.*不代表资料库为空/);
  assert.match(rendered, /type="button" data-retry-services/);
  assert.doesNotMatch(rendered, /暂无已发布|核验首批/);
  assert.equal(h.element('#retryServices').hidden, false);
  assert.equal(h.element('.team-live').dataset.state, 'online'); completed(h);
});

await test('真实空库显示 0，与读取失败区分', async () => {
  const h = await harness({ '/api/sources': { value: [] } }); await h.flush();
  assert.equal(h.element('#sourceCount').textContent, '0');
  assert.match(h.element('#publicSources').innerHTML, /暂无已发布资料/);
  assert.doesNotMatch(h.element('#publicSources').innerHTML, /无法读取|data-retry-services/);
  assert.equal(h.element('#retryServices').hidden, true); completed(h);
});

await test('刷新失败保留旧资料并标注旧快照，重试后恢复', async () => {
  const h = await harness(); await h.flush();
  h.plans['/api/sources'] = failure(); await h.retry(); await h.flush();
  assert.match(h.element('#publicSources').innerHTML, /上次成功读取.*可能还不是最新版本/);
  assert.match(h.element('#publicSources').innerHTML, /公开资料-initial/);
  assert.equal(h.element('#sourceCount').textContent, '1');
  assert.match(h.element('#statusText').textContent, /未能刷新/);
  const pending = deferred(); h.plans['/api/sources'] = { wait: pending.promise };
  const refresh = h.retry();
  assert.equal(h.element('#retryServices').disabled, true);
  assert.equal(h.element('#publicSources').getAttribute('aria-busy'), 'true');
  assert.match(h.element('#publicSources').innerHTML, /正在刷新.*上次成功读取/);
  assert.match(h.element('#publicSources').innerHTML, /公开资料-initial/);
  pending.resolve([material('new-1'), material('new-2')]);
  await refresh; await h.flush();
  assert.equal(h.element('#sourceCount').textContent, '2');
  assert.match(h.element('#publicSources').innerHTML, /公开资料-new-1/);
  assert.doesNotMatch(h.element('#publicSources').innerHTML, /initial|上次成功|暂时无法/);
  assert.equal(h.element('#retryServices').hidden, true); completed(h);
});

await test('旧空库刷新失败保留 0 并明确上次结果', async () => {
  const h = await harness({ '/api/sources': { value: [] } }); await h.flush();
  h.plans['/api/sources'] = failure(); await h.retry(); await h.flush();
  assert.equal(h.element('#sourceCount').textContent, '0');
  assert.match(h.element('#publicSources').innerHTML, /上次成功读取时尚无已发布资料/);
  assert.doesNotMatch(h.element('#publicSources').innerHTML, /不代表资料库为空/); completed(h);
});

await test('初始徽标准确、重复重试防重入、资料区重试可恢复', async () => {
  const pending = deferred(); const h = await harness({ '/api/sources': { wait: pending.promise } });
  assert.equal(h.requests.length, 4);
  assert.equal(h.element('.team-live').dataset.state, 'loading');
  assert.equal(h.element('#dbStatus').textContent, '检查中');
  assert.doesNotMatch(h.element('#statusDot').className, /online|warn/);
  assert.equal(h.element('#retryServices').disabled, true);
  assert.equal(h.element('#publicSources').getAttribute('aria-busy'), 'true');
  await Promise.all([h.retry(), h.retry(), h.retrySources()]);
  assert.equal(h.requests.length, 4, 'Pending load must not start duplicate API batches');
  pending.resolve([published]); await h.flush(); completed(h);
  h.plans['/api/sources'] = failure(); await h.retry(); await h.flush();
  h.plans['/api/sources'] = { value: [material('recovered')] };
  await h.retrySources(); await h.flush();
  assert.equal(h.requests.length, 12);
  assert.match(h.element('#publicSources').innerHTML, /公开资料-recovered/);
  assert.equal(h.element('#retryServices').hidden, true); completed(h);
});

await test('开发者首页不公开草稿，展示六条但统计所有公开材料', async () => {
  const rows = [material('private', { visibility: 'draft', title: 'PRIVATE-DRAFT' }),
    ...Array.from({ length: 7 }, (_, index) => material('visible-' + index))];
  const h = await harness({ '/api/auth/me': { value: { user: member } }, '/api/sources': { value: rows } });
  await h.flush(); const rendered = h.element('#publicSources').innerHTML;
  assert.equal(h.element('#sourceCount').textContent, '7');
  assert.equal((rendered.match(/class="source-card"/g) || []).length, 6);
  assert.doesNotMatch(rendered, /PRIVATE-DRAFT|visible-6/);
  linksAre(h, 'admin.html', '进入开发者后台');
});

await test('异常资料响应不伪装成成功空库，合法列表包装正常', async () => {
  for (const value of [null, {}, 'unexpected', { items: {} }, { sources: 'bad' }, [null], ['bad'], [[]], { items: [null] }]) {
    const h = await harness({ '/api/sources': { value } }); await h.flush();
    assert.equal(h.element('#sourceCount').textContent, '—', JSON.stringify(value));
    assert.match(h.element('#publicSources').innerHTML, /不代表资料库为空/);
    assert.equal(h.element('#retryServices').hidden, false); completed(h);
  }
  for (const value of [{ items: [published] }, { sources: [published] }]) {
    const h = await harness({ '/api/sources': { value } }); await h.flush();
    assert.equal(h.element('#sourceCount').textContent, '1'); completed(h);
  }
});

await test('三个入口一致遵守角色及初始密码规则，身份失败可恢复', async () => {
  for (const [user, href, label] of [
    [null, 'login.html', '成员登录'],
    [member, 'admin.html', '进入开发者后台'],
    [{ ...member, mustChangePassword: true }, 'login.html', '完成初始密码设置'],
    [{ ...member, role: 'viewer' }, 'login.html', '成员登录'],
  ]) {
    const h = await harness({ '/api/auth/me': { value: { user } } }); await h.flush();
    linksAre(h, href, label);
  }
  const h = await harness({ '/api/auth/me': { value: { user: member } } }); await h.flush();
  h.plans['/api/auth/me'] = failure(); await h.retry();
  linksAre(h, 'login.html', '验证成员身份');
  h.plans['/api/auth/me'] = { value: { user: member } }; await h.retry();
  linksAre(h, 'admin.html', '进入开发者后台');
  h.plans['/api/auth/me'] = { value: { user: null } }; await h.retry();
  linksAre(h, 'login.html', '成员登录'); completed(h);
});

await test('资料字段使用真实 esc 转义，不渲染模型名称 HTML', async () => {
  const value = '<img src=x onerror="boom">&\'unsafe';
  const row = material('escape', { title: value, content: value, author: value, period: value, reliability: value });
  const h = await harness({ '/api/sources': { value: [row] },
    '/api/config': { value: { configured: true, model: '<script>untrusted-model</script>' } } });
  await h.flush(); const rendered = h.element('#publicSources').innerHTML;
  assert.doesNotMatch(rendered, /<img|<script|src=x onerror="/);
  assert.equal((rendered.match(/&lt;img src=x onerror=&quot;boom&quot;&gt;&amp;&#39;unsafe/g) || []).length, 5);
  assert.doesNotMatch(h.element('#statusText').textContent, /untrusted-model|已接入|验证成功/);
  assert.match(h.element('#statusText').textContent, /AI 已配置/);
});

await test('未配置与异常配置或健康响应保持不同状态', async () => {
  const unconfigured = await harness({ '/api/config': { value: { configured: false } } }); await unconfigured.flush();
  assert.match(unconfigured.element('#statusText').textContent, /AI 尚未配置/);
  assert.equal(unconfigured.element('#retryServices').hidden, true, 'Unconfigured is known, not a retry failure');
  assert.match(unconfigured.element('#statusDot').className, /warn/);
  for (const value of [null, {}, { configured: 'true' }, { configured: 1 }]) {
    const h = await harness({ '/api/config': { value } }); await h.flush();
    assert.match(h.element('#statusText').textContent, /AI 状态暂未确认/);
    assert.equal(h.element('#retryServices').hidden, false); completed(h);
  }
  for (const value of [null, {}, { ok: false, db_configured: false }, { ok: true, db_configured: 'true' }]) {
    const h = await harness({ '/api/health': { value } }); await h.flush();
    assert.equal(h.element('.team-live').dataset.state, 'warn');
    assert.equal(h.element('#dbStatus').textContent, '状态待确认');
    assert.match(h.element('#publicSources').innerHTML, /公开资料-initial/); completed(h);
  }
});

await test('菜单及返回页面行为保留，点击不触发身份写入', async () => {
  const h = await harness(); await h.flush();
  await h.element('.menu-button').emit('click');
  assert.equal(h.element('#mobileMenu').hidden, false);
  assert.equal(h.element('.menu-button').getAttribute('aria-expanded'), 'true');
  await h.element('#mobileMenu').emit('click', { target: { closest: selector => selector === 'a' ? {} : null } });
  assert.equal(h.element('#mobileMenu').hidden, true);
  assert.equal(h.element('.menu-button').getAttribute('aria-expanded'), 'false');
  h.windowHandlers.get('pageshow')({ persisted: false }); assert.equal(h.reloads(), 0);
  h.windowHandlers.get('pageshow')({ persisted: true }); assert.equal(h.reloads(), 1);
  assert.equal(h.requests.length, 4);
});

await test('新版标记与状态样式对应，旧版未加载新版脚本或主题', async () => {
  assert.match(html, /id="retryServices" type="button" hidden/);
  assert.match(html, /class="team-live" data-state="loading"/);
  assert.match(html, /id="publicSources" aria-live="polite" aria-busy="true"/);
  assert.match(html, /href="史鉴团队网站\.html"/);
  assert.match(bridge, /\.status-retry\[hidden\]\s*\{display:none\}/);
  assert.match(bridge, /\.team-live i\s*\{background:currentColor\}/);
  assert.match(bridge, /\.team-live\[data-state="online"\]\s*\{color:var\(--green\)\}/);
  assert.match(bridge, /\.team-live\[data-state="warn"\]/);
  assert.doesNotMatch(legacyHtml, /(?:src|href)="观史(?:-bridge\.css|\.js|\.css|-responsive\.css)"/);
});

console.log('guanshi-home: ' + passed + ' scenario groups passed; isolated API/UI mocks only.');
