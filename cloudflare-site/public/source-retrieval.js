// Deterministic text retrieval. Offsets refer to the unchanged stored content
// (JavaScript string positions, start inclusive and end exclusive). No model,
// inferred PDF pagination or private source fields are used here.
export const RETRIEVAL_LIMITS = Object.freeze({
  chunkChars: 900, overlapChars: 160, maxFragments: 5, maxPerSource: 2,
  maxContentChars: 4500, maxSerializedChars: 8500,
});

const text = value => typeof value === 'string' ? value : '';
const limit = (value, fallback, min, max) => Number.isFinite(value)
  ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
function limits(options = {}) {
  const chunkChars = limit(options.chunkChars, RETRIEVAL_LIMITS.chunkChars, 32, 2400);
  return {
    chunkChars,
    overlapChars: limit(options.overlapChars, RETRIEVAL_LIMITS.overlapChars, 0, chunkChars - 1),
    maxFragments: limit(options.maxFragments, RETRIEVAL_LIMITS.maxFragments, 0, 8),
    maxPerSource: limit(options.maxPerSource, RETRIEVAL_LIMITS.maxPerSource, 0, 3),
    maxContentChars: limit(options.maxContentChars, RETRIEVAL_LIMITS.maxContentChars, 0, 6000),
    maxSerializedChars: limit(options.maxSerializedChars, RETRIEVAL_LIMITS.maxSerializedChars, 2, 9000),
    // Only the separately labelled, built-in demonstration library uses this.
    // API rows must still be published; drafts never become eligible.
    allowDemo: options.allowDemo === true,
  };
}

function eligible(source, options) {
  return source && typeof source.id === 'string' && source.id.trim()
    && typeof source.title === 'string' && typeof source.content === 'string'
    && (source.visibility === 'published' || (options.allowDemo && source.visibility === 'demo'));
}

export function queryTerms(query) {
  const terms = new Map();
  const add = (value, weight) => {
    if (value.length > 1 && terms.size < 96) terms.set(value, Math.max(terms.get(value) || 0, weight));
  };
  for (const word of text(query).slice(0, 2000).toLowerCase().match(/[\u3400-\u9fff]+|[a-z0-9]+/g) || []) {
    if (/^[\u3400-\u9fff]+$/.test(word)) {
      if (word.length <= 32) add(word, Math.min(8, word.length));
      for (let i = 0; i < word.length - 1; i++) add(word.slice(i, i + 2), 1);
    } else add(word, 3);
  }
  return [...terms].map(([term, weight]) => ({ term, weight }));
}

function pageSections(content) {
  // This is the exact marker emitted by the PDF text importer. Ordinary dates,
  // a locator such as "p. 12", and paragraph numbers do not imply a PDF page.
  const marker = /^[\t ]*【第[\t ]*(\d{1,6})[\t ]*页】[\t ]*(?:\r?\n|$)/gm;
  const sections = [];
  let start = 0, page = null, match;
  while ((match = marker.exec(content))) {
    if (match.index > start) sections.push({ start, end: match.index, page });
    start = marker.lastIndex;
    const number = Number(match[1]);
    page = number > 0 ? number : null;
  }
  if (start < content.length) sections.push({ start, end: content.length, page });
  return sections;
}

function trimmedRange(content, start, end) {
  while (start < end && /\s/.test(content[start])) start++;
  while (end > start && /\s/.test(content[end - 1])) end--;
  return { start, end };
}

function fragment(source, start, end, page) {
  const range = trimmedRange(source.content, start, end);
  return {
    id: source.id,
    fragment_id: `${source.id}@${range.start}-${range.end}`,
    title: source.title, author: text(source.author), date: text(source.date),
    locator: text(source.locator), reliability: text(source.reliability),
    start: range.start, end: range.end, page,
    content: source.content.slice(range.start, range.end),
  };
}

export function splitSource(source, options = {}) {
  const config = limits(options);
  if (!eligible(source, config)) return [];
  const chunks = [];
  for (const section of pageSections(source.content)) {
    const body = source.content.slice(section.start, section.end);
    const separator = /\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/g;
    const paragraphs = [];
    let start = section.start, match;
    while ((match = separator.exec(body))) {
      paragraphs.push({ start, end: section.start + match.index });
      start = section.start + separator.lastIndex;
    }
    paragraphs.push({ start, end: section.end });
    const ranges = [];
    for (const paragraph of paragraphs) {
      const range = trimmedRange(source.content, paragraph.start, paragraph.end);
      if (range.start === range.end) continue;
      const previous = ranges[ranges.length - 1];
      if (previous && range.end - previous.start <= config.chunkChars) previous.end = range.end;
      else ranges.push(range);
    }
    for (const range of ranges) {
      for (let offset = range.start; offset < range.end;) {
        const end = Math.min(offset + config.chunkChars, range.end);
        const item = fragment(source, offset, end, section.page);
        if (item.content) chunks.push(item);
        if (end === range.end) break;
        offset = end - config.overlapChars;
      }
    }
  }
  return chunks;
}

