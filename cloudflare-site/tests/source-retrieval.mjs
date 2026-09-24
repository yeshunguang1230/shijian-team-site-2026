import assert from 'node:assert/strict';
import {
  retrieveSources, splitSource, selectQuizMaterial, serializeEvidence,
  modelSources, fragmentLocation, RETRIEVAL_LIMITS,
} from '../public/source-retrieval.js';

const source = (id, content, extra = {}) => ({
  id, title: `史料 ${id}`, author: '测试机构', date: '测试年份',
  locator: '测试文档', reliability: '测试夹具', visibility: 'published', content, ...extra,
});
const lateSource = source('TAIL',
  `【第 1 页】\n${'早期农业生产记录。'.repeat(1100)}\n\n【第 17 页】\n` +
  '本页讨论摊丁入亩，将丁银摊入田赋征收。这里是文档后部可核对的真实命中片段。',
);

// A match at the end of a long document must supply that passage, not its head.
{
  const result = retrieveSources([lateSource], '摊丁入亩');
  assert.ok(result.length);
  assert.match(result[0].content, /摊丁入亩/);
  assert.ok(result[0].start > 2500);
  assert.equal(result[0].page, 17);
  assert.equal(result[0].content, lateSource.content.slice(result[0].start, result[0].end));
  assert.match(fragmentLocation(result[0]), /第 17 页/);
  assert.deepEqual(result, retrieveSources([lateSource], '摊丁入亩'), 'Identical input produces identical excerpts');
  console.log('PASS 长文档后部命中：实际片段、来源与原文位置一致');
}

// Page markers are carried forward only within their own source section.
{
  const marked = source('PAGES', '未标页引言。\n\n【第 2 页】\n第二页的盐铁政策。\n\n【第 9 页】\n第九页的盐铁政策和市场交换。');
  const chunks = splitSource(marked);
  assert.deepEqual(chunks.map(item => item.page), [null, 2, 9]);
  for (const item of chunks) {
    assert.equal(item.content, marked.content.slice(item.start, item.end));
    assert.ok(!item.content.includes('【第 '));
    assert.ok(!(item.content.includes('第二页') && item.content.includes('第九页')));
  }
  const noPage = source('PLAIN', '1735年不是页码，第八段讨论盐铁政策。', { locator: '书籍参考第 99 页（待查）' });
  const plainHit = retrieveSources([noPage], '盐铁政策')[0];
  assert.equal(plainHit.page, null, 'Dates, paragraph numbers and locator text cannot invent a PDF page');
  assert.match(fragmentLocation(plainHit), /无页码标记/);
  console.log('PASS 页码边界：只使用正文已有页标记，不猜页码');
}

// Windows overlap so a keyword spanning a hard character boundary is found.
{
  const crossing = source('CROSS', '甲'.repeat(899) + '盐铁政策' + '乙'.repeat(1000));
  const hits = retrieveSources([crossing], '盐铁政策');
  assert.ok(hits.some(item => item.content.includes('盐铁政策')));
  for (const hit of hits) assert.equal(hit.content, crossing.content.slice(hit.start, hit.end));
  console.log('PASS 长段落窗口交界处仍能检索完整关键词');
}

// The caller may receive developer-visible drafts; they must never leak out.
{
  const inputs = [
    source('PUBLIC-A', '盐铁政策的公开材料甲。'),
    source('PUBLIC-B', '盐铁政策的公开材料乙。'),
    source('PRIVATE', '盐铁政策：秘密草稿', { visibility: 'draft', internal_note: 'secret' }),
    source('UNKNOWN', '盐铁政策：无状态资料', { visibility: undefined }),
    source('DEMO', '盐铁政策：本地演示方法卡', { visibility: 'demo' }),
  ];
  const hits = retrieveSources(inputs, '盐铁政策');
  assert.deepEqual(hits.map(item => item.id), ['PUBLIC-A', 'PUBLIC-B']);
  for (const hit of hits) {
    const original = inputs.find(item => item.id === hit.id);
    assert.equal(hit.content, original.content.slice(hit.start, hit.end));
    assert.equal(hit.title, original.title);
  }
  assert.ok(!serializeEvidence(hits).includes('秘密'));
  const withDemo = retrieveSources(inputs, '盐铁政策', { allowDemo: true });
  assert.ok(withDemo.some(item => item.id === 'DEMO'));
  assert.ok(!withDemo.some(item => ['PRIVATE', 'UNKNOWN'].includes(item.id)));
  assert.deepEqual(retrieveSources(inputs, '不存在的匹配词zzxy99'), []);
  assert.deepEqual(retrieveSources(inputs, '   '), []);
  assert.deepEqual(retrieveSources([], '盐铁政策'), []);
  console.log('PASS 公开资料筛选、空匹配和来源边界');
}

