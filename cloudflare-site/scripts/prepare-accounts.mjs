// Run once locally. Credentials and seed SQL stay outside all deployment folders.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/auth.js';
const project = fileURLToPath(new URL('..', import.meta.url));
const privateDir = path.resolve(project, '../../private/accounts');
await mkdir(privateDir, { recursive: true });
try { await access(path.join(privateDir, 'accounts.json')); throw new Error('账号文件已存在，停止生成以避免覆盖现有凭据。'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const accounts = [], statements = [];
for (let index = 1; index <= 3; index++) {
  const user = { id: randomUUID(), username: `member${index}`, displayName: `成员 ${index}`, password: 'Sj-' + randomBytes(18).toString('base64url') };
  const result = await hashPassword(user.password);
  const now = new Date().toISOString();
  const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
  statements.push(`INSERT INTO users(id,username,display_name,role,password_hash,password_salt,password_iterations,must_change_password,disabled,created_at,updated_at) VALUES(${[user.id,user.username,user.displayName,'developer',result.hash,result.salt].map(quote).join(',')},${result.iterations},1,0,${quote(now)},${quote(now)});`);
  accounts.push(user);
  const text = `史鉴 · ${user.displayName} 的独立开发者账号\r\n\r\n网站：https://shijian-team-site-public.pages.dev/\r\n登录：https://shijian-team-site-public.pages.dev/login.html\r\n账号：${user.username}\r\n临时密码：${user.password}\r\n\r\n首次登录必须改成你自己的密码（10—128 个字符）。\r\n登录后进入开发者后台，可上传资料、管理草稿与发布内容、提交团队建议。\r\n三个人使用不同账号，共用同一份云端资料库。不要共用账号。\r\n请只把本文件发给对应成员，不要公开发布密码。\r\n`;
  await writeFile(path.join(privateDir, `成员${index}账号.txt`), '\uFEFF' + text, { flag: 'wx' });
}
await writeFile(path.join(privateDir, 'accounts.json'), JSON.stringify(accounts, null, 2), { flag: 'wx' });
await writeFile(path.join(privateDir, 'seed.sql'), statements.join('\n'), { flag: 'wx' });
console.log('已生成 3 份独立账号说明和私有初始化 SQL；未输出密码。');
