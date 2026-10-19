// Forge API proxy — Cloudflare Worker behind the VSL Engine (apps/content-tool).
// Zero dependencies. Deploy with wrangler from this folder, so the rate-limit
// bindings in wrangler.toml come along (a dashboard paste would drop them):
//   npx wrangler deploy
//
// Secrets (never in this file, a URL, a log or chat; set each with
// `npx wrangler secret put <NAME>`):
//   ANTHROPIC_API_KEY    the Anthropic key the tool spends
//   TOOL_PASSWORD        the password people type on the tool's sign-in screen (16+ characters)
//   SESSION_SIGNING_KEY  random bytes that sign session tokens (`openssl rand -base64 48`);
//                        replacing it signs everyone out at once
// Missing or weak secrets make the worker answer 503 to everything: it fails closed.
//
// Access: every call except sign-in needs `Authorization: Bearer <token>`. The page
// gets a token by POSTing { action: 'login', password }. A token is an HMAC-SHA256
// signed { sid, iat, exp } that lasts SESSION_TTL_SECONDS. The Origin header is only
// used for CORS, which tells browsers which pages may read a reply. CORS is not
// access control: any script can send any Origin it likes.
//
// Modes (POST, JSON body):
//   { action: 'login', password }  -> { token, expires_at }   (no token needed)
//   { prompt, max_tokens? }        -> Claude generation (streams internally, returns parsed JSON)
//   { action: 'fetch_site', url }  -> crawl a client site (homepage + up to 4 service/proof/about
//                                     subpages), return stripped text for the VSL Engine's auto-fill

const MODEL = 'claude-opus-5';

// Pages allowed to read replies in a browser. Add any other origin you serve the app from.
const ALLOWED_ORIGINS = [
  'https://forgemarketing.github.io', // GitHub Pages (ForgeMarketing/forge-content-tool)
  'http://localhost:8137',            // local dev (pnpm -C apps/content-tool dev)
  'http://localhost:3100',            // the Forge platform dev hub (apps/web), which embeds this tool
];

// Generating several full scripts plus a hook bank is a large response, and on this
// model thinking tokens share the same budget as the answer. Too small a cap is what
// truncates the JSON mid-string and produces "Failed to parse Claude response".
const DEFAULT_MAX_TOKENS = 24000;
// The page never asks for more than 40,000 (index.html: Math.min(40000, ...)), so
// nothing above that is the tool. This caps what one call can cost.
const MAX_MAX_TOKENS = 40000;
// Real prompts stay well under 100k characters (index.html cuts each file to 8,000).
const MAX_PROMPT_CHARS = 200000;
const MAX_BODY_CHARS = 2 * MAX_PROMPT_CHARS; // JSON escaping can inflate a prompt
const MAX_LOGIN_BODY_CHARS = 2000;

// Sign-in
const SESSION_TTL_SECONDS = 12 * 60 * 60; // one working day
const MIN_PASSWORD_LENGTH = 16;
const MIN_SIGNING_KEY_LENGTH = 32;

// Site-scan limits
const FETCH_SITE_KEYWORDS = ['service','testimonial','review','about','case-stud','results','work','portfolio','pricing','why'];
const FETCH_SITE_MAX_PAGES = 5;       // homepage + up to 4 subpages
const FETCH_SITE_MAX_CHARS = 9000;    // per page, keeps the extraction prompt sane
// A real browser UA — WordPress security plugins (e.g. on besthvacinc.com)
// serve bot-identifying UAs an empty challenge page, which made scans return
// zero pages. Standard Chrome UA passes.
const FETCH_SITE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), origin);
    if (request.method !== 'POST') return reply({ error: 'Use POST.' }, 405, origin);

    const problem = configProblem(env);
    if (problem) return reply({ error: problem }, 503, origin);

    const token = bearer(request);

    // Without a token the only thing a caller may do is sign in.
    if (!token) {
      const parsed = await readJson(request, MAX_LOGIN_BODY_CHARS);
      if (parsed.value && parsed.value.action === 'login') return handleLogin(parsed.value, request, env, origin);
      return unauthorized(origin);
    }

    const session = await verifyToken(token, env.SESSION_SIGNING_KEY);
    if (!session) return unauthorized(origin);

    if (!(await underLimit(env.API_LIMITER, 'sid:' + session.sid))) {
      return reply({ error: 'Too many requests. Wait a minute and try again.', code: 'rate_limited' }, 429, origin);
    }

    const parsed = await readJson(request, MAX_BODY_CHARS);
    if (parsed.error === 'too_large') return reply({ error: 'Request body is too large.' }, 413, origin);
    if (!parsed.value) return reply({ error: 'Request body was not valid JSON.' }, 400, origin);
    const body = parsed.value;

    // Site scan needs no model call.
    if (body.action === 'fetch_site') return handleFetchSite(body, origin);
    if (body.action === 'login') return reply({ error: 'Already signed in.' }, 400, origin);
    if (body.action !== undefined) return reply({ error: 'Unknown action.' }, 400, origin);

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return reply({ error: 'Missing "prompt" in request body.' }, 400, origin);
    if (prompt.length > MAX_PROMPT_CHARS) {
      return reply({ error: `Prompt is ${prompt.length.toLocaleString()} characters; the limit is ${MAX_PROMPT_CHARS.toLocaleString()}.` }, 413, origin);
    }

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
        const parsedErr = JSON.parse(raw);
        detail = parsedErr.error?.message || parsedErr.message || detail;
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
        error: `Response hit the ${maxTokens.toLocaleString()} token limit and was cut off before the JSON finished. Generate fewer scripts at once.`,
        stop_reason: stopReason,
      }, 502, origin);
    }

    const result = extractJson(text);
    if (!result) {
      return reply({
        error: 'Claude replied, but the response was not valid JSON.',
        stop_reason: stopReason,
        raw_preview: text.trim().slice(0, 600),
      }, 502, origin);
    }

    return reply(result, 200, origin);
  },
};

