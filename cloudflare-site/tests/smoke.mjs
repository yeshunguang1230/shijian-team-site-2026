import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../src/worker.js';

const assets = {
  fetch(request) {
    const url = new URL(request.url);
    if (decodeURIComponent(url.pathname) === '/史鉴团队网站.html') {
      return Promise.resolve(new Response('<!doctype html><title>史鉴</title>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  }
};

const db = { prepare() { return { first: async () => 1 }; } };
const env = { ASSETS: assets, DB: db };

const health = await worker.fetch(new Request('https://example.workers.dev/api/health'), env);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { ok: true, db_configured: true, ai_configured: false });

const config = await worker.fetch(new Request('https://example.workers.dev/api/config'), env);
assert.equal(config.status, 200);
assert.deepEqual(await config.json(), { configured: false, model: '' });

const root = await worker.fetch(new Request('https://example.workers.dev/'), env);
assert.equal(root.status, 302);
assert.equal(decodeURIComponent(new URL(root.headers.get('Location')).pathname), '/史鉴团队网站.html');

const page = await worker.fetch(new Request('https://example.workers.dev/史鉴团队网站.html'), env);
assert.equal(page.status, 200);
assert.equal(page.headers.get('X-Content-Type-Options'), 'nosniff');

console.log('Cloudflare Worker smoke checks passed');

for (const file of ['史鉴团队网站.html', '史鉴智能体.html', '史鉴建议中心.html', '史鉴云端管理.html']) {
  const html = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length, `${file} 没有脚本`);
  for (const match of scripts) assert.doesNotThrow(() => new Function(match[1]), `${file} 内嵌脚本语法错误`);
}
console.log('Frontend script syntax checks passed');
