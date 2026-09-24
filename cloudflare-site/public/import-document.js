// Parse locally, preview first, then let the member explicitly save the text.
const LIMIT_BYTES = 10 * 1024 * 1024;
const LIMIT_TEXT = 200000;
let mammothLoading;
function mammothLibrary() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  return mammothLoading ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('./vendor/mammoth/mammoth.browser.min.js', import.meta.url).href;
    script.onload = () => resolve(window.mammoth);
    script.onerror = () => { mammothLoading = null; script.remove(); reject(new Error('Word 读取组件加载失败，请稍后重试。')); };
    document.head.append(script);
  });
}

// Reject oversized decompressed DOCX archives before the browser parser runs.
function validateDocx(buffer) {
  const view = new DataView(buffer);
  let end = -1;
  for (let p = view.byteLength - 22; p >= Math.max(0, view.byteLength - 65557); p--) {
    if (view.getUint32(p, true) === 0x06054b50) { end = p; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('Word 文件格式不正确，请另存为 .docx 后重试。');
  let p = view.getUint32(end + 16, true), total = 0;
  const count = view.getUint16(end + 10, true);
  if (count > 3000) throw new Error('文档附件过多，请只保留需要导入的正文。');
  for (let i = 0; i < count; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== 0x02014b50) throw new Error('Word 文档已损坏或格式不受支持。');
    total += view.getUint32(p + 24, true);
    if (total > 40 * 1024 * 1024) throw new Error('文档解压后过大，请删去大图或分章节导入。');
    p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
}

export async function extractDocument(file) {
  if (!file || !file.size) throw new Error('请选择一个有内容的文件。');
  if (file.size > LIMIT_BYTES) throw new Error('文件最多 10 MB，请分章节导入。');
  const ext = file.name.split('.').pop().toLowerCase();
  let text = '';
  if (['txt', 'md'].includes(ext)) {
    const buffer = await file.arrayBuffer();
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { text = new TextDecoder('gb18030').decode(buffer); }
  } else if (ext === 'docx') {
    const buffer = await file.arrayBuffer();
    validateDocx(buffer);
    const mammoth = await mammothLibrary();
    text = (await mammoth.extractRawText({ arrayBuffer: buffer })).value;
  } else if (ext === 'pdf') {
    const pdfjs = await import('./vendor/pdfjs/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
    const loading = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()),
      cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href, cMapPacked: true,
      standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
      isEvalSupported: false, useWasm: false, stopAtErrors: true });
    loading.onPassword = () => { loading.destroy(); };
    try {
      const pdf = await loading.promise;
      if (pdf.numPages > 200) throw new Error('PDF 超过 200 页，请按章节拆分后导入。');
      const pages = [];
      let length = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const data = await page.getTextContent();
        const content = data.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('').trim();
        if (content) pages.push(`【第 ${i} 页】\n${content}`);
        length += content.length;
        page.cleanup();
        if (length > LIMIT_TEXT) throw new Error('正文超过 20 万字，请分章节导入。');
      }
      text = pages.join('\n\n');
    } catch (error) {
      if (/password|destroyed/i.test(error.message || '')) throw new Error('此 PDF 已加密，请先解锁并另存后导入。');
      throw error;
    } finally { await loading.destroy(); }
  } else throw new Error('支持 PDF、Word（.docx）和文本（.txt / .md）。旧版 .doc 请先另存为 .docx。');
  text = text.replace(/\u0000/g, '').trim();
  if (!text) throw new Error('未提取到文字。扫描件和图片目前不支持识别，请粘贴识别后的正文。');
  if (text.length > LIMIT_TEXT) throw new Error('正文超过 20 万字，请分章节导入。');
  return text;
}