// Both text and serialized source payloads (including escaping/metadata) obey
// budgets. A large metadata block must not bypass the serialized budget.
{
  const sources = Array.from({ length: 9 }, (_, index) => source(`B${index}`,
    `预算检索\n${'带有引号"和换行\n的正文。'.repeat(500)}`, {
      title: '预算检索' + '长标题'.repeat(100), locator: '路径\\'.repeat(240),
    }));
  const hits = retrieveSources(sources, '预算检索');
  assert.ok(hits.length);
  assert.ok(hits.length <= RETRIEVAL_LIMITS.maxFragments);
  assert.ok(hits.reduce((sum, item) => sum + item.content.length, 0) <= RETRIEVAL_LIMITS.maxContentChars);
  assert.ok(serializeEvidence(hits).length <= RETRIEVAL_LIMITS.maxSerializedChars);
  const tightSource = source('TIGHT', '前言。'.repeat(100) + '预算命中关键词' + '解释。'.repeat(200));
  for (const options of [
    { maxContentChars: 90, maxSerializedChars: 600 },
    { maxContentChars: 180, maxSerializedChars: 800 },
    { maxContentChars: 0, maxSerializedChars: 200 },
    { maxContentChars: 90, maxSerializedChars: 2 },
  ]) {
    const result = retrieveSources([tightSource], '预算命中关键词', options);
    assert.ok(result.reduce((sum, item) => sum + item.content.length, 0) <= options.maxContentChars);
    assert.ok(serializeEvidence(result).length <= options.maxSerializedChars);
    for (const item of result) {
      assert.match(item.content, /预算命中关键词/);
      assert.equal(item.content, tightSource.content.slice(item.start, item.end));
    }
  }
  assert.ok(retrieveSources([tightSource], '预算命中关键词', { maxContentChars: 90, maxSerializedChars: 600 }).length);
  console.log('PASS 原文预算、JSON预算、压缩后命中与位置不丢失');
}

{
  const original = source('QUIZ', '【第 3 页】\n' + '历史材料训练。'.repeat(600));
  const material = selectQuizMaterial(original);
  assert.ok(material && material.content.length <= 1800);
  assert.equal(material.page, 3);
  const saved = serializeEvidence([material]);
  original.content = '后续版本内容已改变';
  assert.equal(serializeEvidence([material]), saved, 'Quiz material stays unchanged during one exercise');
  assert.equal(selectQuizMaterial({ ...original, visibility: 'draft' }), null);
  console.log('PASS 材料题使用有边界的固定片段快照');
}

