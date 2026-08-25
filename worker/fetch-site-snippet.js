/**
 * FETCH-SITE MODE for the forge-api-proxy Cloudflare worker
 * ─────────────────────────────────────────────────────────
 * Lets the VSL Engine scan a client's website: the app POSTs
 *   { "action": "fetch_site", "url": "https://clientsite.com" }
 * and gets back
 *   { "pages": [ { "url", "title", "text" } ], "skipped": [ ... ] }
 *
 * HOW TO INSTALL (Cloudflare dashboard → the forge-api-proxy worker → Edit code):
 *
 * 1. Paste everything below the divider line into the worker file (top level,
 *    outside your fetch handler).
 *
 * 2. In your fetch handler, right after you parse the request body (and after
 *    your OPTIONS/CORS handling), add:
 *
 *      if (body.action === 'fetch_site') {
 *        return handleFetchSite(body, corsHeaders);
 *      }
 *
 *    where corsHeaders is the same CORS headers object you already attach to
 *    responses. Requests without action:'fetch_site' behave exactly as before.
 *
 * 3. RECOMMENDED while you're in there — allow localhost for dev. If your CORS
 *    header is currently hardcoded to 'https://forgemarketing.github.io',
 *    replace it with an allowlist check:
 *
 *      const ALLOWED_ORIGINS = [
 *        'https://forgemarketing.github.io',
 *        'http://localhost:8137',
 *      ];
 *      const origin = request.headers.get('Origin') || '';
 *      const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
 *      // then use corsOrigin as the Access-Control-Allow-Origin value
 *
 *    That makes generation and site-scanning work from a local dev server too.
 *
 * 4. Deploy. Nothing else in the app needs to change.
 */

// ─────────────────────────── paste below this line ───────────────────────────

const FETCH_SITE_KEYWORDS = ['service','testimonial','review','about','case-stud','results','work','portfolio','pricing','why'];
const FETCH_SITE_MAX_PAGES = 5;       // homepage + up to 4 subpages
const FETCH_SITE_MAX_CHARS = 9000;    // per page, keeps the extraction prompt sane
const FETCH_SITE_UA = 'Mozilla/5.0 (compatible; ForgeVSLEngine/1.0; +https://forgemarketingteam.com)';

async function handleFetchSite(body, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const reply = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: jsonHeaders });

  let root;
  try {
    root = new URL(body.url);
    if (!/^https?:$/.test(root.protocol)) throw new Error('bad protocol');
  } catch (e) {
    return reply({ error: 'Invalid URL.' }, 400);
  }

  const fetchPage = async (url) => {
    const res = await fetch(url, {
      headers: { 'User-Agent': FETCH_SITE_UA, 'Accept': 'text/html' },
      redirect: 'follow',
      cf: { cacheTtl: 300 },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const type = res.headers.get('Content-Type') || '';
    if (!type.includes('html')) throw new Error('not an HTML page');
    return await res.text();
  };

  const pages = [];
  const skipped = [];

  let homeHtml;
  try {
    homeHtml = await fetchPage(root.href);
  } catch (e) {
    return reply({ error: 'Could not fetch ' + root.href + ' — ' + e.message }, 502);
  }
  pages.push({ url: root.href, title: extractTitle(homeHtml), text: htmlToText(homeHtml).slice(0, FETCH_SITE_MAX_CHARS) });

  // Same-origin links whose path or anchor text smells like services / proof / about
  const candidates = [];
  const seen = new Set([normalizeUrl(root.href)]);
  const linkRe = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(homeHtml)) !== null) {
    let href;
    try { href = new URL(m[1], root.href); } catch (e) { continue; }
    if (href.origin !== root.origin) continue;
    const key = normalizeUrl(href.href);
    if (seen.has(key)) continue;
    const label = (href.pathname + ' ' + htmlToText(m[2])).toLowerCase();
    if (!FETCH_SITE_KEYWORDS.some(k => label.includes(k))) continue;
    seen.add(key);
    candidates.push(href.href);
    if (candidates.length >= FETCH_SITE_MAX_PAGES - 1) break;
  }

  await Promise.all(candidates.map(async (url) => {
    try {
      const html = await fetchPage(url);
      pages.push({ url, title: extractTitle(html), text: htmlToText(html).slice(0, FETCH_SITE_MAX_CHARS) });
    } catch (e) {
      skipped.push({ url, reason: e.message });
    }
  }));

  return reply({ pages: pages.filter(p => p.text.trim()), skipped });
}

function normalizeUrl(u) {
  return u.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 120) : '';
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
