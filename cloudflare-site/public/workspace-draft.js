// Recovery copies stay in this browser and are scoped to the signed-in account.
// They are never uploaded or published by this module.
export function createDraftStore(userId, storage) {
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { storage = null; }
  }
  const prefix = 'shijian.workspace-draft.v1:' + encodeURIComponent(userId) + ':';
  const logoutKey = 'shijian.workspace-logout.v1:' + encodeURIComponent(userId);
  const fields = ['title', 'author', 'date', 'period', 'locator', 'content', 'reliability'];
  function list() {
    try {
      const items = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(prefix)) continue;
        try {
          const item = JSON.parse(storage.getItem(key));
          if (item.userId === userId && typeof item.id === 'string' && item.fields && Number.isInteger(item.revision)) items.push(item);
        } catch { /* A damaged local copy must not prevent opening the workspace. */ }
      }
      return items.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    } catch { return []; }
  }
  function save(value) {
    try {
      if (!value.id || !Number.isInteger(value.revision)) throw Error('无法识别恢复稿');
      const content = Object.fromEntries(fields.map(key => [key, String(value.fields[key] || '')]));
      const item = { userId, id: value.id, revision: value.revision, visibility: value.visibility === 'published' ? 'published' : 'draft', savedAt: new Date().toISOString(), fields: content };
      storage.setItem(prefix + value.id, JSON.stringify(item));
      return { ok: true, item };
    } catch { return { ok: false, message: '本浏览器未能保存恢复稿，请尽快保存到云端或复制正文到自己的文档。' }; }
  }
  function remove(id) {
    try { storage.removeItem(prefix + id); return true; } catch { return false; }
  }
  function clear({ broadcast = true } = {}) {
    try {
      const keys = [];
      for (let i = 0; i < storage.length; i++) if (storage.key(i)?.startsWith(prefix)) keys.push(storage.key(i));
      for (const key of keys) storage.removeItem(key);
      // A separate marker avoids treating a successful single-draft save as logout.
      if (broadcast) storage.setItem(logoutKey, Date.now() + ':' + Math.random());
      return true;
    } catch { return false; }
  }
  return { list, save, remove, clear, logoutKey };
}
