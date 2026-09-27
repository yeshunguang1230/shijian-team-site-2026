import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the real login.js handlers against a mocked DOM/localStorage/fetch.
// No production account or database is involved.
const source = await readFile(new URL('../public/login.js', import.meta.url), 'utf8');
const draftSource = await readFile(new URL('../public/workspace-draft.js', import.meta.url), 'utf8');
const logoutNoticeSource = await readFile(new URL('../public/logout-notice.js', import.meta.url), 'utf8');
const member = { id: 'test-member', displayName: '测试成员', username: 'tester' };
const otherMember = { id: 'other-account', displayName: '另一成员', username: 'other' };

async function harness({search='',storageMap=new Map(),confirm=true,user=null,whoAmIError=false,delayWhoAmI=false,delayLogin=false,loginUser=member}={}) {
  const elements = new Map();
  const requests = [];
  const listeners = new Map();
  const replacedUrls = [];
  const confirmLog = [];
  let confirmValue = confirm;
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, href: '',
      classList: { toggle() {} },
      addEventListener(type, handler) { this.handlers = this.handlers || {}; this.handlers[type] = handler; },
      querySelector() { return element(selector + ' button'); },
      click() { return this.onclick?.(); },
      reset() { for (const item of Object.values(this.elements || {})) item.value = ''; },
    });
    return elements.get(selector);
  };
  for (const [selector, names] of [
    ['#loginForm', ['username', 'password']],
    ['#passwordForm', ['currentPassword', 'newPassword', 'confirmPassword']],
  ]) {
    const group = Object.fromEntries(names.map(name => [name, element(selector + '-' + name)]));
    element(selector).elements = group;
  }
  let resolveLoginFn, rejectLoginFn;
  const loginPromise = delayLogin ? new Promise((resolve, reject) => { resolveLoginFn = resolve; rejectLoginFn = reject; }) : null;
  const api = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, method: options.method || 'GET', body });
    if (path === '/api/auth/logout') return { ok: true };
    if (path === '/api/auth/login') { if (delayLogin) return loginPromise; return { user: loginUser }; }
    throw new Error('Unexpected API path: ' + path);
  };
  const context = vm.createContext({
    console, URLSearchParams,
    location: { search, replace(url) { replacedUrls.push(url); } },
    window: { addEventListener(type, handler) { listeners.set(type, handler); } },
    localStorage: { get length() { return storageMap.size; }, key: index => [...storageMap.keys()][index], getItem: key => storageMap.get(key) ?? null, setItem: (key, value) => storageMap.set(key, value), removeItem: key => storageMap.delete(key) },
    confirm: message => { confirmLog.push(message); return confirmValue; },
  });
  let resolveWhoAmI, rejectWhoAmI;
  const whoAmIPromise = delayWhoAmI ? new Promise((resolve, reject) => { resolveWhoAmI = resolve; rejectWhoAmI = reject; }) : null;
  const exports = {
    api, $: element,
    message: (el, text, error = false) => { el.textContent = text; el.error = error; },
    whoAmI: async () => {
      if (delayWhoAmI) return whoAmIPromise;
      if (whoAmIError) throw new Error('network');
      return user;
    },
  };
  // site.js no longer exports LOGOUT_WARNING (round 3, issue 4): the constant now
  // lives in the real public/logout-notice.js module, loaded below unmocked so
  // this test exercises the actual file the browser will fetch, not a stand-in.
  const site = new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context });
  const draftModule = new vm.SourceTextModule(draftSource, { context });
  await draftModule.link(() => {});
  const logoutNoticeModule = new vm.SourceTextModule(logoutNoticeSource, { context });
  await logoutNoticeModule.link(() => {});
  await logoutNoticeModule.evaluate();
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => {
    if (specifier === './workspace-draft.js') return draftModule;
    if (specifier === './logout-notice.js') return logoutNoticeModule;
    assert.equal(specifier, './site.js');
    return site;
  });
  await module.evaluate();
  if (!delayWhoAmI) await new Promise(resolve => setImmediate(resolve)); // let whoAmI().then(showUser) settle
  return {
    element, requests, storageMap, confirmLog, replacedUrls, context,
    LOGOUT_WARNING: logoutNoticeModule.namespace.LOGOUT_WARNING,
    setConfirm(value) { confirmValue = value; },
    async event(type, payload = {}) { await listeners.get(type)?.(payload); },
    async resolveWhoAmI(value) { resolveWhoAmI(value); await new Promise(resolve => setImmediate(resolve)); },
    async rejectWhoAmI(error) { rejectWhoAmI(error); await new Promise(resolve => setImmediate(resolve)); },
    async submitLogin({ username = 'ghost-user', password = 'not-a-real-password' } = {}) {
      element('#loginForm-username').value = username;
      element('#loginForm-password').value = password;
      element('#loginForm').handlers.submit({ preventDefault() {}, currentTarget: element('#loginForm') });
      await new Promise(resolve => setImmediate(resolve));
    },
    async resolveLogin(value) { resolveLoginFn(value); await new Promise(resolve => setImmediate(resolve)); },
    async rejectLogin(error) { rejectLoginFn(error); await new Promise(resolve => setImmediate(resolve)); },
  };
}

