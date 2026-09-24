import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import worker from '../src/worker.js';
import { ApiError, hashPassword, publicUser, requireDeveloper, verifyOrigin } from '../src/auth.js';

const salt = '0102030405060708090a0b0c0d0e0f10';
const password = '这是安全测试用密码-2026';
const derived = await hashPassword(password, salt);
assert.equal(derived.iterations, 100000);
assert.equal(derived.hash, pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'));
const generated = await hashPassword(password);
assert.match(generated.salt, /^[a-f0-9]{32}$/);
assert.notEqual(generated.hash, derived.hash);

const user = { id: 'test-id', username: 'member1', display_name: '成员 1', role: 'developer', must_change_password: 1, password_hash: 'private', password_salt: 'private' };
assert.deepEqual(publicUser(user), { id: 'test-id', username: 'member1', displayName: '成员 1', role: 'developer', mustChangePassword: true });
assert.throws(() => requireDeveloper(null), (error) => error instanceof ApiError && error.status === 401);
assert.throws(() => requireDeveloper(user), (error) => error instanceof ApiError && error.status === 403);
assert.equal(requireDeveloper({ ...user, must_change_password: 0 }).id, user.id);

const site = 'https://team.example';
verifyOrigin(new Request(`${site}/api/auth/logout`, { method: 'POST', headers: { Origin: site } }), {});
verifyOrigin(new Request(`${site}/api/auth/logout`, { method: 'POST' }), {});
verifyOrigin(new Request(`${site}/api/auth/logout`, { method: 'POST', headers: { Origin: 'https://shijian-team-site-public.pages.dev' } }), { SHIJIAN_ALLOWED_ORIGINS: 'https://shijian-team-site-public.pages.dev' });
for (const origin of ['null', 'https://attacker.example', 'https://team.example.attacker.example']) {
  assert.throws(() => verifyOrigin(new Request(`${site}/api/auth/logout`, { method: 'POST', headers: { Origin: origin } }), {}), (error) => error.status === 403);
}

const db = { prepare(query) { if (query === 'SELECT 1 AS ok') return { first: async () => 1 }; throw new Error('Unexpected private database detail'); } };
const env = { DB: db, SHIJIAN_TEAM_TOKEN: 'old-invite', SHIJIAN_ADMIN_TOKEN: 'old-admin' };
for (const [method, path] of [['GET', '/api/settings'], ['GET', '/api/feedback'], ['GET', '/api/members'], ['GET', '/api/audit'], ['GET', '/api/admin/overview'], ['POST', '/api/sources'], ['POST', '/api/settings'], ['POST', '/api/feedback'], ['POST', '/api/v1/chat/completions']]) {
  const response = await worker.fetch(new Request(`${site}${path}`, { method, headers: { 'X-Team-Token': 'old-invite', 'X-Admin-Token': 'old-admin' } }), env);
  assert.equal(response.status, 401, `${method} ${path} must reject old shared tokens`);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
}
const anonymous = await worker.fetch(new Request(`${site}/api/auth/me`), env);
assert.deepEqual(await anonymous.json(), { user: null });
const rejectedOrigin = await worker.fetch(new Request(`${site}/api/auth/login`, { method: 'POST', headers: { Origin: 'https://attacker.example' } }), env);
assert.equal(rejectedOrigin.status, 403);
const malformed = await worker.fetch(new Request(`${site}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), env);
assert.equal(malformed.status, 400);
const secretDb = { prepare() { throw new Error('SECRET_DATABASE_PASSWORD_SHOULD_NOT_LEAK'); } };
const failed = await worker.fetch(new Request(`${site}/api/auth/me`), { DB: secretDb });
assert.equal(failed.status, 500);
assert.equal((await failed.json()).error, '服务暂时不可用，请稍后重试');
console.log('Authentication security unit checks passed');
