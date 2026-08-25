// Forge API proxy — Cloudflare Worker
// Zero dependencies: paste into the Cloudflare dashboard editor, or deploy with wrangler.
//
// Required: set the API key as a SECRET named ANTHROPIC_API_KEY.
//   Dashboard: Workers & Pages -> this worker -> Settings -> Variables and Secrets -> Add -> Secret
//   Wrangler:  npx wrangler secret put ANTHROPIC_API_KEY
// Never paste the key into this file.
//
// Modes:
//   { prompt, max_tokens? }        -> Claude generation (streams internally, returns parsed JSON)
//   { action: 'fetch_site', url }  -> crawl a client site (homepage + up to 4 service/proof/about
//                                     subpages), return stripped text for the VSL Engine's auto-fill

const MODEL = 'claude-opus-5';

// Browsers outside this list are refused. Add any other origin you serve the app from.
const ALLOWED_ORIGINS = [
  'https://forgemarketing.github.io',
  'http://localhost:8137',        // local dev (python3 -m http.server 8137)
];

// Generating several full scripts plus a hook bank is a large response, and on this
// model thinking tokens share the same budget as the answer. Too small a cap is what
// truncates the JSON mid-string and produces "Failed to parse Claude response".
const DEFAULT_MAX_TOKENS = 24000;
const MAX_MAX_TOKENS = 64000;

// Site-scan limits
const FETCH_SITE_KEYWORDS = ['service','testimonial','review','about','case-stud','results','work','portfolio','pricing','why'];
const FETCH_SITE_MAX_PAGES = 5;       // homepage + up to 4 subpages
const FETCH_SITE_MAX_CHARS = 9000;    // per page, keeps the extraction prompt sane
const FETCH_SITE_UA = 'Mozilla/5.0 (compatible; ForgeVSLEngine/1.0; +https://forgemarketingteam.com)';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), origin);
    if (request.method !== 'POST') return reply({ error: 'Use POST.' }, 405, origin);

    let body;
    try {
      body = await request.json();
    } catch {
      return reply({ error: 'Request body was not valid JSON.' }, 400, origin);
    }

    // Site scan needs no API key and no model call.
    if (body.action === 'fetch_site') {
      return handleFetchSite(body, origin);
    }

    if (!env.ANTHROPIC_API_KEY) {
      return reply({ error: 'ANTHROPIC_API_KEY is not set on this worker. Add it under Settings -> Variables and Secrets as a Secret.' }, 500, origin);
    }

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return reply({ error: 'Missing "prompt" in request body.' }, 400, origin);

    const maxTokens = clamp(Number(body.max_tokens) || DEFAULT_MAX_TOKENS, 1024, MAX_MAX_TOKENS);

    // Streaming keeps the connection alive through long generations. The worker still
    // returns one complete JSON response to the browser — the stream is internal.
    let upstream;
    try {
      upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          stream: true,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (e) {
      return reply({ error: 'Could not reach the Anthropic API: ' + (e.message || 'network error') }, 502, origin);
    }

    if (!upstream.ok) {
      const raw = await upstream.text();
      let detail = raw.trim().slice(0, 500);
      try {
        const parsed = JSON.parse(raw);
        detail = parsed.error?.message || parsed.message || detail;
      } catch { /* not JSON — keep the raw text */ }
      return reply({ error: `Anthropic API ${upstream.status}: ${detail}` }, 502, origin);
    }

    let text = '';
    let stopReason = null;

    try {
      const reader = upstream.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            text += event.delta.text;
          } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason;
          } else if (event.type === 'error') {
            return reply({ error: 'Anthropic stream error: ' + (event.error?.message || 'unknown') }, 502, origin);
          }
        }
      }
    } catch (e) {
      return reply({ error: 'Connection dropped while reading the response: ' + (e.message || 'stream error') }, 502, origin);
    }

    if (stopReason === 'refusal') {
      return reply({ error: 'Claude declined this request. Rephrase the brief and try again.' }, 502, origin);
    }

    // Name the real cause instead of reporting a generic parse failure.
    if (stopReason === 'max_tokens') {
      return reply({
        error: `Response hit the ${maxTokens.toLocaleString()} token limit and was cut off before the JSON finished. Generate fewer scripts at once, or raise DEFAULT_MAX_TOKENS in the worker.`,
        stop_reason: stopReason,
      }, 502, origin);
    }

    const parsed = extractJson(text);
    if (!parsed) {
      return reply({
        error: 'Claude replied, but the response was not valid JSON.',
        stop_reason: stopReason,
        raw_preview: text.trim().slice(0, 600),
      }, 502, origin);
    }

    return reply(parsed, 200, origin);
  },
};

// ── SITE SCAN ─────────────────────────────────────────────────────────────────
// Fetches the homepage, finds same-origin links whose path or anchor text looks
// like services / proof / about pages, fetches up to 4 of them, and returns
// stripped text per page. The app runs the extraction prompt on the result.

async function handleFetchSite(body, origin) {
  let root;
  try {
    root = new URL(body.url);
    if (!/^https?:$/.test(root.protocol)) throw new Error('bad protocol');
  } catch {
    return reply({ error: 'Invalid URL.' }, 400, origin);
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
    return reply({ error: 'Could not fetch ' + root.href + ' — ' + e.message }, 502, origin);
  }
  pages.push({ url: root.href, title: extractTitle(homeHtml), text: htmlToText(homeHtml).slice(0, FETCH_SITE_MAX_CHARS) });

  const candidates = [];
  const seen = new Set([normalizeUrl(root.href)]);
  const linkRe = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(homeHtml)) !== null) {
    let href;
    try { href = new URL(m[1], root.href); } catch { continue; }
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

  return reply({ pages: pages.filter(p => p.text.trim()), skipped }, 200, origin);
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
// ──────────────────────────────────────────────────────────────────────────────

// Claude sometimes wraps JSON in code fences or adds a sentence before it.
// Try the whole string, then the outermost {...} span.
function extractJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through */ }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch { /* fall through */ }
  }
  return null;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

function reply(obj, status, origin) {
  return cors(new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  }), origin);
}

function cors(response, origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  response.headers.set('Access-Control-Allow-Origin', allowed);
  response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  response.headers.set('Access-Control-Max-Age', '86400');
  response.headers.set('Vary', 'Origin');
  return response;
}