function fillFictionalPasswords(h) {
  h.element('#loginForm-username').value = 'ghost-user';
  h.element('#loginForm-password').value = 'not-a-real-password';
  h.element('#passwordForm-currentPassword').value = 'not-a-real-current-password';
  h.element('#passwordForm-newPassword').value = 'not-a-real-new-password';
  h.element('#passwordForm-confirmPassword').value = 'not-a-real-new-password';
}

function assertFormsCleared(h) {
  assert.equal(h.element('#loginForm-username').value, '', 'Login username must be cleared after logout');
  assert.equal(h.element('#loginForm-password').value, '', 'Login password must be cleared after logout');
  assert.equal(h.element('#passwordForm-currentPassword').value, '', 'Current-password field must be cleared after logout');
  assert.equal(h.element('#passwordForm-newPassword').value, '', 'New-password field must be cleared after logout');
  assert.equal(h.element('#passwordForm-confirmPassword').value, '', 'Confirm-password field must be cleared after logout');
  assert.equal(h.element('#signedInName').textContent, '', 'Leftover account name must be cleared after logout');
}

{
  const h = await harness({ user: member });
  h.setConfirm(false);
  await h.element('#logout').click();
  assert.equal(h.confirmLog.length, 1, 'Logout must always ask for confirmation');
  assert.equal(h.confirmLog[0], h.LOGOUT_WARNING);
  assert.equal(h.requests.length, 0, 'Canceling the logout confirmation must not call any API');
  assert.equal(h.element('#signedInSection').hidden, false, 'Session must remain active after canceling logout');
  console.log('PASS 登录页退出入口：明确提醒后，取消确认不会调用退出接口，会话保持不变');
}

{
  const h = await harness({ user: member });
  fillFictionalPasswords(h);
  await h.element('#logout').click();
  assert.equal(h.confirmLog.length, 1);
  assert.equal(h.requests.some(x => x.path === '/api/auth/logout'), true, 'Confirming must call the logout API');
  assert.equal(h.element('#loginMessage').textContent, '已退出登录。');
  assert.equal(h.element('#loginMessage').error, false);
  assert.equal(h.element('#loginSection').hidden, false);
  assert.equal(h.element('#signedInSection').hidden, true);
  assertFormsCleared(h);
  console.log('PASS 登录页退出入口：确认后调用退出接口，清理成功、提示已退出，且登录/改密表单中的虚构密码与账号展示均已清空');
}

{
  class FailingClearMap extends Map { delete() { throw new Error('模拟本机存储清理失败'); } }
  const storageMap = new FailingClearMap();
  storageMap.set('shijian.workspace-draft.v1:' + encodeURIComponent(member.id) + ':demo', '{}');
  const h = await harness({ user: member, storageMap });
  fillFictionalPasswords(h);
  await h.element('#passwordLogout').click();
  assert.equal(h.requests.some(x => x.path === '/api/auth/logout'), true);
  assert.equal(h.element('#loginMessage').textContent, '已退出登录，但本机恢复稿未能清除；共用设备请清除此网站的浏览器数据。');
  assert.equal(h.element('#loginMessage').error, true, 'Cleanup failure must be flagged as an error, never claimed as success');
  assert.equal(h.element('#loginSection').hidden, false, 'A failed local cleanup must still leave the account signed out, not stuck in a signed-in view');
  assertFormsCleared(h);
  console.log('PASS 登录页退出入口（首次改密路径）：本机恢复稿清理失败时明确提示失败，不谎称已清理，不允许停留在已登录状态，且表单与账号展示仍会清空');
}