// The citation UI and every model operation use these same complete fragments.
// Never replace their content with a slice of the original document's start.
export function modelSources(fragments) {
  return fragments.map(item => ({
    id: item.id, fragment_id: item.fragment_id, title: item.title,
    author: item.author, date: item.date, locator: item.locator,
    reliability: item.reliability, start: item.start, end: item.end,
    page: item.page, content: item.content,
  }));
}
export const serializeEvidence = fragments => JSON.stringify(modelSources(fragments));

export function fragmentLocation(item) {
  return `${item.page ? `原文页码标记：第 ${item.page} 页 · ` : '原文无页码标记 · '}正文位置 ${item.start + 1}–${item.end}`;
}

function fitFragment(candidate, selected, config, remaining) {
  const original = candidate.item;
  const maxChars = Math.min(original.content.length, remaining);
  if (maxChars <= 0) return null;
  function resize(size) {
    const anchor = Math.max(0, candidate.anchor || 0);
    const relativeStart = Math.max(0, Math.min(original.content.length - size, anchor - Math.floor(size / 3)));
    const content = original.content.slice(relativeStart, relativeStart + size);
    const start = original.start + relativeStart;
    return { ...original, start, end: start + content.length,
      fragment_id: `${original.id}@${start}-${start + content.length}`, content };
  }
  let low = 1, high = maxChars, best = null;
  while (low <= high) {
    const size = Math.floor((low + high) / 2), item = resize(size);
    if (serializeEvidence([...selected, item]).length <= config.maxSerializedChars) {
      best = item; low = size + 1;
    } else high = size - 1;
  }
  // A partial keyword must not become a claimed content hit after budgeting.
  if (best && best.content.trim().length < Math.min(32, original.content.trim().length)) return null;
  if (best && candidate.hitTerm && !best.content.toLowerCase().includes(candidate.hitTerm)) return null;
  return best;
}

function select(candidates, options) {
  const config = limits(options), selected = [], perSource = new Map();
  let contentChars = 0;
  for (const candidate of candidates) {
    if (selected.length >= config.maxFragments || contentChars >= config.maxContentChars) break;
    const item = candidate.item;
    if ((perSource.get(item.id) || 0) >= config.maxPerSource) continue;
    // Do not spend the model budget twice on overlapping windows of one source.
    if (selected.some(old => old.id === item.id && old.start < item.end && item.start < old.end)) continue;
    const fitted = fitFragment(candidate, selected, config, config.maxContentChars - contentChars);
    if (!fitted) continue;
    selected.push(fitted);
    contentChars += fitted.content.length;
    perSource.set(item.id, (perSource.get(item.id) || 0) + 1);
  }
  return selected;
}

export function retrieveSources(sources, query, options = {}) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const candidates = [];
  let order = 0;
  for (const source of Array.isArray(sources) ? sources : []) {
    for (const item of splitSource(source, options)) {
      const body = item.content.toLowerCase(), title = item.title.toLowerCase();
      let score = 0, anchor = 0, hitWeight = 0, hitTerm = '';
      for (const { term, weight } of terms) {
        const index = body.indexOf(term);
        if (index !== -1) {
          score += weight * 4;
          if (weight > hitWeight) { anchor = index; hitWeight = weight; hitTerm = term; }
        }
        if (title.includes(term)) score += weight;
      }
      if (score > 0) candidates.push({ item, score, anchor, hitTerm, order: order++ });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return select(candidates, options);
}

// With no user query, a quiz deliberately takes one bounded passage in reading
// order. That immutable passage is used to generate, display and grade the quiz.
export function selectQuizMaterial(source, options = {}) {
  const config = { ...options, chunkChars: 1800, maxFragments: 1, maxPerSource: 1,
    maxContentChars: 1800, maxSerializedChars: 4500 };
  return select(splitSource(source, config).map(item => ({ item, anchor: 0 })), config)[0] || null;
}
