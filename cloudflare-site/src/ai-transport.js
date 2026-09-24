import { ApiError } from './auth.js';

export const AI_RESPONSE_LIMITS = Object.freeze({ timeoutMs: 25000, maxBytes: 2 * 1024 * 1024 });
export const AI_OUTPUT_TOKENS = Object.freeze({ default: 2500, max: 4000 });

export function outputTokenBudget(value) {
  if (value === undefined) return AI_OUTPUT_TOKENS.default;
  if (!Number.isSafeInteger(value) || value < 1 || value > AI_OUTPUT_TOKENS.max) {
    throw new ApiError(`max_tokens 必须是 1–${AI_OUTPUT_TOKENS.max} 的整数`, 400);
  }
  return value;
}

// Keep the deadline active through the last byte. The injected transport and
// reduced limits support deterministic tests without an external model call.
export async function fetchAiResponse(url, options, {
  fetchImpl = fetch,
  timeoutMs = AI_RESPONSE_LIMITS.timeoutMs,
  maxBytes = AI_RESPONSE_LIMITS.maxBytes
} = {}) {
  const controller = new AbortController();
  let upstream, reader, timer, timedOut = false;
  const timeoutError = () => new ApiError('AI 服务响应超时，请稍后重试', 504);
  const oversizedError = () => new ApiError('AI 服务响应过大，请缩短问题', 502);
  const cancelBody = () => {
    try {
      const cancellation = reader ? reader.cancel() : upstream?.body?.cancel();
      // Cancellation itself must not extend the request deadline.
      cancellation?.catch(() => {});
    } catch { /* An already closed/errored stream needs no further cleanup. */ }
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError());
      controller.abort();
      cancelBody();
    }, timeoutMs);
  });
  async function receive() {
    upstream = await fetchImpl(url, { ...options, signal: controller.signal });
    if (timedOut) { cancelBody(); throw timeoutError(); }
    if (!upstream.ok) throw new ApiError('AI 服务暂时无法完成请求，请稍后重试或联系项目负责人', 502);
    if (Number(upstream.headers.get('Content-Length') || 0) > maxBytes) throw oversizedError();
    const chunks = [];
    let size = 0;
    if (upstream.body) {
      reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (timedOut) throw timeoutError();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw oversizedError();
        chunks.push(value);
      }
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return { output, status: upstream.status };
  }
  try {
    return await Promise.race([receive(), deadline]);
  } catch (error) {
    controller.abort();
    cancelBody();
    if (error instanceof ApiError) throw error;
    if (timedOut || error?.name === 'AbortError') throw timeoutError();
    throw new ApiError('暂时无法连接 AI 服务，请稍后重试', 502);
  } finally {
    clearTimeout(timer);
    try { reader?.releaseLock(); } catch { /* A pending read ends after cancellation. */ }
  }
}
