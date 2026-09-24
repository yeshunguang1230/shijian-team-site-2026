const value = input => String(input ?? '').trim();
const shown = input => value(input) || '未填写';
const time = input => {
  if (!input) return '尚无成功读取记录';
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? value(input) : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）';
};

// This is a snapshot of the page's already-loaded records, never a live export.
// Keep all entered text intact, including line breaks, for a useful handoff.
export function buildFeedbackSummary(items, { filter = 'all', generatedAt = new Date(), loadedAt = null } = {}) {
  const rows = items.filter(item => filter === 'all' || item.status === filter);
  if (!rows.length) return '';
  const header = [
    '史鉴 · 团队建议交接摘要',
    `筛选范围：${filter === 'all' ? '全部建议' : filter}`,
    `建议数量：${rows.length} 条`,
    `生成时间：${time(generatedAt)}`,
    `页面最近成功读取看板：${time(loadedAt)}`,
    '说明：这是导出时页面列表的快照，不会随后续修改自动更新。需要最新进展时，请先刷新看板再导出。',
    '下方为成员填写的建议与证据，交接时请按编号核对内容、版本和验收要求。',
  ];
  const sections = rows.map((item, index) => {
    const lines = [
      `【${index + 1}】${shown(item.title)}`,
      `编号：${shown(item.id)}`,
      `记录版本（revision）：${Number.isInteger(item.revision) ? item.revision : '未提供'}`,
      `提出者：${shown(item.author)}`,
      `类型：${shown(item.category)}　优先级：${shown(item.priority)}　状态：${shown(item.status)}`,
      `提交时间：${item.createdAt ? time(item.createdAt) : '未提供'}`,
      `最近更新：${item.updatedAt ? time(item.updatedAt) : '未提供'}　更新者：${shown(item.updatedBy)}`,
    ];
    for (const [key, label] of [
      ['targetVersion', '对应项目版本'], ['owner', '负责人'],
      ['scenario', '使用场景'], ['current', '单独补充的当前问题'],
      ['desired', '当前问题与希望结果'], ['evidence', '证据或出处'],
      ['acceptance', '验收要求'], ['notes', '补充说明'], ['retest', '复测记录'],
    ]) {
      if (['targetVersion', 'owner', 'current', 'notes', 'retest'].includes(key) && !value(item[key])) continue;
      lines.push(`${label}：\n${shown(item[key])}`);
    }
    return lines.join('\n');
  });
  return header.join('\n') + '\n\n' + sections.join('\n\n--------------------\n\n') + '\n';
}
