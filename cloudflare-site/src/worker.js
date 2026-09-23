/**
 * 史鉴团队网站：Cloudflare Worker + D1 API。
 *
 * The HTML files in ../public are served by the Workers Assets binding.  This
 * Worker keeps the API contract used by the existing pages so the UI does not
 * need a second, Cloudflare-specific build.
 */

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
const AI_UPSTREAM_TIMEOUT_MS = 25000;
const AI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

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
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token, X-Team-Token, Authorization');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
}

function secureHeaders(headers) {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return headers;
}

function errorResponse(message, status = 400, request, env) {
  return jsonResponse({ error: message }, status, request, env);
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
  if (length > MAX_BODY) throw new Error('请求内容过大（上限 1 MB）');
  const type = request.headers.get('Content-Type')?.split(';', 1)[0]?.toLowerCase();
  if (type !== 'application/json') throw new Error('POST 必须使用 application/json');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error('请求内容过大（上限 1 MB）');
  const value = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JSON 根对象必须是对象');
  }
  return value;
}

function textValue(value, name, limit = MAX_FEEDBACK_FIELD) {
  if (value === undefined || value === null) return '';
  if (!['string', 'number'].includes(typeof value)) throw new Error(`${name} 必须是文本`);
  const text = String(value).trim();
  if (text.length > limit) throw new Error(`${name} 过长`);
  return text;
}

function cleanSource(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('史料条目必须是对象');
  const id = textValue(input.id, '史料 ID', 64);
  if (!id || !ID_RE.test(id)) throw new Error('史料 ID 格式不正确');
  return {
    id,
    title: textValue(input.title, '标题', 500),
    author: textValue(input.author, '作者', 300),
    date: textValue(input.date, '日期', 100),
    reliability: textValue(input.reliability || '待核验', '可靠性', 100),
    period: textValue(input.period, '时期', 200),
    locator: textValue(input.locator, '页码或链接', 1000),
    content: textValue(input.content, '内容', MAX_SOURCE_CONTENT)
  };
}

function cleanFeedback(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('反馈必须是对象');
  const id = textValue(input.id, 'id', 64);
  if (!id || !ID_RE.test(id)) throw new Error('id 只能包含字母、数字、下划线或短横线');
  const fields = ['createdAt', 'author', 'category', 'priority', 'title', 'targetVersion', 'scenario', 'current', 'desired', 'evidence', 'acceptance', 'notes', 'status', 'owner', 'retest'];
  const clean = { id };
  for (const field of fields) clean[field] = textValue(input[field], field);
  if (clean.title.length > 300) throw new Error('标题过长');
  if (clean.priority && !['P0', 'P1', 'P2'].includes(clean.priority)) throw new Error('priority 必须是 P0、P1 或 P2');
  if (clean.status && !['新建', '已确认', '开发中', '修复待测', '已通过', '暂缓'].includes(clean.status)) throw new Error('status 不在允许范围内');
  return clean;
}

function tokenMatches(request, env, key) {
  const expected = envText(env, key);
  if (!expected) return false;
  const provided = request.headers.get(key === 'SHIJIAN_ADMIN_TOKEN' ? 'X-Admin-Token' : 'X-Team-Token') || '';
  // Constant-time comparison is not exposed by the Workers Web API. Keeping
  // the value out of URLs and using a long random secret avoids practical
  // leakage; token values are never included in responses or logs.
  return provided.length === expected.length && provided === expected;
}

function isAdmin(request, env) {
  return tokenMatches(request, env, 'SHIJIAN_ADMIN_TOKEN');
}

function isTeamMember(request, env) {
  // All three members use one separately stored invite token. The admin token
  // is accepted as a recovery path, but is never returned to the browser.
  return tokenMatches(request, env, 'SHIJIAN_TEAM_TOKEN') || isAdmin(request, env);
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
  if (!Array.isArray(messages) || !messages.length || messages.length > AI_MAX_MESSAGES) throw new Error(`messages 必须是 1-${AI_MAX_MESSAGES} 条的数组`);
  let total = 0;
  return messages.map((message, index) => {
    if (!message || typeof message !== 'object') throw new Error(`messages[${index}] 必须是对象`);
    const role = message.role;
    const content = message.content;
    const allowedRoles = allowSystem ? ['system', 'user', 'assistant'] : ['user', 'assistant'];
    if (!allowedRoles.includes(role)) throw new Error(`messages[${index}].role 不合法`);
    if (typeof content !== 'string' || !content.trim()) throw new Error(`messages[${index}].content 必须是文本`);
    if (content.length > AI_MAX_TEXT) throw new Error(`messages[${index}].content 过长`);
    total += content.length;
    if (total > AI_MAX_TOTAL) throw new Error(`messages 内容总长度不能超过 ${AI_MAX_TOTAL} 字符`);
    return { role, content };
  });
}

