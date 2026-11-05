/**
 * 静态资源路由：首页、登录页、受保护页面、通配符
 * @module routes/static
 */

import { Hono } from 'hono';
import { resolveAuthPayload } from '../middleware/auth.js';

const PATH_MAP = {
  '/admin': '/html/admin',
  '/admin.html': '/html/admin',
  '/mailbox': '/html/mailbox',
  '/mailbox.html': '/html/mailbox',
  '/mailboxes.html': '/html/mailboxes',
};

const PROTECTED = new Set([
  '/admin', '/admin.html', '/html/admin.html',
  '/mailboxes.html', '/html/mailboxes.html',
  '/mailbox', '/mailbox.html', '/html/mailbox.html'
]);

const KNOWN_PATHS = new Set([
  '/', '/index.html', '/favicon.svg',
  '/login', '/login.html',
  ...Object.keys(PATH_MAP),
  '/app.js', '/app.css', '/app-router.js',
  '/admin.js', '/admin.css', '/login.js', '/login.css',
  '/mailbox.js', '/mailbox.css', '/mailboxes.js',
  '/mock.js', '/route-guard.js', '/app-mobile.js', '/app-mobile.css',
  '/auth-guard.js', '/storage.js', '/theme-toggle.js',
  '/toast-utils.js', '/mailbox-settings.js',
  '/html/mailbox.html', '/html/mailboxes.html', '/html/admin.html', '/html/app.html', '/html/share.html',
  '/templates/app.html', '/templates/footer.html',
  '/templates/loading.html', '/templates/loading-inline.html', '/templates/toast.html',
]);

function serveAsset(c, targetPath) {
  if (!c.env.ASSETS?.fetch) return c.notFound();
  if (targetPath) return c.env.ASSETS.fetch(new Request(new URL(targetPath, c.req.url), c.req.raw));
  return c.env.ASSETS.fetch(c.req.raw);
}

function extractShareToken(reqUrl) {
  const url = reqUrl instanceof URL ? reqUrl : new URL(String(reqUrl || 'http://localhost/'));
  const normalizedPath = String(url.pathname || '').replace(/\/+$/, '');
  const pathMatch = normalizedPath.match(/(?:^|\/)share\/([^/?#]+)$/);
  const rawToken = pathMatch?.[1] || url.searchParams.get('token') || '';
  try {
    return decodeURIComponent(rawToken).trim();
  } catch (_) {
    return String(rawToken).trim();
  }
}

async function fetchSharePage(c) {
  if (!c.env.ASSETS?.fetch) return c.notFound();
  const reqUrl = new URL(c.req.url);
  const shareReq = new Request(new URL('/html/share.html', reqUrl).toString(), c.req.raw);
  let response = await c.env.ASSETS.fetch(shareReq);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('Location') || response.headers.get('location') || '';
    if (location) {
      const redirectedUrl = new URL(location, reqUrl);
      response = await c.env.ASSETS.fetch(new Request(redirectedUrl.toString(), c.req.raw));
    }
  }
  const token = extractShareToken(reqUrl);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  headers.set('Pragma', 'no-cache');
  headers.set('Expires', '0');
  const contentType = headers.get('Content-Type') || headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    return new Response(response.body, { status: response.status, headers });
  }

  const html = await response.text();
  const escapedToken = JSON.stringify(token);
  const injected = html.replace(
    '</head>',
    `  <meta name="share-token" content=${escapedToken} />\n  <script>window.__SHARE_TOKEN__=${escapedToken};</script>\n</head>`
  );
  return new Response(injected, { status: response.status, headers });
}

async function redirectIfLoggedIn(c, redirectTo) {
  const JWT_TOKEN = c.env.JWT_TOKEN || c.env.JWT_SECRET || '';
  const payload = await resolveAuthPayload(c.req.raw, JWT_TOKEN);
  if (payload) return c.redirect(redirectTo, 302);
  return serveAsset(c);
}

const router = new Hono();

router.get('/', async (c) => {
  const domains = (c.env.MAIL_DOMAIN || 'temp.example.com').split(/[,\s]+/).map(d => d.trim()).filter(Boolean);
  const JWT_TOKEN = c.env.JWT_TOKEN || c.env.JWT_SECRET || '';
  const payload = await resolveAuthPayload(c.req.raw, JWT_TOKEN);
  if (payload?.role === 'mailbox') return c.redirect('/html/mailbox.html', 302);
  if (!c.env.ASSETS?.fetch) return c.redirect('/login.html', 302);

  const resp = await c.env.ASSETS.fetch(c.req.raw);
  try {
    const text = await resp.text();
    return new Response(
      text.replace('<meta name="mail-domains" content="">', `<meta name="mail-domains" content="${domains.join(',')}">`),
      { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' } }
    );
  } catch (_) { return resp; }
});

router.get('/login', async (c) => redirectIfLoggedIn(c, '/'));
router.get('/login.html', async (c) => redirectIfLoggedIn(c, '/'));

router.get('/share', async (c) => fetchSharePage(c));
router.get('/share/:token', async (c) => fetchSharePage(c));

router.get('*', async (c) => {
  const pathname = new URL(c.req.url).pathname;
  const JWT_TOKEN = c.env.JWT_TOKEN || c.env.JWT_SECRET || '';

  if (!KNOWN_PATHS.has(pathname)
      && !pathname.startsWith('/share')
      && !pathname.startsWith('/assets/')
      && !pathname.startsWith('/pic/')
      && !pathname.startsWith('/templates/')
      && !pathname.startsWith('/public/')
      && !pathname.startsWith('/js/')
      && !pathname.startsWith('/css/')
      && !pathname.startsWith('/html/')
      && !pathname.startsWith('/icons/')) {
    const payload = await resolveAuthPayload(c.req.raw, JWT_TOKEN);
    if (!payload) return c.redirect('/templates/loading.html', 302);
  }

  if (PROTECTED.has(pathname)) {
    const payload = await resolveAuthPayload(c.req.raw, JWT_TOKEN);
    if (!payload) {
      const redirect = pathname.includes('mailbox') ? '/html/mailbox.html' : '/admin.html';
      return c.redirect(`/templates/loading.html?redirect=${encodeURIComponent(redirect)}`, 302);
    }
    if (pathname.includes('mailbox') && payload.role !== 'mailbox') return c.redirect('/', 302);
    if (!pathname.includes('mailbox')) {
      const allowed = (payload.role === 'admin' || payload.role === 'guest' || payload.role === 'mailbox');
      if (!allowed) return c.redirect('/', 302);
    }
  }

  return serveAsset(c, PATH_MAP[pathname] || null);
});

export default router;