// Exercise the actual browser handlers with an in-memory DOM and API. This
// verifies the wiring, not just the retrieval helper; no network/account is used.
let agentHarnessSequence = 0;
async function withAgent(configured, run) {
  const keys = ['document', 'window', 'location', 'fetch'];
  const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const elements = new Map(), handlers = {}, chats = [];
  let gradeResponse = { scores: { 观点: 10, 证据: 10, 解释: 10, 史实准确: 10 }, feedback: '测试反馈' };
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', textContent: '', innerHTML: '', className: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {} }, focus() {},
    });
    return elements.get(selector);
  };
  const apiSources = [lateSource, source('HIDDEN', '秘密草稿摊丁入亩', { visibility: 'draft' })];
  globalThis.document = { querySelector: element, querySelectorAll: () => [], addEventListener: (name, callback) => { handlers[name] = callback; } };
  globalThis.window = { addEventListener() {} };
  globalThis.location = { hash: '#qa', reload() {} };
  globalThis.fetch = async (path, options = {}) => {
    let data;
    if (path === '/api/auth/me') data = { user: { role: 'developer', mustChangePassword: false } };
    else if (path === '/api/config') data = { configured };
    else if (path === '/api/sources') data = apiSources;
    else if (path === '/api/v1/chat/completions') {
      assert.ok(configured, 'Unconfigured mode must not call a model');
      const prompt = JSON.parse(options.body).messages[0].content;
      assert.ok(prompt.length < 20000);
      const sources = JSON.parse(prompt.split('SOURCES：')[1].split('\n答案：')[0]);
      chats.push({ prompt, sources });
      assert.ok(sources.every(item => item.id !== 'HIDDEN'));
      let result;
      if (prompt.includes('生成一道')) result = { question: '请根据材料提出观点并说明依据。', source_id: sources[0].id, fragment_id: sources[0].fragment_id };
      else if (prompt.includes('批改')) result = gradeResponse;
      else result = { answer: '模型测试回答', claims: [{ type: '事实', text: '待人工复核的测试结论', source_ids: [sources[0].id] }] };
      data = { choices: [{ message: { content: typeof result === 'string' ? result : JSON.stringify(result) } }] };
    } else throw new Error(`Unexpected test API: ${path}`);
    return { ok: true, status: 200, json: async () => data };
  };
  try {
    await import(`../public/agent.js?retrieval-test=${++agentHarnessSequence}`);
    await new Promise(resolve => setImmediate(resolve));
    const action = async name => handlers.click({ target: { closest: () => ({ dataset: { action: name } }) } });
    await run({ element, chats, action, setGradeResponse: result => { gradeResponse = result; } });
  } finally {
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

await withAgent(true, async ({ element, chats, action }) => {
  element('#question').value = '摊丁入亩';
  await action('analyze');
  const provided = chats[0].sources;
  assert.ok(provided.some(item => item.content.includes('摊丁入亩') && item.start > 2500));
  assert.deepEqual(provided, modelSources(retrieveSources([lateSource], '摊丁入亩')));
  assert.match(element('#evidenceList').innerHTML, /摊丁入亩/);
  assert.match(element('#evidenceList').innerHTML, /第 17 页/);
  assert.match(element('#evidenceNote').textContent, /实际提供给模型/);
  await action('generateQuiz');
  const quizSources = chats.at(-1).sources;
  assert.equal(quizSources.length, 1);
  assert.ok(element('#quizSource').textContent.includes(quizSources[0].content));
  assert.ok(element('#quizSource').textContent.includes(quizSources[0].fragment_id));
  element('#studentAnswer').value = '我的观点是生产发生变化。根据材料，原文提供了生产情况，因此需要对照证据作出判断。';
  await action('grade');
  assert.deepEqual(chats.at(-1).sources, quizSources, 'Generation, displayed text and grading must use identical evidence');
  console.log('PASS 实际页面：长文问答与证据一致，出题/显示/批改材料完全一致');
});

await withAgent(false, async ({ element, chats, action }) => {
  element('#question').value = '摊丁入亩';
  await action('analyze');
  assert.equal(chats.length, 0);
  assert.match(element('#modeText').textContent, /规则演示/);
  assert.match(element('#answerResult').innerHTML, /非 AI 生成/);
  assert.match(element('#answerResult').innerHTML, /摊丁入亩/);
  assert.match(element('#evidenceNote').textContent, /未由 AI 生成/);
  await action('generateQuiz');
  element('#studentAnswer').value = '材料中存在生产活动，因此可以结合证据进一步解释。';
  await action('grade');
  assert.equal(chats.length, 0);
  assert.match(element('#gradeResult').innerHTML, /规则演示/);
  console.log('PASS AI未配置：保持规则演示，不发模型请求、不伪造评分');
});

await withAgent(true, async ({ element, action, setGradeResponse }) => {
  await action('generateQuiz');
  element('#studentAnswer').value = '根据材料提出观点，再解释证据与观点的关系。';
  setGradeResponse({ scores: { 观点: 0, 证据: 25, 解释: 12.5, 史实准确: 20 }, weakness: '需要补充明确观点' });
  await action('grade');
  assert.match(element('#gradeResult').innerHTML, /57\.5 \/ 100/);
  assert.equal(element('#scorePoint').textContent, 0, 'A genuine numeric zero remains a valid score');
  assert.equal(element('#scoreEvidence').textContent, 25);
  assert.equal(element('#scoreExplain').textContent, 12.5);
  assert.match(element('#weaknesses').innerHTML, /AI 参考：需要补充明确观点/);
  const previousRecords = element('#weaknesses').innerHTML;
  const standard = { 观点: 10, 证据: 10, 解释: 10, 史实准确: 10 };
  const malformed = [
    ['空对象', {}], ['数组', []], ['无对象', null], ['字符串对象', '10'],
    ['缺项', { 观点: 10, 证据: 10, 解释: 10 }],
    ['数字字符串', { ...standard, 史实准确: '10' }],
    ['空字符串', { ...standard, 史实准确: '' }],
    ['布尔值', { ...standard, 史实准确: false }],
    ['无说明null', { ...standard, 史实准确: null }],
    ['负数', { ...standard, 史实准确: -1 }],
    ['超过上限', { ...standard, 史实准确: 26 }],
    ['嵌套对象', { ...standard, 史实准确: { score: 10 } }],
    ['数组分数', { ...standard, 史实准确: [10] }],
    ['非法文字', { ...standard, 史实准确: '大约十五分' }],
  ];
  for (const [label, scores] of malformed) {
    setGradeResponse({ scores, weakness: `不得记录的坏数据-${label}`, feedback: '不应作为可靠评价展示' });
    await action('grade');
    assert.match(element('#gradeResult').innerHTML, /AI 评分未完成/, label);
    assert.ok(!element('#gradeResult').innerHTML.includes('class="score"'), `${label} must not generate a total`);
    assert.equal(element('#scoreFact').textContent, '未评分', label);
    assert.equal(element('#weaknesses').innerHTML, previousRecords, `${label} must not create a weakness record`);
  }
  // JSON permits exponent notation that may overflow a JavaScript number.
  setGradeResponse('{"scores":{"观点":10,"证据":10,"解释":10,"史实准确":1e999},"weakness":"无穷值不得入库"}');
  await action('grade');
  assert.equal(element('#scoreFact').textContent, '未评分');
  assert.ok(!element('#gradeResult').innerHTML.includes('class="score"'));
  assert.equal(element('#weaknesses').innerHTML, previousRecords);
  console.log('PASS AI评分：缺项/数组/非法值/非有限数不变成0分、不生成总分、不写入薄弱点');

  for (const response of [
    { scores: { ...standard, 史实准确: '无法核验' } },
    { scores: { ...standard, 史实准确: null }, unscored_reasons: { 史实准确: '材料未提供足够依据' } },
  ]) {
    setGradeResponse({ ...response, weakness: '不可把资料不足当学生薄弱点' });
    await action('grade');
    assert.equal(element('#scoreFact').textContent, '待核验');
    assert.equal(element('#scorePoint').textContent, 10);
    assert.match(element('#gradeResult').innerHTML, /AI 部分反馈/);
    assert.ok(!element('#gradeResult').innerHTML.includes('class="score"'));
    assert.equal(element('#weaknesses').innerHTML, previousRecords);
  }
  setGradeResponse({ scores: { 观点: '未评分', 证据: '资料不足', 解释: '无法评分', 史实准确: '待核验' } });
  await action('grade');
  assert.ok(!element('#gradeResult').innerHTML.includes('class="score"'));
  assert.equal(element('#weaknesses').innerHTML, previousRecords);
  setGradeResponse({ scores: standard, weakness: [], feedback: {}, rewrite: [] });
  await action('grade');
  assert.match(element('#gradeResult').innerHTML, /40 \/ 100/);
  assert.ok(!element('#gradeResult').innerHTML.includes('[object Object]'));
  assert.equal(element('#weaknesses').innerHTML, previousRecords, 'Malformed weakness text is not recorded even when scores are valid');
  console.log('PASS AI评分：明确无法核验显示待核验，完整合法评分才显示总分');
});