// ── SIGN-IN AND SESSIONS ──────────────────────────────────────────────────────

// Names only, never values. Anything missing or weak shuts the worker rather than
// leaving a door open.
function configProblem(env) {
  const missing = ['ANTHROPIC_API_KEY', 'TOOL_PASSWORD', 'SESSION_SIGNING_KEY'].filter(n => !env[n]);
  if (missing.length) {
    return `This worker is missing the secret(s) ${missing.join(', ')}. Set each with: npx wrangler secret put <NAME>`;
  }
  if (String(env.TOOL_PASSWORD).trim().length < MIN_PASSWORD_LENGTH) {
    return `TOOL_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (String(env.SESSION_SIGNING_KEY).length < MIN_SIGNING_KEY_LENGTH) {
    return `SESSION_SIGNING_KEY must be at least ${MIN_SIGNING_KEY_LENGTH} characters (openssl rand -base64 48).`;
  }
  return null;
}

async function handleLogin(body, request, env, origin) {
  // Sign-in has no session yet, so the caller's IP is the only key there is.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await underLimit(env.LOGIN_LIMITER, 'ip:' + ip))) {
    return reply({ error: 'Too many sign-in attempts. Wait a minute and try again.', code: 'rate_limited' }, 429, origin);
  }

  const password = typeof body.password === 'string' ? body.password.trim() : '';
  if (!password || password.length > 512 || !(await sameSecret(password, String(env.TOOL_PASSWORD).trim(), env.SESSION_SIGNING_KEY))) {
    return reply({ error: 'Incorrect password.', code: 'bad_password' }, 401, origin);
  }

  const now = nowSeconds();
  const exp = now + SESSION_TTL_SECONDS;
  const token = await signToken({ v: 1, sid: crypto.randomUUID(), iat: now, exp }, env.SESSION_SIGNING_KEY);
  return reply({ token, expires_at: exp * 1000 }, 200, origin);
}

function unauthorized(origin) {
  return reply({ error: 'Sign in first.', code: 'unauthorized' }, 401, origin);
}

function bearer(request) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '');
  return m ? m[1] : '';
}

// A missing binding skips the limit instead of locking everyone out: sign-in still
// needs the password and every call still needs a signed token. The PR's verify
// step proves the limits are on after a deploy.
async function underLimit(limiter, key) {
  if (!limiter || typeof limiter.limit !== 'function') return true;
  try {
    const { success } = await limiter.limit({ key });
    return success !== false;
  } catch {
    return true;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
let cachedKey = null;
let cachedKeySecret = null;

async function hmacKey(secret) {
  if (cachedKey && cachedKeySecret === secret) return cachedKey;
  cachedKey = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  cachedKeySecret = secret;
  return cachedKey;
}

// Compares two strings in constant time by comparing their fixed-length HMACs.
async function sameSecret(a, b, keySecret) {
  const key = await hmacKey(keySecret);
  const [da, db] = await Promise.all([a, b].map(s => crypto.subtle.sign('HMAC', key, enc.encode(s))));
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function signToken(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return body + '.' + b64url(new Uint8Array(sig));
}

async function verifyToken(token, secret) {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let sig;
  let payload;
  try {
    sig = fromB64url(parts[1]);
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(parts[0]));
    if (!ok) return null;
    payload = JSON.parse(dec.decode(fromB64url(parts[0])));
  } catch {
    return null;
  }
  const now = nowSeconds();
  if (!payload || payload.v !== 1 || typeof payload.sid !== 'string') return null;
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return null;
  if (payload.exp <= now || payload.iat > now + 60 || payload.exp - payload.iat > SESSION_TTL_SECONDS) return null;
  return payload;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  if (!/^[A-Za-z0-9_-]+$/.test(str)) throw new Error('not base64url');
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function readJson(request, maxChars) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxChars * 4) return { error: 'too_large' };
  let raw;
  try {
    raw = await request.text();
  } catch {
    return { error: 'unreadable' };
  }
  if (raw.length > maxChars) return { error: 'too_large' };
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { error: 'not_object' };
  } catch {
    return { error: 'bad_json' };
  }
}

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
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  }), origin);
}

// Browser read permission only. A page on another origin gets no CORS headers, so
// its browser hides the reply; that is all CORS can do.
function cors(response, origin) {
  if (ALLOWED_ORIGINS.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    response.headers.set('Access-Control-Max-Age', '86400');
  }
  response.headers.set('Vary', 'Origin');
  return response;
}