{
  const h = await harness({ user: member });
  fillFictionalPasswords(h);
  await h.event('storage', { key: 'shijian.workspace-logout.v1:' + encodeURIComponent(member.id), newValue: '1' });
  assert.equal(h.element('#loginSection').hidden, false, 'A signed-in login.html tab must react to a same-account logout from another tab');
  assert.equal(h.element('#signedInSection').hidden, true);
  assert.equal(h.element('#loginMessage').textContent, '账号已在其他标签页退出登录。');
  assert.equal(h.element('#loginMessage').error, true);
  assertFormsCleared(h);
  console.log('PASS 登录页已登录标签收到其他标签退出通知：立即返回登录区、显示固定原因，并清空登录/改密表单中的虚构密码与账号展示');
}

{
  const h = await harness({ user: member });
  await h.event('storage', { key: 'shijian.workspace-logout.v1:other-account', newValue: '1' });
  assert.equal(h.element('#signedInSection').hidden, false, 'A different account\'s logout marker must not affect this tab');
  assert.notEqual(h.element('#loginMessage').textContent, '账号已在其他标签页退出登录。');
  console.log('PASS 登录页：其他账号的退出标记不影响当前账号的登录状态');
}

{
  const h = await harness({ search: '?reason=other-tab-logout&notice=local-draft-cleanup' });
  assert.equal(h.element('#loginMessage').textContent, '账号已在其他标签页退出登录。 本机恢复稿未能清除；共用设备请清除此网站的浏览器数据。');
  assert.equal(h.element('#loginMessage').error, true);
  console.log('PASS 登录页加载时：同时携带退出原因和清理失败提示码，两条消息都会显示');
}

{
  const reasonOnly = await harness({ search: '?reason=other-tab-logout' });
  assert.equal(reasonOnly.element('#loginMessage').textContent, '账号已在其他标签页退出登录。');
  const noticeOnly = await harness({ search: '?notice=local-draft-cleanup' });
  assert.equal(noticeOnly.element('#loginMessage').textContent, '本机恢复稿未能清除；共用设备请清除此网站的浏览器数据。');
  const none = await harness({ search: '' });
  assert.equal(none.element('#loginMessage').textContent, '');
  console.log('PASS 登录页加载时：退出原因与清理失败提示可单独出现，均为固定提示码，互不影响');
}

{
  // Issue 3: a whoAmI() network failure must not overwrite the query-param notices
  // (e.g. the local-draft cleanup-failure warning) — they must be combined, not replaced.
  const h = await harness({ search: '?reason=other-tab-logout&notice=local-draft-cleanup', whoAmIError: true });
  const text = h.element('#loginMessage').textContent;
  assert.ok(text.includes('账号已在其他标签页退出登录。'), '网络错误提示不能覆盖“其他标签页退出”提醒');
  assert.ok(text.includes('本机恢复稿未能清除'), '网络错误提示不能覆盖清理失败警告');
  assert.ok(text.includes('暂时未能检查登录状态'), '网络错误本身也必须仍然可见');
  assert.equal(h.element('#loginMessage').error, true);
  console.log('PASS 登录页加载时：whoAmI 请求失败与查询参数提示合并显示，清理失败警告不会被网络错误覆盖');
}

{
  // Issue 2, part 1: a same-account logout notice arriving before a delayed whoAmI()
  // resolves must suppress that stale identity result — no signed-in UI, no auto-redirect.
  const h = await harness({ search: '?next=admin.html%23sources', delayWhoAmI: true });
  await h.event('storage', { key: 'shijian.workspace-logout.v1:' + encodeURIComponent(member.id), newValue: '1' });
  assert.equal(h.element('#loginSection').hidden, false, 'Logout notice must show the login section immediately');
  await h.resolveWhoAmI(member); // the delayed whoAmI() now settles for the just-logged-out account
  assert.equal(h.element('#signedInSection').hidden, true, 'A late whoAmI() for an already-logged-out account must not resurrect the signed-in view');
  assert.equal(h.element('#loginSection').hidden, false);
  assert.equal(h.replacedUrls.length, 0, 'A late whoAmI() for an already-logged-out account must not auto-redirect via next');
  assert.equal(h.element('#loginMessage').textContent, '账号已在其他标签页退出登录。');
  console.log('PASS 迟到的 whoAmI 身份响应：若期间已收到同账号退出事件，不会恢复已登录界面，也不会按 next 自动跳转后台');
}

