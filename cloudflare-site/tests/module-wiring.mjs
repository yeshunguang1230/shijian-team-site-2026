import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Verify entry-point static imports against the REAL on-disk modules using Node's
// native ESM loader — not a VM sandbox or a mocked module. This is the guard
// against a stale-cache/new-entry-point mismatch (round 3, issue 4): if a shared
// dependency is renamed or loses an export, this test fails the same way a real
// browser would fail to link the module graph.
async function checkStaticImports(fileUrl) {
  const source = await readFile(fileUrl, 'utf8');
  const importRegex = /import\s*\{([^}]*)\}\s*from\s*['"](\.\/[^'"]+)['"]/g;
  const specifiers = [];
  let match;
  while ((match = importRegex.exec(source))) {
    const names = match[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    specifiers.push({ path: match[2], names });
  }
  for (const { path: relPath, names } of specifiers) {
    const targetUrl = new URL(relPath, fileUrl);
    const moduleNamespace = await import(targetUrl.href);
    for (const name of names) {
      assert.ok(name in moduleNamespace, `${fileUrl} imports '${name}' from '${relPath}', but that real module (no mock) does not export it`);
    }
  }
  return specifiers;
}

const adminUrl = new URL('../public/admin.js', import.meta.url);
const loginUrl = new URL('../public/login.js', import.meta.url);

const adminSpecs = await checkStaticImports(adminUrl);
assert.ok(adminSpecs.some(s => s.path === './logout-notice.js' && s.names.includes('LOGOUT_WARNING')), 'admin.js must import LOGOUT_WARNING from its own independent logout-notice.js module, not from the shared site.js');

const loginSpecs = await checkStaticImports(loginUrl);
assert.ok(loginSpecs.some(s => s.path === './logout-notice.js' && s.names.includes('LOGOUT_WARNING')), 'login.js must import LOGOUT_WARNING from its own independent logout-notice.js module, not from the shared site.js');

for (const specs of [adminSpecs, loginSpecs]) {
  const siteImport = specs.find(s => s.path === './site.js');
  if (siteImport) assert.ok(!siteImport.names.includes('LOGOUT_WARNING'), 'site.js must not be relied on for LOGOUT_WARNING, to avoid mixing an old cached site.js with a new entry point that expects this export');
}

console.log('PASS admin.js / login.js 的静态 import 依赖，在真实模块文件（非模拟模块）中都能找到对应的具名导出，且 LOGOUT_WARNING 已从共享的 site.js 中独立出来');
