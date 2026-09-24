/* Local-only integration: fresh D1, throw-away accounts; never targets production. */
import assert from 'node:assert/strict';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.SHIJIAN_AUTH_TEST_PORT || 8794);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const base = `http://127.0.0.1:${port}`;
const persist = join(root, `.wrangler-auth-e2e-${process.pid}`);
const seedFile = join(root, `.wrangler-auth-seed-${process.pid}.sql`);
const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
const legacyTeam = `obsolete-team-${suffix}`, legacyAdmin = `obsolete-admin-${suffix}`, privateKey = `local-only-api-key-${suffix}`;
const accounts = [1, 2, 3].map((n) => ({ id: `u-${suffix}-${n}`, username: `auth_member${n}_${suffix}`, displayName: `本地测试成员 ${n}`, password: `M${n}-${suffix}-initial`, next: `M${n}-${suffix}-changed` }));
const secrets = [legacyTeam, legacyAdmin, privateKey, ...accounts.flatMap((a) => [a.password, a.next])];
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (body, cookie, extra = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: JSON.stringify(body) });
const headers = (cookie) => ({ headers: { Cookie: cookie } });
function launch(args) { return spawn(process.execPath, [wrangler, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
async function run(args) {
  const child = launch(args);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((done, reject) => { child.on('error', reject); child.on('exit', (code) => code === 0 ? done() : reject(new Error(`Local Wrangler failed (${code}): ${output}`))); });
}
async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  if (process.platform === 'win32') {
    // taskkill is a Windows executable, not an npx package. Kill our child tree only.
    await new Promise((done, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', reject); killer.on('exit', done);
    });
  } else {
    server.kill('SIGTERM');
    for (let i = 0; i < 30 && server.exitCode === null; i++) await pause(100);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
}
async function cleanup(path, prefix) {
  const target = resolve(path);
  assert.equal(dirname(target), root, 'Cleanup must stay directly inside the workspace');
  assert.ok(basename(target).startsWith(prefix), 'Cleanup permits only test fixture paths');
  await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
async function assertPortFree() {
  const probe = createServer();
  await new Promise((done, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(done)); });
}
function assertNoSecrets(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.ok(!text.includes(secret), 'Response/static asset leaked a fixture secret');
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    assert.ok(!/^(password_hash|password_salt|password_iterations|token_hash|session_hash|api_key)$/i.test(key), `Private field leaked: ${key}`);
    if (item && typeof item === 'object') assertNoSecrets(item);
  }
}
async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  assertNoSecrets(text);
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  assertNoSecrets(body);
  return { response, body };
}
async function expectStatus(path, status, init, message = path) {
  const result = await request(path, init);
  assert.equal(result.response.status, status, `${message}: ${JSON.stringify(result.body)}`);
  return result;
}
function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '', match = raw.match(/__Host-shijian_session=[a-f0-9]{64}/);
  assert.ok(match, 'Login/password change must issue a session cookie');
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(raw.includes(attribute));
  assert.ok(!raw.includes('Domain='));
  return match[0];
}
async function startServer() {
  const child = launch(['dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist, '--var', `SHIJIAN_TEAM_TOKEN:${legacyTeam}`, '--var', `SHIJIAN_ADMIN_TOKEN:${legacyAdmin}`, '--var', `SHIJIAN_API_KEY:${privateKey}`, '--show-interactive-dev-session=false', '--config', 'wrangler.json']);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; }); child.on('error', (error) => { output += error.message; });
  for (let i = 0; i < 80; i++) {
    try { const health = await request('/api/health'); if (health.response.status === 200 && health.body.db_configured) return child; } catch { /* starting */ }
    if (child.exitCode !== null) break;
    await pause(250);
  }
  await stopServer(child);
  // Startup output may contain the local-only fixture vars; do not print it.
  throw new Error(`Local Worker failed to start; exit ${child.exitCode}; ${output.length} diagnostic characters captured`);
}

let server;
try {
  await assertPortFree();
  await cleanup(persist, '.wrangler-auth-e2e-');
  await run(['d1', 'migrations', 'apply', 'shijian-team-db', '--local', '--config', 'wrangler.json', '--persist-to', persist]);
  const rows = [];
  for (const a of accounts) {
    const hashed = await hashPassword(a.password), now = new Date().toISOString();
    secrets.push(hashed.hash, hashed.salt);
    rows.push(`INSERT INTO users(id,username,display_name,role,password_hash,password_salt,password_iterations,must_change_password,disabled,created_at,updated_at) VALUES(${sql(a.id)},${sql(a.username)},${sql(a.displayName)},'developer',${sql(hashed.hash)},${sql(hashed.salt)},${hashed.iterations},1,0,${sql(now)},${sql(now)});`);
  }
  const auditFailureId = `audit-fail-${suffix}`;
  rows.push(`CREATE TRIGGER local_audit_failure BEFORE INSERT ON audit_log WHEN NEW.entity_id=${sql(auditFailureId)} BEGIN SELECT RAISE(ABORT,'Local intentional audit failure'); END;`);
  await writeFile(seedFile, `${rows.join('\n')}\n`, 'utf8');
  try { await run(['d1', 'execute', 'shijian-team-db', '--local', '--persist-to', persist, '--file', seedFile, '--config', 'wrangler.json']); }
  finally { await cleanup(seedFile, '.wrangler-auth-seed-'); }
  server = await startServer();
  const routes = [['GET', '/api/settings'], ['GET', '/api/feedback'], ['GET', '/api/sync'], ['GET', '/api/members'], ['GET', '/api/audit'], ['GET', '/api/admin/overview'], ['POST', '/api/settings'], ['POST', '/api/feedback'], ['POST', '/api/sources'], ['POST', '/api/v1/chat/completions']];
  for (const [method, path] of routes) {
    await expectStatus(path, 401, { method }, `Guest denied ${method} ${path}`);
    await expectStatus(path, 401, { method, headers: { 'X-Team-Token': legacyTeam, 'X-Admin-Token': legacyAdmin } }, 'Configured legacy tokens cannot bypass accounts');
  }
  assert.equal((await expectStatus('/api/auth/me', 200)).body.user, null);
  for (const origin of ['null', 'https://invalid.example', `${base}.attacker.example`]) await expectStatus('/api/auth/login', 403, json({ username: accounts[0].username, password: accounts[0].password }, null, { Origin: origin }), 'Cross-origin login rejected');
  await expectStatus('/api/auth/login', 401, json({ username: accounts[0].username, password: 'wrong-password' }), 'Wrong password rejected');
  await expectStatus('/api/auth/login', 401, json({ username: `${accounts[0].username}' OR 1=1--`, password: accounts[0].password }), 'SQL injection rejected');
  const cookies = [];
  for (const a of accounts) {
    const loggedIn = await expectStatus('/api/auth/login', 200, json({ username: a.username, password: a.password }));
    assert.equal(loggedIn.body.user.mustChangePassword, true);
    const initial = cookieFrom(loggedIn.response);
    for (const [method, path] of routes) await expectStatus(path, 403, { method, headers: { Cookie: initial } }, 'First password change required');
    const secondary = cookieFrom((await expectStatus('/api/auth/login', 200, json({ username: a.username, password: a.password }))).response);
    await expectStatus('/api/auth/password', 400, json({ currentPassword: a.password, newPassword: 'short' }, initial), 'Short password rejected');
    const changed = await expectStatus('/api/auth/password', 200, json({ currentPassword: a.password, newPassword: a.next }, initial));
    assert.equal(changed.body.user.mustChangePassword, false);
    const cookie = cookieFrom(changed.response);
    assert.notEqual(cookie, initial); cookies.push(cookie);
    for (const old of [initial, secondary]) {
      assert.equal((await expectStatus('/api/auth/me', 200, headers(old))).body.user, null, 'Password change revokes all old sessions');
      await expectStatus('/api/settings', 401, headers(old));
    }
    await expectStatus('/api/auth/login', 401, json({ username: a.username, password: a.password }), 'Old password rejected');
    const settings = (await expectStatus('/api/settings', 200, headers(cookie), 'All developers can read settings')).body;
    await expectStatus('/api/settings', 200, json({ system_prompt: `本地测试规则 ${a.username}`, version: `test-${a.id}`, revision: settings.revision }, cookie), 'All developers can update settings');
  }
  const members = (await expectStatus('/api/members', 200, headers(cookies[0]))).body.items;
  assert.equal(members.length, 3); assert.deepEqual(new Set(members.map((m) => m.id)), new Set(accounts.map((a) => a.id)));
  const getSync = async () => (await expectStatus('/api/sync', 200, headers(cookies[0]))).body;
  const getAuditCount = async (action, entity) => (await expectStatus('/api/audit', 200, headers(cookies[0]))).body.items.filter((entry) => entry.action === action && (!entity || entry.entity_id === entity)).length;
  const initialSync = await getSync();
  assert.deepEqual(Object.keys(initialSync).sort(), ['feedback', 'settings', 'sources']);
  for (const revision of Object.values(initialSync)) assert.ok(Number.isSafeInteger(revision) && revision >= 1, 'Sync returns counters only');
  await expectStatus('/api/sources', 500, json({ item: { id: auditFailureId, revision: 0, title: '事务回滚测试', content: '审计失败不能留下未确认的数据' } }, cookies[0]), 'Audit failure rolls back the save');
  assert.ok(!(await expectStatus('/api/sources', 200, headers(cookies[0]))).body.some((item) => item.id === auditFailureId));
  assert.deepEqual(await getSync(), initialSync, 'Rollback also restores the sync counter');

  const source = { id: `source-${suffix}`, title: '测试史料', content: '共同核验的史料正文', author: '史料作者', locator: '测试页码 1', visibility: 'draft', revision: 0 };
  const created = (await expectStatus('/api/sources', 201, json({ item: source }, cookies[0]))).body.item;
  assert.equal(created.revision, 1); assert.equal(created.updated_by, accounts[0].id);
  const sourceSync = await getSync();
  assert.equal(sourceSync.sources, initialSync.sources + 1);
  assert.equal(sourceSync.feedback, initialSync.feedback); assert.equal(sourceSync.settings, initialSync.settings);
  const replayedCreate = (await expectStatus('/api/sources', 200, json({ item: source }, cookies[0]), 'Lost source create response retry')).body;
  assert.equal(replayedCreate.replayed, true); assert.deepEqual(replayedCreate.item, created);
  assert.equal(await getAuditCount('source_created', source.id), 1, 'Retry creates no duplicate audit record');
  assert.deepEqual(await getSync(), sourceSync, 'Retry changes no sync counter');
  await expectStatus('/api/sources', 409, json({ item: source }, cookies[1]), 'Another account cannot confirm the same save');
  await expectStatus('/api/sources', 409, json({ item: { ...source, content: '同一 id 不同内容' } }, cookies[0]), 'Changed retry cannot replace saved source');
  await expectStatus('/api/sources', 409, json({ item: { ...created, revision: undefined } }, cookies[0]), 'Old source client missing revision conflicts');
  assert.ok(!(await expectStatus('/api/sources', 200)).body.some((x) => x.id === source.id), 'Guests cannot see drafts');
  for (const cookie of cookies) assert.ok((await expectStatus('/api/sources', 200, headers(cookie))).body.some((x) => x.id === source.id), 'All three members see the draft');
  const updated = (await expectStatus('/api/sources', 200, json({ item: { ...created, content: '成员 2 校对正文' } }, cookies[1]))).body.item;
  assert.equal(updated.revision, 2);
  const replayedUpdate = (await expectStatus('/api/sources', 200, json({ item: { ...created, content: '成员 2 校对正文' } }, cookies[1]))).body;
  assert.equal(replayedUpdate.replayed, true); assert.deepEqual(replayedUpdate.item, updated);
  await expectStatus('/api/sources', 409, json({ item: { ...created, content: '成员 2 校对正文' } }, cookies[2]), 'Another account cannot confirm an update');
  await expectStatus('/api/sources', 409, json({ item: { ...created, content: '过时编辑不能覆盖' } }, cookies[2]), 'Stale revision conflicts');
  assert.equal((await expectStatus('/api/sources', 200, headers(cookies[2]))).body.find((x) => x.id === source.id).content, '成员 2 校对正文');
  assert.equal((await expectStatus('/api/sources', 200, json({ item: { ...updated, visibility: 'published' } }, cookies[2]))).body.item.revision, 3);
  const guestSource = (await expectStatus('/api/sources', 200)).body.find((x) => x.id === source.id);
  assert.equal(guestSource.content, '成员 2 校对正文'); assert.ok(!('updated_by' in guestSource), 'Public sources omit member identity');
  await expectStatus('/api/sources', 400, json({ items: [] }, cookies[0]), 'Whole database replacement disabled');
  await expectStatus('/api/sources', 409, json({ item: source }, cookies[0]), 'Very old request cannot claim a newer revision');
  const legacySource = (await expectStatus('/api/sources', 201, json({ item: { title: '旧客户端新建', content: '自动生成标识' } }, cookies[0]))).body.item;
  assert.ok(legacySource.id); assert.equal(legacySource.revision, 1, 'Legacy new records without id/revision stay compatible');
  const sourceRaces = await Promise.all([1, 2].map((n) => request('/api/sources', json({ item: { ...legacySource, content: `并发校对 ${n}` } }, cookies[n]))));
  assert.deepEqual(sourceRaces.map((result) => result.response.status).sort(), [200, 409], 'Exactly one concurrent source update wins');
  assert.equal(await getAuditCount('source_updated', legacySource.id), 1, 'Losing concurrent update creates no audit entry');

  const feedback = { id: `feedback-${suffix}`, title: '团队共享反馈', author: '冒名作者', createdAt: '1900-01-01', status: '新建', priority: 'P1', revision: 0 };
  const beforeFeedback = await getSync();
  const saved = (await expectStatus('/api/feedback', 200, json(feedback, cookies[0]))).body;
  assert.equal(saved.author, accounts[0].displayName); assert.equal(saved.updatedBy, accounts[0].displayName); assert.notEqual(saved.createdAt, feedback.createdAt);
  assert.equal(saved.revision, 1);
  const feedbackSync = await getSync(); assert.equal(feedbackSync.feedback, beforeFeedback.feedback + 1); assert.equal(feedbackSync.sources, beforeFeedback.sources);
  const replayedFeedback = (await expectStatus('/api/feedback', 200, json(feedback, cookies[0]))).body;
  assert.equal(replayedFeedback.replayed, true); assert.equal(replayedFeedback.revision, 1);
  assert.deepEqual(await getSync(), feedbackSync);
  assert.equal(await getAuditCount('feedback_saved', feedback.id), 1);
  await expectStatus('/api/feedback', 409, json(feedback, cookies[1]), 'Another account cannot confirm a feedback save');
  await expectStatus('/api/feedback', 409, json({ ...feedback, title: '不同标题' }, cookies[0]), 'Changed feedback retry conflicts');
  const edited = (await expectStatus('/api/feedback', 200, json({ ...saved, author: '再次冒名', createdAt: '1800-01-01', status: '开发中' }, cookies[1]))).body;
  assert.equal(edited.author, accounts[0].displayName); assert.equal(edited.createdAt, saved.createdAt); assert.equal(edited.updatedBy, accounts[1].displayName);
  assert.equal(edited.revision, 2);
  await expectStatus('/api/feedback', 409, json({ ...saved, status: '暂缓' }, cookies[2]), 'Stale feedback revision conflicts');
  await expectStatus('/api/feedback', 409, json({ ...edited, revision: undefined }, cookies[1]), 'Old feedback client missing revision conflicts');
  const feedbackRetry = (await expectStatus('/api/feedback', 200, json({ ...saved, status: '开发中' }, cookies[1]))).body;
  assert.equal(feedbackRetry.replayed, true); assert.equal(feedbackRetry.revision, 2);
  const feedbackRaces = await Promise.all([0, 2].map((n) => request('/api/feedback', json({ ...edited, notes: `并发建议 ${n}` }, cookies[n]))));
  assert.deepEqual(feedbackRaces.map((result) => result.response.status).sort(), [200, 409], 'Exactly one concurrent feedback update wins');
  assert.equal(await getAuditCount('feedback_saved', feedback.id), 3, 'Each accepted feedback revision has one audit record');
  assert.equal((await expectStatus('/api/feedback', 200, headers(cookies[2]))).body.find((x) => x.id === feedback.id).status, '开发中');

  const settings = (await expectStatus('/api/settings', 200, headers(cookies[0]))).body;
  const settingsInput = { system_prompt: '更新后须同时生效的规则', version: 'v-shared', revision: settings.revision };
  const beforeSettings = await getSync();
  const newSettings = (await expectStatus('/api/settings', 200, json(settingsInput, cookies[0]))).body;
  assert.equal(newSettings.revision, settings.revision + 1);
  const settingsSync = await getSync(); assert.equal(settingsSync.settings, beforeSettings.settings + 1); assert.equal(settingsSync.feedback, beforeSettings.feedback);
  const auditSettings = await getAuditCount('settings_updated');
  assert.equal((await expectStatus('/api/settings', 200, json(settingsInput, cookies[0]))).body.replayed, true);
  assert.equal(await getAuditCount('settings_updated'), auditSettings); assert.deepEqual(await getSync(), settingsSync);
  await expectStatus('/api/settings', 409, json(settingsInput, cookies[1]), 'Another account cannot confirm the same settings');
  await expectStatus('/api/settings', 409, json({ ...settingsInput, system_prompt: '过时规则' }, cookies[0]), 'Stale settings cannot overwrite rules');
  await expectStatus('/api/settings', 409, json({ ...settingsInput, revision: undefined }, cookies[0]), 'Old settings client missing revision conflicts');
  const settingsRaces = await Promise.all([1, 2].map((n) => request('/api/settings', json({ system_prompt: `并发规则 ${n}`, version: `并发版本 ${n}`, revision: newSettings.revision }, cookies[n]))));
  assert.deepEqual(settingsRaces.map((result) => result.response.status).sort(), [200, 409], 'Exactly one concurrent settings update wins');
  const settingsWinner = settingsRaces.find((result) => result.response.status === 200).body;
  const settingsStored = (await expectStatus('/api/settings', 200, headers(cookies[0]))).body;
  assert.equal(settingsStored.system_prompt, settingsWinner.system_prompt); assert.equal(settingsStored.version, settingsWinner.version, 'Prompt and version are saved together');
  assert.equal(await getAuditCount('settings_updated'), auditSettings + 1);
  for (const path of ['/api/settings', '/api/sources', '/api/feedback', '/api/auth/logout', '/api/auth/password']) await expectStatus(path, 403, json({}, cookies[0], { Origin: 'https://invalid.example' }), 'Cross-origin authenticated mutation rejected');
  await expectStatus('/api/settings', 200, headers(cookies[0]), 'Rejected cross-origin logout preserves session');
  const audit = (await expectStatus('/api/audit', 200, headers(cookies[0]))).body.items;
  for (const action of ['login', 'password_changed', 'source_created', 'source_updated', 'feedback_saved', 'settings_updated']) assert.ok(audit.some((x) => x.action === action), `Audit ${action}`);
  for (const entry of await readdir(join(root, 'public'), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    assertNoSecrets(await readFile(join(root, 'public', entry.name), 'utf8'));
    await expectStatus(`/${encodeURIComponent(entry.name)}`, 200);
  }
  for (const path of ['/private/shijian-secrets.json', '/.dev.vars', '/src/auth.js', '/migrations/0002_accounts.sql']) await expectStatus(path, 404, undefined, 'Private files inaccessible');
  await expectStatus('/api/config', 200);

  // Actual Worker restart verifies D1 persistence and persisted sessions.
  await stopServer(server); server = undefined; await pause(400); server = await startServer();
  assert.equal((await expectStatus('/api/feedback', 200, headers(cookies[2]))).body.find((x) => x.id === feedback.id).author, accounts[0].displayName);
  assert.equal((await expectStatus('/api/sources', 200)).body.find((x) => x.id === source.id).revision, 3);
  for (const [i, a] of accounts.entries()) {
    const active = cookieFrom((await expectStatus('/api/auth/login', 200, json({ username: a.username, password: a.next }, cookies[i]))).response);
    await expectStatus('/api/settings', 401, headers(cookies[i]), 'Re-login rotates browser session');
    const logout = await expectStatus('/api/auth/logout', 200, json({}, active));
    assert.ok(logout.response.headers.get('set-cookie').includes('Max-Age=0'));
    assert.equal((await expectStatus('/api/auth/me', 200, headers(active))).body.user, null);
    await expectStatus('/api/settings', 401, headers(active), 'Logout revokes session');
  }
  console.log('Local D1 auth e2e passed: three accounts, forced password change, shared drafts/publication, concurrent sources/feedback/settings, safe retries, sync counters, audit integrity, persistence, origin checks, secrets, session revocation.');
} finally {
  await stopServer(server);
  await cleanup(seedFile, '.wrangler-auth-seed-');
  await cleanup(persist, '.wrangler-auth-e2e-');
}
