/**
 * 史鉴团队网站：Cloudflare Worker + D1 API。
 *
 * The HTML files in ../public are served by the Workers Assets binding.  This
 * Worker keeps the API contract used by the existing pages so the UI does not
 * need a second, Cloudflare-specific build.
 */

import { ApiError, getSession, handleAuth, publicUser, requireDeveloper, verifyOrigin } from './auth.js';
import { fetchAiResponse, outputTokenBudget } from './ai-transport.js';

const DEFAULT_PROMPT =
  '你是史鉴历史学习智能体。只使用给定 SOURCES。把关键结论标成事实、推断或争议；每个事实 claim 必须带 source_ids。资料不足时明确写资料不足，禁止虚构引用。只返回 JSON。';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 1024 * 1024;
const MAX_PROMPT = 30000;
const MAX_SOURCE_CONTENT = 200000;
const MAX_FEEDBACK_FIELD = 12000;
const AI_MAX_MESSAGES = 50;
const AI_MAX_TEXT = 20000;
const AI_MAX_TOTAL = 120000;
const AI_WINDOW_SECONDS = 300;
const AI_MAX_REQUESTS_PER_WINDOW = 20;
const SOURCE_FIELDS = ['id', 'title', 'author', 'date', 'reliability', 'period', 'locator', 'content', 'visibility'];
const FEEDBACK_FIELDS = ['id', 'category', 'priority', 'title', 'targetVersion', 'scenario', 'current', 'desired', 'evidence', 'acceptance', 'notes', 'status', 'owner', 'retest'];
const SETTINGS_COLUMNS = 'system_prompt,version,revision,updated_at,updated_by';

const aiHits = new Map();

function envText(env, key) {
  return typeof env[key] === 'string' ? env[key].trim() : '';
}

function jsonResponse(value, status = 200, request, env, extra = {}) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra
  });
  secureHeaders(headers);
  addCors(headers, request, env);
  return new Response(JSON.stringify(value), { status, headers });
}