{
  // Issue 2, part 2: an unrelated account's logout notice must not block or otherwise
  // interfere with the current account's normal delayed whoAmI() sign-in/redirect flow.
  const h = await harness({ search: '?next=admin.html%23sources', delayWhoAmI: true });
  await h.event('storage', { key: 'shijian.workspace-logout.v1:' + encodeURIComponent(otherMember.id), newValue: '1' });
  await h.resolveWhoAmI(member);
  assert.equal(h.replacedUrls.length, 1, 'An unrelated account\'s logout notice must not block this account\'s next redirect');
  assert.equal(h.replacedUrls[0], 'admin.html#sources');
  console.log('PASS 迟到的 whoAmI 身份响应：其他账号的退出事件不会误伤本账号的正常登录跳转');
}

{
  // Repro A: a same-account cross-tab logout must not permanently block that account
  // from signing back in on this tab (the earlier fix used a permanent Set — a real
  // new login attempt made *after* the logout must still be accepted).
  const h = await harness({ user: member });
  await h.event('storage', { key: 'shijian.workspace-logout.v1:' + encodeURIComponent(member.id), newValue: '1' });
  assert.equal(h.element('#loginSection').hidden, false);
  await h.submitLogin({ username: member.username, password: 'freshly-typed-real-password' });
  assert.equal(h.replacedUrls.at(-1), 'admin.html', '退出后主动重新登录成功，必须正常跳转后台，不能被退出前的标记永久拦住');
  console.log('PASS 退出后正常重新登录：不会被此前的退出标记永久拦住');
}

{
  // Repro A (variant): the fresh re-login this time requires a first-time password
  // change — must reach the password screen, not get stuck showing the login form.
  const h = await harness({ user: member, loginUser: { ...member, mustChangePassword: true } });
  await h.event('storage', { key: 'shijian.workspace-logout.v1:' + encodeURIComponent(member.id), newValue: '1' });
  await h.submitLogin({ username: member.username, password: 'freshly-typed-real-password' });
  assert.equal(h.element('#passwordSection').hidden, false, '退出后重新登录且需要首次改密时，必须进入改密页');
  assert.equal(h.element('#loginSection').hidden, true);
  assert.equal(h.replacedUrls.length, 0, '首次改密流程不应在改密前跳转后台');
  console.log('PASS 退出后重新登录并进入首次改密：不会被此前的退出标记误判为无效身份');
}

{
  // Repro B: a login request already in flight when the same-account logout event
  // arrives must not have its (now-stale) success response redirect to the admin
  // workspace — showUser and the redirect decision must share one validity check.
  const h = await harness({ delayLogin: true });
  await h.submitLogin({ username: member.username, password: 'in-flight-password' });
  await h.event('storage', { key: 'shijian.workspace-logout.v1:' + encodeURIComponent(member.id), newValue: '1' });
  await h.resolveLogin({ user: member });
  assert.equal(h.replacedUrls.length, 0, '登录请求期间收到同账号退出事件后，旧的登录响应不能再触发跳转');
  assert.equal(h.element('#loginSection').hidden, false);
  assert.equal(h.element('#loginMessage').textContent, '账号已在其他标签页退出登录。');
  console.log('PASS 登录请求期间收到同账号退出事件：旧的登录响应不再展示已登录界面，也不会跳转后台');
}

{
  // Requirement 3 re-checked against the new login flow: an unrelated account's
  // logout event arriving mid-login must not block this account's own login.
  const h = await harness({ delayLogin: true });
  await h.submitLogin({ username: member.username, password: 'in-flight-password' });
  await h.event('storage', { key: 'shijian.workspace-logout.v1:' + encodeURIComponent(otherMember.id), newValue: '1' });
  await h.resolveLogin({ user: member });
  assert.equal(h.replacedUrls.at(-1), 'admin.html', '其他账号的退出事件不能误伤本账号正在进行的登录');
  console.log('PASS 登录请求期间收到其他账号退出事件：不误伤本账号的正常登录跳转');
}

{
  // Requirement 4: an initial whoAmI() check started before a fresh login, but
  // resolving only after that login already succeeded, must not override the
  // newer login-derived state.
  const h = await harness({ delayWhoAmI: true });
  await h.submitLogin({ username: member.username, password: 'freshly-typed-real-password' });
  assert.equal(h.replacedUrls.at(-1), 'admin.html', '新登录必须正常跳转');
  await h.resolveWhoAmI(null); // the older, slower identity check finally resolves as "not signed in"
  assert.equal(h.replacedUrls.length, 1, '较早的身份查询结果不能覆盖较新的登录结果');
  console.log('PASS 较早的身份查询结果晚于新登录返回：不会覆盖新登录已生效的状态');
}
