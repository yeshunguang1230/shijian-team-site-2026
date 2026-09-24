const BACKEND = 'https://shijian-team-site-2026.2560507926.workers.dev';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete('host');
    if (url.pathname.startsWith('/api/')) {
      try {
        const response = await fetch(new URL(url.pathname + url.search, BACKEND), {
          method: request.method, headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
          redirect: 'manual'
        });
        const output = new Headers(response.headers);
        output.set('Cache-Control', 'no-store');
        return new Response(response.body, { status: response.status, headers: output });
      } catch {
        return Response.json({ error: '暂时无法连接云端，请稍后重试。' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
    }
    const path = decodeURIComponent(url.pathname).replace(/\.html$/, '').replace(/\/$/, '');
    if (['/admin', '/史鉴云端管理', '/史鉴建议中心'].includes(path)) {
      try {
        const session = await fetch(BACKEND + '/api/auth/me', { headers, redirect: 'manual' });
        if (!session.ok) throw new Error('session unavailable');
        const { user } = await session.json();
        if (!user || user.mustChangePassword) return new Response(null, { status: 302, headers: { Location: '/login.html', 'Cache-Control': 'no-store' } });
      } catch {
        return new Response('暂时无法确认登录状态，请稍后重试。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
    }
    const asset = await env.ASSETS.fetch(request);
    const output = new Headers(asset.headers);
    output.set('X-Content-Type-Options', 'nosniff');
    output.set('X-Frame-Options', 'SAMEORIGIN');
    output.set('Referrer-Policy', 'same-origin');
    if (output.get('Content-Type')?.includes('text/html')) output.set('Cache-Control', 'no-store');
    return new Response(asset.body, { status: asset.status, headers: output });
  }
};
