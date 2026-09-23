import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 8791;
const persist = '.wrangler-e2e';
const team = 'team-e2e-token';
const admin = 'admin-e2e-token';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(npx, args, { stdio: 'ignore', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`命令退出码 ${code}: ${args.join(' ')}`)));
  });
}

await run(['wrangler', 'd1', 'migrations', 'apply', 'shijian-team-db', '--local', '--config', 'wrangler.json', '--persist-to', persist]);
function startServer() {
  return spawn(npx, [
    'wrangler', 'dev', '--local', '--port', String(port), '--persist-to', persist,
    '--var', `SHIJIAN_TEAM_TOKEN:${team}`, '--var', `SHIJIAN_ADMIN_TOKEN:${admin}`,
    '--show-interactive-dev-session=false', '--config', 'wrangler.json'
  ], { stdio: 'ignore', shell: process.platform === 'win32' });
}

async function waitForHealth() {
  let health;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      health = await fetch(`http://127.0.0.1:${port}/api/health`, { cache: 'no-store' });
      if (health.status) break;
    } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  assert.equal(health?.status, 200, '本地 Worker 未启动');
  assert.equal((await health.json()).db_configured, true);
}

let server = startServer();
try {
  await waitForHealth();

  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/feedback`);
  assert.equal(unauthorized.status, 403, '反馈 GET 必须要求团队邀请码');
  const headers = { 'Content-Type': 'application/json', 'X-Team-Token': team };
  const first = await fetch(`http://127.0.0.1:${port}/api/feedback`, { headers });
  assert.equal(first.status, 200);
  const item = { id: 'E2E1', createdAt: new Date().toISOString(), author: '测试', category: '其他', priority: 'P2', title: '本地 D1 持久化检查', scenario: 'e2e', acceptance: '读取到同一条记录', status: '新建' };
  const saved = await fetch(`http://127.0.0.1:${port}/api/feedback`, { method: 'POST', headers, body: JSON.stringify(item) });
  assert.equal(saved.status, 200);
  const listed = await fetch(`http://127.0.0.1:${port}/api/feedback`, { headers });
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).some((x) => x.id === item.id), 'D1 未读回刚写入的反馈');

  const deniedSettings = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ system_prompt: 'x', version: 'e2e' }) });
  assert.equal(deniedSettings.status, 403, '普通团队令牌不能改管理员设置');
  const adminSettings = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': admin }, body: JSON.stringify({ system_prompt: 'x', version: 'e2e' }) });
  assert.equal(adminSettings.status, 200, '管理员令牌不能保存设置');

  // Restart the Worker against the same --persist-to directory. A second
  // process must still see the row, proving this is D1 persistence rather
  // than only an in-memory Worker isolate cache.
  server.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 800));
  server = startServer();
  await waitForHealth();
  const afterRestart = await fetch(`http://127.0.0.1:${port}/api/feedback`, { headers });
  assert.equal(afterRestart.status, 200);
  assert.ok((await afterRestart.json()).some((x) => x.id === item.id), 'Worker 重启后 D1 记录丢失');
  console.log('Cloudflare local D1 e2e checks passed');
} finally {
  server.kill('SIGTERM');
}
