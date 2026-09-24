const COOKIE_NAME = '__Host-shijian_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const PASSWORD_ITERATIONS = 100000;
const encoder = new TextEncoder();

export class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function hex(bytes) { return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join(''); }
function randomHex(length) { return hex(crypto.getRandomValues(new Uint8Array(length))); }
async function digest(value) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }

export async function hashPassword(password, salt = randomHex(16), iterations = PASSWORD_ITERATIONS) {
  if (!/^[a-f0-9]{32}$/i.test(salt)) throw new Error('Invalid password salt');
  const saltBytes = Uint8Array.from(salt.match(/../g), (x) => parseInt(x, 16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, key, 256);
  return { hash: hex(new Uint8Array(bits)), salt, iterations };
}

async function passwordMatches(password, record) {
  const result = await hashPassword(password, record?.password_salt || '00000000000000000000000000000000', record?.password_iterations || PASSWORD_ITERATIONS);
  const expected = record?.password_hash || '0'.repeat(64);
  let difference = result.hash.length ^ expected.length;
  for (let i = 0; i < result.hash.length; i++) difference |= result.hash.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
  return difference === 0 && Boolean(record);
}

export function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.display_name, role: user.role, mustChangePassword: Boolean(user.must_change_password) };
}

function cookieToken(request) {
  const cookies = request.headers.get('Cookie') || '';
  const item = cookies.split(';').map((x) => x.trim()).find((x) => x.startsWith(`${COOKIE_NAME}=`));
  const token = item?.slice(COOKIE_NAME.length + 1) || '';
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}

function sessionCookie(token, maxAge = SESSION_SECONDS) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function getSession(request, env) {
  const token = cookieToken(request);
  if (!token) return null;
  const tokenHash = await digest(token);
  const row = await env.DB.prepare('SELECT u.*,s.token_hash AS session_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0 LIMIT 1')
    .bind(tokenHash, new Date().toISOString()).first();
  return row || null;
}

export function requireDeveloper(session) {
  if (!session) throw new ApiError('请先登录开发者账号', 401);
  if (session.must_change_password) throw new ApiError('请先修改初始密码，再进入开发者后台', 403);
  if (session.role !== 'developer') throw new ApiError('当前账号没有开发者权限', 403);
  return session;
}

export function verifyOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return;
  const allowed = [new URL(request.url).origin, ...(typeof env.SHIJIAN_ALLOWED_ORIGINS === 'string' ? env.SHIJIAN_ALLOWED_ORIGINS.split(',') : [])].map((x) => x.trim().replace(/\/$/, ''));
  if (origin === 'null' || !allowed.includes(origin.replace(/\/$/, ''))) throw new ApiError('请求来源不被允许，请从本站重新操作', 403);
}

export function auditStatement(env, userId, action, entityId = '') {
  return env.DB.prepare('INSERT INTO audit_log(id,user_id,action,entity_id,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(), userId, action, entityId, new Date().toISOString());
}

async function consumeLimit(env, key, maxAttempts, windowSeconds = 900) {
  const now = Math.floor(Date.now() / 1000);
  const bucket = `${key}:${Math.floor(now / windowSeconds)}`;
  const result = await env.DB.prepare('INSERT INTO auth_rate_limits(bucket,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts')
    .bind(bucket, now + windowSeconds * 2).first();
  if (Number(result?.attempts || 0) > maxAttempts) throw new ApiError('尝试次数过多，请 15 分钟后重试', 429);
}

async function newSession(env, userId) {
  const token = randomHex(32);
  const now = new Date();
  return {
    token,
    statement: env.DB.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)')
      .bind(await digest(token), userId, now.toISOString(), new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString())
  };
}

function inputPassword(value) {
  return typeof value === 'string' && value.length <= 128 ? value : '';
}

export async function handleAuth(request, env, path, readJson) {
  if (path === '/api/auth/me' && request.method === 'GET') {
    const user = await getSession(request, env);
    return { value: { user: user ? publicUser(user) : null } };
  }
  if (path === '/api/auth/login' && request.method === 'POST') {
    const data = await readJson(request);
    const username = typeof data.username === 'string' ? data.username.trim().toLowerCase().slice(0, 100) : '';
    const password = inputPassword(data.password);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    await consumeLimit(env, `login-ip:${await digest(ip)}`, 30);
    await consumeLimit(env, `login-user:${await digest(username)}`, 10);
    const user = await env.DB.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE LIMIT 1').bind(username).first();
    const valid = await passwordMatches(password, user);
    if (!valid || user.disabled || !username || !password) throw new ApiError('账号或密码不正确', 401);
    const session = await newSession(env, user.id);
    const previousToken = cookieToken(request);
    const statements = [
      env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(new Date().toISOString()),
      env.DB.prepare('DELETE FROM auth_rate_limits WHERE expires_at<?').bind(Math.floor(Date.now() / 1000)),
      session.statement,
      auditStatement(env, user.id, 'login')
    ];
    if (previousToken) statements.unshift(env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(previousToken)));
    await env.DB.batch(statements);
    return { value: { user: publicUser(user) }, headers: { 'Set-Cookie': sessionCookie(session.token) } };
  }
  if (path === '/api/auth/logout' && request.method === 'POST') {
    const token = cookieToken(request);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();
    return { value: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
  }
  if (path === '/api/auth/password' && request.method === 'POST') {
    const user = await getSession(request, env);
    if (!user) throw new ApiError('请先登录开发者账号', 401);
    await consumeLimit(env, `password:${user.id}`, 10);
    const data = await readJson(request);
    const currentPassword = inputPassword(data.currentPassword);
    const newPassword = inputPassword(data.newPassword);
    if (!await passwordMatches(currentPassword, user)) throw new ApiError('当前密码不正确', 400);
    if (newPassword.length < 10 || newPassword.length > 128) throw new ApiError('新密码需要 10—128 个字符', 400);
    if (newPassword === currentPassword) throw new ApiError('新密码不能与当前密码相同', 400);
    const password = await hashPassword(newPassword);
    const session = await newSession(env, user.id);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash=?,password_salt=?,password_iterations=?,must_change_password=0,updated_at=? WHERE id=?')
        .bind(password.hash, password.salt, password.iterations, new Date().toISOString(), user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id),
      session.statement,
      auditStatement(env, user.id, 'password_changed')
    ]);
    return { value: { user: publicUser({ ...user, must_change_password: 0 }) }, headers: { 'Set-Cookie': sessionCookie(session.token) } };
  }
  return null;
}
