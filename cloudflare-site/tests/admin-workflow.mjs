import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run real UI handlers against delayed imports and a failed refresh after a
// successful write. No production account, document or database is involved.
const source = await readFile(new URL('../public/admin.js', import.meta.url), 'utf8');
const member = { id: 'test-member', displayName: '测试成员', username: 'tester', role: 'developer' };
const fieldNames = ['title', 'author', 'date', 'period', 'locator', 'content', 'reliability'];

async function harness() {
  const elements = new Map();
  const requests = [];
  let failReads = false;
  let importResolve;
  const database = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
      dataset: {}, options: [], handlers: {}, classList: { toggle() {} },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      querySelectorAll() { return []; },
      querySelector() { return element(selector + ' button'); },
      add(option) { this.options.push(option); },
      click() { return this.onclick?.(); },
      reset() { for (const item of Object.values(this.elements || {})) item.value = ''; },
    });
    return elements.get(selector);
  };
  const fields = Object.fromEntries(fieldNames.map(name => [name, element('field-' + name)]));
  fields[Symbol.iterator] = function* () { yield* Object.values(this); };
  fields.reliability.options = [{ value: '待核验' }];
  element('#sourceForm').elements = fields;
  element('#sourceFilter').value = 'all';
  const api = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, method: options.method || 'GET', body });
    if (path === '/api/admin/overview') return { sourceCount: 0, feedbackCount: 0, memberCount: 3, aiConfigured: false };
    if (path === '/api/members') return { items: [member] };
    if (path === '/api/sources' && options.method === 'POST') {
      const input = body.item;
      const old = input.id && database.get(input.id);
      if (old && input.revision !== old.revision) throw Object.assign(new Error('版本冲突'), { status: 409 });
      const item = { ...input, id: input.id || 'created-' + database.size, revision: (old?.revision || 0) + 1, updated_by: member.id };
      database.set(item.id, structuredClone(item));
      return { item };
    }
    if (path === '/api/sources') {
      if (failReads) throw new Error('模拟刷新网络失败');
      return [...database.values()].map(x => structuredClone(x));
    }
    if (path === '/api/auth/logout') return { ok: true };
    throw new Error('Unexpected API path: ' + path);
  };
  const context = vm.createContext({
    console, URL, crypto: globalThis.crypto, structuredClone,
    document: { querySelectorAll: () => [] },
    location: { hash: '#overview', replace() {}, reload() {} },
    window: { addEventListener() {} },
    confirm: () => true,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
  });
  const exports = {
    api, $: element, esc: value => String(value ?? ''),
    message: (el, text, error = false) => { el.textContent = text; el.error = error; },
    whoAmI: async () => member,
    arrayOf: value => Array.isArray(value) ? value : value?.items || [],
  };
  const site = new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context });
  const importer = new vm.SyntheticModule(['extractDocument'], function () {
    this.setExport('extractDocument', () => new Promise(resolve => { importResolve = resolve; }));
  }, { context });
  await importer.link(() => {});
  await importer.evaluate();
  const module = new vm.SourceTextModule(source, {
    context,
    importModuleDynamically: async specifier => {
      assert.equal(specifier, './import-document.js');
      return importer;
    },
  });
  await module.link(specifier => {
    assert.equal(specifier, './site.js');
    return site;
  });
  await module.evaluate();
  return {
    element, fields, requests, database,
    failReads(value) { failReads = value; },
    async save() { return element('#sourceForm').handlers.submit({ preventDefault() {}, submitter: { value: 'draft' } }); },
    async startImport() {
      const operation = element('#documentFile').onchange({ target: { files: [{ name: 'test.docx', size: 20 }], value: '' } });
      for (let n = 0; n < 10 && !importResolve; n++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(typeof importResolve, 'function', 'Delayed import must start');
      return { complete(text) { importResolve(text); return operation; } };
    },
  };
}

{
  const h = await harness();
  h.fields.title.value = '网络波动时仍应保存一次';
  h.fields.content.value = '第一次内容';
  h.failReads(true);
  await h.save();
  assert.equal(h.database.size, 1);
  assert.match(h.element('#sourceMessage').textContent, /已保存|已发布|保存成功|已存入|已更新/, 'Successful write must not be presented as a failed save');
  h.fields.content.value = '更新同一条资料';
  await h.save();
  const writes = h.requests.filter(x => x.method === 'POST' && x.path === '/api/sources');
  assert.equal(writes.length, 2);
  assert.equal(writes[1].body.item.id, [...h.database.keys()][0], 'Retry must use acknowledged item identity');
  assert.equal(writes[1].body.item.revision, 1, 'Retry must use acknowledged revision');
  assert.equal(h.database.size, 1, 'Retry must not create a duplicate');
  assert.equal([...h.database.values()][0].revision, 2);
  console.log('PASS 保存成功后刷新失败：正确提示，同条更新，无重复入库');
}

{
  const h = await harness();
  h.fields.title.value = '原资料';
  h.fields.content.value = '原正文';
  await h.save();
  const pending = await h.startImport();
  h.element('#newSource').onclick();
  const switched = h.fields.title.value !== '原资料';
  if (switched) {
    h.fields.title.value = '另一个新条目';
    h.fields.content.value = '不得被旧导入覆盖';
  }
  await pending.complete('提取出的文档文字');
  if (switched) assert.equal(h.fields.content.value, '不得被旧导入覆盖');
  else {
    assert.equal(h.fields.title.value, '原资料');
    assert.equal(h.fields.content.value, '提取出的文档文字');
  }
  const writes = h.requests.filter(x => x.method === 'POST' && x.path === '/api/sources');
  assert.equal(writes.length, 1, 'Preview extraction must not automatically save');
  console.log('PASS 文档提取期间切换资料：不会把旧结果灌入其他条目，预览不自动入库');
}