function addCors(headers, request, env) {
  const origin = request?.headers.get('Origin')?.replace(/\/$/, '');
  if (!origin) return;
  const allowed = envText(env, 'SHIJIAN_ALLOWED_ORIGINS')
    .split(',')
    .map((x) => x.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (allowed.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
}

function secureHeaders(headers) {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return headers;
}

function errorResponse(message, status = 400, request, env, extra = {}) {
  return jsonResponse({ error: message }, status, request, env, extra);
}

async function ensureDb(env) {
  if (!env.DB) throw new Error('D1 数据库绑定缺失，请在 wrangler 配置中绑定 DB');
  // Tables and demo rows are created only by migrations/0001_initial.sql.
  // Do not seed on an isolate restart: that could silently resurrect demo
  // content or hide a failed migration. A cheap query keeps health/API errors
  // explicit when the binding is missing or unavailable.
  await env.DB.prepare('SELECT 1 AS ok').first('ok');
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) throw new ApiError('请求内容过大（上限 1 MB）', 413);
  const type = request.headers.get('Content-Type')?.split(';', 1)[0]?.toLowerCase();
  if (type !== 'application/json') throw new ApiError('POST 必须使用 application/json', 415);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY) throw new ApiError('请求内容过大（上限 1 MB）', 413);
  let value;
  try { value = JSON.parse(text || '{}'); } catch { throw new ApiError('请求内容格式不正确'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('请求内容必须是对象');
  }
  return value;
}

function textValue(value, name, limit = MAX_FEEDBACK_FIELD) {
  if (value === undefined || value === null) return '';
  if (!['string', 'number'].includes(typeof value)) throw new ApiError(`${name} 必须是文本`);
  const text = String(value).trim();
  if (text.length > limit) throw new ApiError(`${name} 过长`);
  return text;
}

function cleanSource(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('请填写一条史料');
  const id = textValue(input.id || crypto.randomUUID(), '史料 ID', 64);
  if (!ID_RE.test(id)) throw new ApiError('史料 ID 格式不正确');
  if (!['draft', 'published'].includes(input.visibility || 'draft')) throw new ApiError('史料状态必须是草稿或已发布');
  if (!textValue(input.title, '标题', 500) || !textValue(input.content, '内容', MAX_SOURCE_CONTENT)) throw new ApiError('请填写史料标题和正文');
  return {
    id,
    title: textValue(input.title, '标题', 500),
    author: textValue(input.author, '作者', 300),
    date: textValue(input.date, '日期', 100),
    reliability: textValue(input.reliability || '待核验', '可靠性', 100),
    period: textValue(input.period, '时期', 200),
    locator: textValue(input.locator, '页码或链接', 1000),
    content: textValue(input.content, '内容', MAX_SOURCE_CONTENT),
    visibility: input.visibility || 'draft'
  };
}

function cleanFeedback(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('反馈必须是对象');
  const id = textValue(input.id || crypto.randomUUID(), 'id', 64);
  if (!ID_RE.test(id)) throw new ApiError('id 只能包含字母、数字、下划线或短横线');
  const fields = ['createdAt', 'author', 'category', 'priority', 'title', 'targetVersion', 'scenario', 'current', 'desired', 'evidence', 'acceptance', 'notes', 'status', 'owner', 'retest'];
  const clean = { id };
  for (const field of fields) clean[field] = textValue(input[field], field);
  if (!clean.title || clean.title.length > 300) throw new ApiError('请填写不超过 300 字的建议标题');
  if (clean.priority && !['P0', 'P1', 'P2'].includes(clean.priority)) throw new ApiError('priority 必须是 P0、P1 或 P2');
  if (clean.status && !['新建', '已确认', '开发中', '修复待测', '已通过', '暂缓'].includes(clean.status)) throw new ApiError('status 不在允许范围内');
  return clean;
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// A timed-out response must not duplicate a save. Confirm a retry only while
// the exact next revision is still present, authored by the same account and
// containing the same normalized user-editable fields. Any other stale write
// remains a conflict. Reads before a write are never used as a lock.
function isConfirmedRetry(row, expectedRevision, userId, item, fields, saved = row) {
  return row && validRevision(expectedRevision) && row.revision === expectedRevision + 1 &&
    row.updated_by === userId && fields.every((key) => (saved[key] ?? '') === (item[key] ?? ''));
}

function feedbackValue(row) {
  try { return { ...JSON.parse(row.payload), revision: row.revision }; }
  catch { return null; }
}

async function writeWithAudit(env, statement, userId, action, entityId = '') {
  // D1 batch is transactional. changes() refers to the preceding mutation,
  // excluding sync trigger updates, so a losing concurrent write has no audit
  // entry. An audit failure rolls back the data save as well.
  const [result] = await env.DB.batch([
    statement,
    env.DB.prepare('INSERT INTO audit_log(id,user_id,action,entity_id,created_at) SELECT ?,?,?,?,? WHERE changes()=1')
      .bind(crypto.randomUUID(), userId, action, entityId, new Date().toISOString())
  ]);
  return result;
}

function aiConfigured(env) {
  return Boolean(envText(env, 'SHIJIAN_BASE_URL') && envText(env, 'SHIJIAN_API_KEY') && envText(env, 'SHIJIAN_MODEL'));
}

function aiAllowed(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const old = (aiHits.get(ip) || []).filter((t) => now - t < AI_WINDOW_SECONDS * 1000);
  if (old.length >= AI_MAX_REQUESTS_PER_WINDOW) {
    aiHits.set(ip, old);
    return false;
  }
  old.push(now);
  aiHits.set(ip, old);
  if (aiHits.size > 2000) {
    for (const [key, value] of aiHits) if (!value.length || now - value[value.length - 1] >= AI_WINDOW_SECONDS * 1000) aiHits.delete(key);
  }
  return true;
}

function cleanMessages(messages, allowSystem = false) {
  if (!Array.isArray(messages) || !messages.length || messages.length > AI_MAX_MESSAGES) throw new ApiError(`messages 必须是 1-${AI_MAX_MESSAGES} 条的数组`);
  let total = 0;
  return messages.map((message, index) => {
    if (!message || typeof message !== 'object') throw new ApiError(`messages[${index}] 必须是对象`);
    const role = message.role;
    const content = message.content;
    const allowedRoles = allowSystem ? ['system', 'user', 'assistant'] : ['user', 'assistant'];
    if (!allowedRoles.includes(role)) throw new ApiError(`messages[${index}].role 不合法`);
    if (typeof content !== 'string' || !content.trim()) throw new ApiError(`messages[${index}].content 必须是文本`);
    if (content.length > AI_MAX_TEXT) throw new ApiError(`messages[${index}].content 过长`);
    total += content.length;
    if (total > AI_MAX_TOTAL) throw new ApiError(`messages 内容总长度不能超过 ${AI_MAX_TOTAL} 字符`);
    return { role, content };
  });
}

async function handleApi(request, env, path) {
  if (request.method === 'OPTIONS') {
    const headers = new Headers({ 'Access-Control-Max-Age': '86400' });
    addCors(headers, request, env);
    return new Response(null, { status: 204, headers });
  }
  if (request.method === 'POST') verifyOrigin(request, env);
  if (path === '/api/health' && request.method === 'GET') {
    try {
      await ensureDb(env);
      return jsonResponse({ ok: true, db_configured: true, ai_configured: aiConfigured(env) }, 200, request, env);
    } catch (error) {
      return jsonResponse({ ok: false, db_configured: false, ai_configured: aiConfigured(env), error: 'D1 数据库不可用' }, 503, request, env);
    }
  }
  if (path === '/api/config' && request.method === 'GET') {
    return jsonResponse({ configured: aiConfigured(env), model: aiConfigured(env) ? envText(env, 'SHIJIAN_MODEL') : '' }, 200, request, env);
  }
  await ensureDb(env);
  if (path.startsWith('/api/auth/')) {
    const response = await handleAuth(request, env, path, readJson);
    if (response) return jsonResponse(response.value, response.status || 200, request, env, response.headers || {});
    return errorResponse('接口不存在', 404, request, env);
  }
  const session = await getSession(request, env);
  if (path === '/api/sources' && request.method === 'GET') {
    const isDeveloper = session?.role === 'developer' && !session.must_change_password;
    const columns = `id,title,author,date,reliability,period,locator,content,visibility,revision,updated_at${isDeveloper ? ',updated_by' : ''}`;
    const query = `SELECT ${columns} FROM sources${isDeveloper ? '' : " WHERE visibility='published'"} ORDER BY updated_at DESC,id`;
    const { results = [] } = await env.DB.prepare(query).all();
    return jsonResponse(results, 200, request, env);
  }
  const protectedPaths = ['/api/settings', '/api/feedback', '/api/sync', '/api/v1/chat/completions', '/api/admin/overview', '/api/members', '/api/audit'];
  if (protectedPaths.includes(path) || (path === '/api/sources' && request.method === 'POST')) requireDeveloper(session);
  if (path === '/api/sync' && request.method === 'GET') {
    const { results = [] } = await env.DB.prepare('SELECT domain,revision FROM sync_versions ORDER BY domain').all();
    return jsonResponse(Object.fromEntries(results.map((row) => [row.domain, row.revision])), 200, request, env);
  }
  if (path === '/api/admin/overview' && request.method === 'GET') {
    const counts = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM sources) AS sourceCount,(SELECT COUNT(*) FROM feedback) AS feedbackCount,(SELECT COUNT(*) FROM users WHERE disabled=0) AS memberCount').first();
    return jsonResponse({ user: publicUser(session), ...counts, aiConfigured: aiConfigured(env) }, 200, request, env);
  }
  if (path === '/api/members' && request.method === 'GET') {
    const { results = [] } = await env.DB.prepare('SELECT id,username,display_name,role,must_change_password FROM users WHERE disabled=0 ORDER BY username').all();
    return jsonResponse({ items: results.map(publicUser) }, 200, request, env);
  }
  if (path === '/api/audit' && request.method === 'GET') {
    const { results = [] } = await env.DB.prepare('SELECT a.id,a.action,a.entity_id,a.created_at,u.display_name AS actor FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100').all();
    return jsonResponse({ items: results }, 200, request, env);
  }
  if (path === '/api/settings' && request.method === 'GET') {
    const item = await env.DB.prepare(`SELECT ${SETTINGS_COLUMNS} FROM team_settings WHERE id=1`).first();
    if (!item) throw new Error('Team settings migration missing');
    return jsonResponse(item, 200, request, env);
  }
  if (path === '/api/feedback' && request.method === 'GET') {
    const { results = [] } = await env.DB.prepare('SELECT payload,revision FROM feedback ORDER BY updated_at DESC LIMIT 1000').all();
    const rows = results.map(feedbackValue).filter(Boolean);
    return jsonResponse(rows, 200, request, env);
  }
  if (path === '/api/settings' && request.method === 'POST') {
    const data = await readJson(request);
    const item = { system_prompt: textValue(data.system_prompt, 'system_prompt', MAX_PROMPT), version: textValue(data.version, 'version', 100) };
    const conflict = () => new ApiError('团队规则已更新，请刷新规则后重新编辑；当前输入未保存', 409);
    if (!validRevision(data.revision) || data.revision < 1) throw conflict();
    const now = new Date().toISOString();
    const result = await writeWithAudit(env,
      env.DB.prepare('UPDATE team_settings SET system_prompt=?,version=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=1 AND revision=? RETURNING revision')
        .bind(item.system_prompt, item.version, now, session.id, data.revision), session.id, 'settings_updated');
    if (result.results?.length !== 1) {
      const saved = await env.DB.prepare(`SELECT ${SETTINGS_COLUMNS} FROM team_settings WHERE id=1`).first();
      if (isConfirmedRetry(saved, data.revision, session.id, item, ['system_prompt', 'version'])) {
        return jsonResponse({ ...saved, ok: true, replayed: true }, 200, request, env);
      }
      throw conflict();
    }
    return jsonResponse({ ...item, revision: data.revision + 1, updated_at: now, updated_by: session.id, ok: true }, 200, request, env);
  }
  if (path === '/api/sources' && request.method === 'POST') {
    const data = await readJson(request);
    if ('items' in data) throw new ApiError('已停止整库替换，请一次保存一条史料');
    const item = cleanSource(data.item);
    const existing = await env.DB.prepare('SELECT * FROM sources WHERE id=?').bind(item.id).first();
    const conflict = () => new ApiError('这条史料已被修改，请刷新后重新编辑；当前输入未保存', 409);
    const confirmRetry = (saved) => isConfirmedRetry(saved, data.item.revision, session.id, item, SOURCE_FIELDS);
    if (confirmRetry(existing)) return jsonResponse({ item: existing, replayed: true }, 200, request, env);
    const now = new Date().toISOString();
    const values = [item.title, item.author, item.date, item.reliability, item.period, item.locator, item.content, item.visibility, now, session.id];
    if (existing) {
      if (!validRevision(data.item.revision) || data.item.revision !== existing.revision) throw conflict();
      const result = await writeWithAudit(env,
        env.DB.prepare('UPDATE sources SET title=?,author=?,date=?,reliability=?,period=?,locator=?,content=?,visibility=?,updated_at=?,updated_by=?,revision=revision+1 WHERE id=? AND revision=? RETURNING revision')
          .bind(...values, item.id, data.item.revision), session.id, 'source_updated', item.id);
      if (result.results?.length !== 1) {
        const saved = await env.DB.prepare('SELECT * FROM sources WHERE id=?').bind(item.id).first();
        if (confirmRetry(saved)) return jsonResponse({ item: saved, replayed: true }, 200, request, env);
        throw conflict();
      }
      item.revision = data.item.revision + 1;
    } else {
      if (data.item.revision !== undefined && data.item.revision !== 0) throw new ApiError('这条史料已不存在，请刷新后重新添加', 409);
      const result = await writeWithAudit(env,
        env.DB.prepare('INSERT OR IGNORE INTO sources(title,author,date,reliability,period,locator,content,visibility,updated_at,updated_by,id,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,1) RETURNING revision')
          .bind(...values, item.id), session.id, 'source_created', item.id);
      if (result.results?.length !== 1) {
        const saved = await env.DB.prepare('SELECT * FROM sources WHERE id=?').bind(item.id).first();
        if (confirmRetry(saved)) return jsonResponse({ item: saved, replayed: true }, 200, request, env);
        throw conflict();
      }
      item.revision = 1;
    }
    item.updated_at = now;
    item.updated_by = session.id;
    return jsonResponse({ item }, existing ? 200 : 201, request, env);
  }
  if (path === '/api/feedback' && request.method === 'POST') {
    const data = await readJson(request);
    const value = cleanFeedback(data);
    const conflict = () => new ApiError('这条建议已被修改，请刷新后重新编辑；当前输入未保存', 409);
    const confirmRetry = (row) => row && isConfirmedRetry(row, data.revision, session.id, value, FEEDBACK_FIELDS, feedbackValue(row) || {});
    const previous = await env.DB.prepare('SELECT payload,revision,updated_by FROM feedback WHERE id=?').bind(value.id).first();
    if (confirmRetry(previous)) return jsonResponse({ ...feedbackValue(previous), replayed: true }, 200, request, env);
    if (previous && (!validRevision(data.revision) || data.revision !== previous.revision)) throw conflict();
    if (!previous && data.revision !== undefined && data.revision !== 0) throw conflict();
    value.author = session.display_name;
    value.updatedBy = session.display_name;
    value.updatedAt = new Date().toISOString();
    value.createdAt = value.updatedAt;
    if (previous) {
      try {
        const original = JSON.parse(previous.payload);
        value.author = original.author || value.author;
        value.createdAt = original.createdAt || value.createdAt;
      } catch { /* A malformed old record can be repaired by a logged-in member. */ }
    }
    value.revision = previous ? data.revision + 1 : 1;
    const statement = previous
      ? env.DB.prepare('UPDATE feedback SET payload=?,updated_at=?,updated_by=?,revision=revision+1 WHERE id=? AND revision=? RETURNING revision')
        .bind(JSON.stringify(value), value.updatedAt, session.id, value.id, data.revision)
      : env.DB.prepare('INSERT OR IGNORE INTO feedback(id,payload,updated_at,updated_by,revision) VALUES(?,?,?,?,1) RETURNING revision')
        .bind(value.id, JSON.stringify(value), value.updatedAt, session.id);
    const result = await writeWithAudit(env, statement, session.id, 'feedback_saved', value.id);
    if (result.results?.length !== 1) {
      const saved = await env.DB.prepare('SELECT payload,revision,updated_by FROM feedback WHERE id=?').bind(value.id).first();
      if (confirmRetry(saved)) return jsonResponse({ ...feedbackValue(saved), replayed: true }, 200, request, env);
      throw conflict();
    }
    return jsonResponse(value, 200, request, env);
  }
  if (path === '/api/v1/chat/completions' && request.method === 'POST') {
    if (!aiConfigured(env)) return errorResponse('团队尚未接入 AI 服务，请联系项目负责人配置', 503, request, env);
    if (!aiAllowed(request)) return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429, request, env, { 'Retry-After': String(AI_WINDOW_SECONDS) });
    const original = await readJson(request);
    const clientMessages = cleanMessages(original.messages);
    let systemPrompt = DEFAULT_PROMPT;
    try {
      const row = await env.DB.prepare('SELECT system_prompt FROM team_settings WHERE id=1').first();
      if (row?.system_prompt) systemPrompt = String(row.system_prompt).slice(0, MAX_PROMPT);
    } catch {
      // Keep the built-in safety rules if the settings row is unavailable.
    }
    // The browser may send user/assistant turns, but it cannot replace the
    // team's server-controlled system rules with a prompt-injection message.
    const data = {
      model: envText(env, 'SHIJIAN_MODEL'),
      messages: [{ role: 'system', content: systemPrompt }, ...clientMessages],
      max_tokens: outputTokenBudget(original.max_tokens)
    };
    for (const key of ['temperature', 'top_p', 'response_format']) if (key in original) data[key] = original[key];
    const base = envText(env, 'SHIJIAN_BASE_URL').replace(/\/$/, '');
    const target = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    let parsed;
    try { parsed = new URL(target); } catch { throw new ApiError('AI 服务配置异常，请联系项目负责人', 503); }
    if (parsed.protocol !== 'https:' || !parsed.hostname) throw new ApiError('AI 服务需要配置安全的 HTTPS 地址', 503);
    const { output, status: upstreamStatus } = await fetchAiResponse(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${envText(env, 'SHIJIAN_API_KEY')}` },
      body: JSON.stringify(data)
    });
    const headers = secureHeaders(new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }));
    addCors(headers, request, env);
    return new Response(output, { status: upstreamStatus, headers });
  }
  return errorResponse('unknown endpoint', 404, request, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url.pathname);
      if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse('method not allowed', 405, request, env);
      if (url.pathname === '/' || url.pathname === '') return Response.redirect(`${url.origin}/观史团队网站.html`, 302);
      const pagePath = decodeURIComponent(url.pathname).replace(/\.html$/, '').replace(/\/$/, '');
      if (['/admin', '/史鉴云端管理', '/史鉴建议中心'].includes(pagePath)) {
        const session = await getSession(request, env);
        if (!session || session.must_change_password || session.role !== 'developer') {
          return new Response(null, { status: 302, headers: { Location: '/login.html', 'Cache-Control': 'no-store' } });
        }
      }
      const asset = await env.ASSETS.fetch(request);
      const headers = secureHeaders(new Headers(asset.headers));
      if (headers.get('Content-Type')?.includes('text/html')) headers.set('Cache-Control', 'no-store');
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error.message, error.status, request, env, error.status === 429 ? { 'Retry-After': '900' } : {});
      console.error('史鉴请求处理失败');
      return errorResponse('服务暂时不可用，请稍后重试', 500, request, env);
    }
  }
};
