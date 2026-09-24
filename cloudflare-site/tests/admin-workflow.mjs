import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run real UI handlers against delayed imports and a failed refresh after a
// successful write. No production account, document or database is involved.
const source = await readFile(new URL('../public/admin.js', import.meta.url), 'utf8');
const draftSource = await readFile(new URL('../public/workspace-draft.js', import.meta.url), 'utf8');
const exportSource = await readFile(new URL('../public/feedback-export.js', import.meta.url), 'utf8');
const member = { id: 'test-member', displayName: '测试成员', username: 'tester', role: 'developer' };
const fieldNames = ['title', 'author', 'date', 'period', 'locator', 'content', 'reliability'];

async function harness({storageMap=new Map(),delaySettings=false}={}) {
  const elements = new Map();
  const requests = [];
  let failReads = false;
  let importResolve;
  const database = new Map();
  const listeners = new Map();
  const intervals = [];
  const sync = {sources:1,feedback:1,settings:1};
  let loseWriteResponse=false;
  const settingsWaiters=[];
  const feedback=new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
      dataset: {}, options: [], handlers: {}, classList: { toggle() {} },
      addEventListener(type, handler) { this.handlers[type] = handler; },
      querySelectorAll() { return []; },
      querySelector() { return element(selector + ' button'); },
      add(option) { this.options.push(option); },
      click() { return this.onclick?.(); },
      focus() {},select() {},
      setAttribute(name,value) { this[name]=value; },
      reset() { for (const item of Object.values(this.elements || {})) item.value = ''; },
    });
    return elements.get(selector);
  };
  const fields = Object.fromEntries(fieldNames.map(name => [name, element('field-' + name)]));
  fields[Symbol.iterator] = function* () { yield* Object.values(this); };
  fields.reliability.options = [{ value: '待核验' }];
  element('#sourceForm').elements = fields;
  for(const [selector,names] of [
    ['#feedbackForm',['title','category','priority','scenario','desired','evidence','acceptance']],
    ['#settingsForm',['version','system_prompt']],
  ]){
    const group=Object.fromEntries(names.map(name=>[name,element(selector+'-'+name)]));
    group[Symbol.iterator]=function*(){yield* Object.values(this)};
    element(selector).elements=group;
  }
  element('#sourceFilter').value = 'all';
  const api = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, method: options.method || 'GET', body });
    if (path === '/api/admin/overview') return { sourceCount: 0, feedbackCount: 0, memberCount: 3, aiConfigured: false };
    if (path === '/api/members') return { items: [member] };
    if (path === '/api/sync') return {...sync};
    if (path === '/api/config') return {configured:false};
    if (path === '/api/settings') {
      if(delaySettings)return new Promise(resolve=>settingsWaiters.push(resolve));
      return {revision:1,version:'test',system_prompt:'云端规则'};
    }
    if (path === '/api/feedback' && options.method === 'POST') {
      if(feedback.has(body.id))throw Object.assign(new Error('版本冲突'),{status:409});
      feedback.set(body.id,{...body,revision:1});
      if(loseWriteResponse){loseWriteResponse=false;throw new Error('模拟建议响应丢失');}
      return feedback.get(body.id);
    }
    if (path === '/api/feedback') return [...feedback.values()];
    if (path === '/api/sources' && options.method === 'POST') {
      const input = body.item;
      const old = input.id && database.get(input.id);
      if(old&&old.revision===input.revision+1&&fieldNames.every(key=>(old[key]||'')===(input[key]||'')))return {item:structuredClone(old),replayed:true};
      if (old && input.revision !== old.revision) throw Object.assign(new Error('版本冲突'), { status: 409 });
      const item = { ...input, id: input.id || 'created-' + database.size, revision: (old?.revision || 0) + 1, updated_by: member.id };
      database.set(item.id, structuredClone(item));
      sync.sources++;
      if(loseWriteResponse){loseWriteResponse=false;throw new Error('模拟响应丢失，但已存入云端');}
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
    document: {hidden:false, querySelectorAll: () => [],addEventListener(type,handler){listeners.set('document:'+type,handler)}},
    location: { hash: '#overview', replace() {}, reload() {} },
    window: {addEventListener(type,handler){listeners.set(type,handler)}},
    localStorage:{get length(){return storageMap.size},key:index=>[...storageMap.keys()][index],getItem:key=>storageMap.get(key)??null,setItem:(key,value)=>storageMap.set(key,value),removeItem:key=>storageMap.delete(key)},
    setTimeout,clearTimeout,setInterval:fn=>{intervals.push(fn);return intervals.length},clearInterval(){},
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
  const draftModule=new vm.SourceTextModule(draftSource,{context});
  await draftModule.link(()=>{});
  const exportModule=new vm.SourceTextModule(exportSource,{context});
  await exportModule.link(()=>{});
  const module = new vm.SourceTextModule(source, {
    context,
    importModuleDynamically: async specifier => {
      assert.equal(specifier, './import-document.js');
      return importer;
    },
  });
  await module.link(specifier => {
    if(specifier==='./workspace-draft.js')return draftModule;
    if(specifier==='./feedback-export.js')return exportModule;
    assert.equal(specifier, './site.js');
    return site;
  });
  await module.evaluate();
  return {
    element, fields, requests, database,storageMap,context,sync,listeners,settingsWaiters,feedback,
    async event(type,payload={preventDefault(){}}){await listeners.get(type)?.(payload)},
    async open(view){context.location.hash='#'+view;await listeners.get('hashchange')?.()},
    async poll(){await element('#checkSync').onclick()},
    loseResponse(){loseWriteResponse=true},
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
  const h=await harness();
  h.feedback.set('F-visible',{id:'F-visible',revision:4,title:'保留多行证据',status:'开发中',author:'测试成员',evidence:'第一行\n第二行',acceptance:'能核对来源'});
  h.feedback.set('F-hidden',{id:'F-hidden',revision:1,title:'其他筛选的建议',status:'新建'});
  h.element('#feedbackFilter').value='开发中';await h.open('feedback');
  await h.element('#copyFeedback').onclick();
  const summary=h.element('#feedbackExportText').value;
  assert.match(summary,/F-visible/);assert.match(summary,/记录版本（revision）：4/);
  assert.match(summary,/第一行\n第二行/);assert.match(summary,/能核对来源/);
  assert.doesNotMatch(summary,/F-hidden|其他筛选的建议/);
  assert.equal(h.element('#feedbackExportPanel').hidden,false,'Copy denial should expose selectable complete text');
  assert.match(h.element('#feedbackExportMessage').textContent,/手动复制/);
  await h.event('storage',{key:'shijian.workspace-logout.v1:'+encodeURIComponent(member.id),newValue:'clear'});
  assert.equal(h.element('#feedbackExportText').value,'','Logout clears the private export preview');
  console.log('PASS 导出只包含当前筛选、保留版本和多行证据，复制受限可手动获取，退出清理摘要');
}

{
  const h=await harness({delaySettings:true});
  const first=h.open('settings');await new Promise(resolve=>setImmediate(resolve));
  await h.open('overview');const second=h.open('settings');await new Promise(resolve=>setImmediate(resolve));
  const reads=h.requests.filter(x=>x.path==='/api/settings').length;
  for(const resolve of h.settingsWaiters)resolve({revision:1,version:'test',system_prompt:'云端规则'});
  await Promise.all([first,second]);
  assert.equal(reads,1,'Switching away and back must reuse an in-flight rules read');
  const form=h.element('#settingsForm');form.elements.system_prompt.value='我刚输入的规则';
  form.handlers.input();await h.open('overview');await h.open('settings');
  assert.equal(form.elements.system_prompt.value,'我刚输入的规则');
  console.log('PASS 慢网反复切换规则页只发一次读取，回到页面保留输入');
}

{
  const h=await harness();const form=h.element('#feedbackForm');
  form.elements.title.value='首次建议';form.elements.desired.value='希望改进';
  h.loseResponse();await form.onsubmit({preventDefault(){},currentTarget:form});
  form.elements.title.value='另一项改进';await form.onsubmit({preventDefault(){},currentTarget:form});
  assert.equal(h.feedback.size,1,'Conflicts must not silently create another item');
  assert.equal(h.element('#feedbackRetryChoice').hidden,false);
  const count=h.requests.filter(x=>x.method==='POST').length;
  h.element('#newFeedbackAttempt').onclick();
  assert.equal(h.requests.filter(x=>x.method==='POST').length,count,'Explicit new attempt must not auto-submit');
  assert.equal(form.elements.title.value,'另一项改进');
  await form.onsubmit({preventDefault(){},currentTarget:form});
  assert.equal(h.feedback.size,2);
  console.log('PASS 建议冲突后人工核对再新建，保留输入且不会自动重复提交');
}

{
  const h=await harness();
  h.fields.title.value='退出不应复活的恢复稿';h.fields.content.value='只属于测试账号';
  h.element('#sourceForm').handlers.input();await h.event('beforeunload');
  const prefix='shijian.workspace-draft.v1:'+encodeURIComponent(member.id)+':';
  assert.equal([...h.storageMap.keys()].some(key=>key.startsWith(prefix)),true);
  await h.event('storage',{key:'shijian.workspace-logout.v1:other-account',newValue:'1'});
  assert.equal(h.fields.title.value,'退出不应复活的恢复稿','Other accounts must not log this tab out');
  await h.event('storage',{key:'shijian.workspace-logout.v1:'+encodeURIComponent(member.id),newValue:'2'});
  assert.equal(h.fields.content.value,'');assert.equal(h.element('#adminApp').hidden,true);
  await h.event('beforeunload');
  assert.equal([...h.storageMap.keys()].some(key=>key.startsWith(prefix)),false,'Unload after cross-tab logout must not recreate a draft');
  console.log('PASS 其他标签退出后清空当前编辑框，离开页面不再复活本机稿');
}

{
  const h=await harness();
  h.fields.title.value='已写入但响应丢失';h.fields.content.value='保持原文重试';
  h.loseResponse();await h.save();await h.save();
  const writes=h.requests.filter(x=>x.method==='POST');
  assert.equal(writes[0].body.item.id,writes[1].body.item.id,'Unconfirmed saves must retain the same client identity');
  assert.equal(writes[0].body.item.revision,0);assert.equal(writes[1].body.item.revision,0);
  assert.equal(h.database.size,1);assert.equal([...h.database.values()][0].revision,1);
  console.log('PASS 保存响应丢失后重试：固定条目标识，只确认同一次写入');
}

{
  const h=await harness();await h.open('sources');
  h.fields.title.value='协作测试';h.fields.content.value='云端初稿';await h.save();
  h.fields.content.value='本人尚未保存的修改';h.element('#sourceForm').handlers.input();
  const saved=[...h.database.values()][0];h.database.set(saved.id,{...saved,content:'队友的云端修改',revision:saved.revision+1});h.sync.sources++;
  await h.poll();
  assert.equal(h.fields.content.value,'本人尚未保存的修改','Background refresh must never overwrite the editor');
  assert.equal(h.element('#sourceConflict').hidden,false,'New cloud revision must show a merge notice');
  await h.event('beforeunload');
  const draft=JSON.parse([...h.storageMap.values()][0]);
  assert.equal(draft.fields.content,'本人尚未保存的修改');assert.equal(draft.revision,saved.revision);
  const reopened=await harness({storageMap:h.storageMap});
  assert.equal(reopened.fields.content.value,'','Recovery must require an explicit action');
  reopened.element('#draftChoice').value=draft.id;reopened.element('#restoreDraft').onclick();
  assert.equal(reopened.fields.content.value,'本人尚未保存的修改');
  await reopened.event('beforeunload');
  console.log('PASS 自动检查队友更新不覆盖输入；刷新后显式恢复仍保留原编辑版本');
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