async function handleApi(request, env, path) {
  if (request.method === 'OPTIONS') {
    const headers = new Headers({ 'Access-Control-Max-Age': '86400' });
    addCors(headers, request, env);
    return new Response(null, { status: 204, headers });
  }
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
  if (path === '/api/settings' && request.method === 'GET') {
    const { results = [] } = await env.DB.prepare('SELECT key,value FROM settings').all();
    const values = Object.fromEntries(results.map((row) => [row.key, row.value]));
    return jsonResponse({ system_prompt: values.system_prompt || DEFAULT_PROMPT, version: values.version || 'v0.1' }, 200, request, env);
  }
  if (path === '/api/sources' && request.method === 'GET') {
    const { results = [] } = await env.DB.prepare('SELECT id,title,author,date,reliability,period,locator,content FROM sources ORDER BY id').all();
    return jsonResponse(results, 200, request, env);
  }
  if (path === '/api/feedback' && request.method === 'GET') {
    if (!isTeamMember(request, env)) return errorResponse('团队邀请码不正确', 403, request, env);
    const { results = [] } = await env.DB.prepare('SELECT payload FROM feedback ORDER BY updated_at DESC LIMIT 1000').all();
    const rows = [];
    for (const row of results) {
      try { rows.push(JSON.parse(row.payload)); } catch { /* ignore a corrupt row rather than breaking the board */ }
    }
    return jsonResponse(rows, 200, request, env);
  }
  if (path === '/api/settings' && request.method === 'POST') {
    if (!isAdmin(request, env)) return errorResponse('管理员令牌不正确', 403, request, env);
    const data = await readJson(request);
    const prompt = textValue(data.system_prompt, 'system_prompt', MAX_PROMPT);
    const version = textValue(data.version, 'version', 100);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind('system_prompt', prompt),
      env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind('version', version)
    ]);
    return jsonResponse({ ok: true }, 200, request, env);
  }
  if (path === '/api/sources' && request.method === 'POST') {
    if (!isAdmin(request, env)) return errorResponse('管理员令牌不正确', 403, request, env);
    const data = await readJson(request);
    if (!Array.isArray(data.items) || data.items.length > 1000) throw new Error('items 必须是最多 1000 条的数组');
    const rows = data.items.map(cleanSource);
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('史料 ID 不能重复');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sources'),
      ...rows.map((row) => env.DB.prepare('INSERT INTO sources(id,title,author,date,reliability,period,locator,content) VALUES(?,?,?,?,?,?,?,?)').bind(row.id, row.title, row.author, row.date, row.reliability, row.period, row.locator, row.content))
    ]);
    return jsonResponse({ ok: true, count: rows.length }, 200, request, env);
  }
  if (path === '/api/feedback' && request.method === 'POST') {
    if (!isTeamMember(request, env)) return errorResponse('团队邀请码不正确', 403, request, env);
    const value = cleanFeedback(await readJson(request));
    await env.DB.prepare('INSERT INTO feedback(id,payload,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at')
      .bind(value.id, JSON.stringify(value), new Date().toISOString()).run();
    return jsonResponse(value, 200, request, env);
  }
  if (path === '/api/v1/chat/completions' && request.method === 'POST') {
    if (!isTeamMember(request, env)) return errorResponse('团队邀请码不正确', 403, request, env);
    if (!aiConfigured(env)) return errorResponse('AI 未配置，请在 Worker secrets 中设置 SHIJIAN_BASE_URL、SHIJIAN_API_KEY、SHIJIAN_MODEL', 503, request, env);
    if (!aiAllowed(request)) return jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429, request, env, { 'Retry-After': String(AI_WINDOW_SECONDS) });
    const original = await readJson(request);
    const clientMessages = cleanMessages(original.messages);
    let systemPrompt = DEFAULT_PROMPT;
    try {
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key='system_prompt' LIMIT 1").first();
      if (row?.value) systemPrompt = String(row.value).slice(0, MAX_PROMPT);
    } catch {
      // Keep the built-in safety rules if the settings row is unavailable.
    }
    // The browser may send user/assistant turns, but it cannot replace the
    // team's server-controlled system rules with a prompt-injection message.
    const data = {
      model: envText(env, 'SHIJIAN_MODEL'),
      messages: [{ role: 'system', content: systemPrompt }, ...clientMessages]
    };
    for (const key of ['temperature', 'top_p', 'max_tokens', 'response_format']) if (key in original) data[key] = original[key];
    const base = envText(env, 'SHIJIAN_BASE_URL').replace(/\/$/, '');
    const target = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    let parsed;
    try { parsed = new URL(target); } catch { throw new Error('AI 地址格式不正确'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('AI 地址必须是 http 或 https');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_UPSTREAM_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(parsed, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${envText(env, 'SHIJIAN_API_KEY')}` },
        body: JSON.stringify(data),
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('AI 上游响应超时，请稍后重试');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const declaredLength = Number(upstream.headers.get('Content-Length') || 0);
    if (declaredLength > AI_MAX_RESPONSE_BYTES) throw new Error('AI 上游响应过大');
    const output = await upstream.arrayBuffer();
    if (output.byteLength > AI_MAX_RESPONSE_BYTES) throw new Error('AI 上游响应过大');
    const headers = new Headers({ 'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    addCors(headers, request, env);
    return new Response(output, { status: upstream.status, headers });
  }
  return errorResponse('unknown endpoint', 404, request, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url.pathname);
      if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse('method not allowed', 405, request, env);
      if (url.pathname === '/' || url.pathname === '') return Response.redirect(`${url.origin}/史鉴团队网站.html`, 302);
      const asset = await env.ASSETS.fetch(request);
      const headers = secureHeaders(new Headers(asset.headers));
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    } catch (error) {
      console.error('史鉴请求失败', error?.message || error);
      return errorResponse(error?.message || '服务器内部错误', 500, request, env);
    }
  }
};
