/**
 * Production specials push — GitHub Actions / Cloudflare only (no local PC required).
 * Multi-strategy, retries, cache-busting, UA + proxy rotation. Never wipes live KV on failure.
 *
 *   node scripts/push-specials.mjs [workerBase]
 *
 * Env:
 *   INGEST_SECRET   — required in CI (X-Ingest-Secret)
 *   PROXY_URL       — optional single http(s) proxy
 *   PROXY_URLS      — optional comma-separated proxies (rotated with direct)
 *   FB_PAGE         — default elsombreroexpress
 *   APIFY_TOKEN     — optional paid Apify fallback
 *   APIFY_ACTOR_ID  — default apify/facebook-posts-scraper
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const base = (process.argv[2] || process.env.WORKER_BASE || 'https://el-sombrero-express.nic-58f.workers.dev').replace(
  /\/$/,
  ''
);
const PAGE = process.env.FB_PAGE || 'elsombreroexpress';
const INGEST_SECRET = process.env.INGEST_SECRET || '';
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_ACTOR = process.env.APIFY_ACTOR_ID || 'apify/facebook-posts-scraper';

const SEED = ['https://www.facebook.com/share/p/14YXEbC1wLB/'];
const UAS = [
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Facebot'
];

const RSSHUB = [
  `https://rsshub.app/facebook/page/${PAGE}`,
  `https://rsshub.rssforever.com/facebook/page/${PAGE}`,
  `https://rsshub.pseudoyu.com/facebook/page/${PAGE}`,
  `https://rsshub.woodland.cafe/facebook/page/${PAGE}`,
  `https://rss.shab.fun/facebook/page/${PAGE}`
];

const PROXIES = [
  '',
  ...String(process.env.PROXY_URLS || process.env.PROXY_URL || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withBust(url) {
  return `${url}${url.includes('?') ? '&' : '?'}cb=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toMbasic(url) {
  return String(url || '')
    .replace('://www.facebook.com', '://mbasic.facebook.com')
    .replace('://m.facebook.com', '://mbasic.facebook.com')
    .replace('://web.facebook.com', '://mbasic.facebook.com');
}

function curlHtml(url, { ua, proxy = '', bust = true } = {}) {
  const exe = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const target = bust ? withBust(url) : url;
  const args = [
    '-sL',
    '--max-time',
    '45',
    '--retry',
    '2',
    '--retry-delay',
    '1',
    '-A',
    ua || UAS[0],
    '-H',
    'Accept-Language: en-US,en;q=0.9',
    '-H',
    'Cache-Control: no-cache',
    '-H',
    'Pragma: no-cache',
    target
  ];
  if (proxy) args.splice(1, 0, '-x', proxy);
  const r = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < 300) return null;
  return r.stdout;
}

async function curlHtmlRetries(url, tries = 6) {
  const variants = [url];
  if (/facebook\.com/i.test(url)) {
    const mb = toMbasic(url);
    if (mb !== url) variants.push(mb);
  }
  for (let i = 0; i < tries; i++) {
    const ua = UAS[i % UAS.length];
    const proxy = PROXIES[i % PROXIES.length];
    const variant = variants[i % variants.length];
    const html = curlHtml(variant, { ua, proxy, bust: true });
    if (html && /og:description|og:title|<item>|<entry|og:image/i.test(html)) return html;
    await sleep(500 * Math.pow(1.6, i));
  }
  return null;
}

function meta(html, prop) {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta\\s+property=["']${esc}["']\\s+content=["'](.*?)["']`, 'is'),
    new RegExp(`<meta\\s+content=["'](.*?)["']\\s+property=["']${esc}["']`, 'is'),
    new RegExp(`<meta\\s+name=["']${esc}["']\\s+content=["'](.*?)["']`, 'is'),
    new RegExp(`<meta\\s+content=["'](.*?)["']\\s+name=["']${esc}["']`, 'is')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      return m[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
        .trim();
    }
  }
  return null;
}

/** Keep in sync with worker/specials.js isSpecialText */
function isSpecial(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return false;
  if (/special\s+thanks|especially|specialty\s+coffee|log in or sign up|see posts, photos/.test(s)) {
    return false;
  }
  if (/special\s+of\s+the\s+day/.test(s)) return true;
  if (/\btoday'?s\s+specials?\b/.test(s)) return true;
  if (/\b(daily|lunch|dinner)\s+specials?\b/.test(s)) return true;
  if (/\b\d{1,2}\.\d{2}\s+specials?\b/.test(s) || /\$\d+(?:\.\d{2})?\s+specials?\b/.test(s)) return true;
  if (/\b(tuesday|monday|wednesday|thursday|friday|saturday|sunday)\s+specials?\b/.test(s)) return true;
  if (/\btaco\s+tuesday\b/.test(s)) return true;
  if (/\bmenudo\b/.test(s) && /\bspecial\b|\btoday\b|\bwhile\s+it\s+lasts\b|\bcall\b/.test(s)) return true;
  if (/\bspecials?\b/.test(s)) {
    if (/\$\d|call\s+\d|pick\s*up|plate|burger|taco|enchilada|burrito|menudo|pozole|chile|salsa|fajita/i.test(s)) {
      return true;
    }
    if (/^[\s\W]*\$?\d/.test(s) || s.length < 280) return true;
  }
  if (/\$\d/.test(s) && /(call|order|pick\s*up|plate|burger|taco|enchilada)/.test(s)) return true;
  return false;
}

function loadFileUrls() {
  const out = [];
  const file = resolve(root, 'facebook-post-urls.txt');
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (/facebook\.com/i.test(t)) out.push(t);
  }
  return out;
}

async function loadLiveUrls() {
  try {
    const res = await fetch(base + '/api/specials?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    const urls = [];
    for (const p of [...(data.posts || []), ...(data.allKnown || []), data.post].filter(Boolean)) {
      if (p.link) urls.push(p.link);
    }
    return urls;
  } catch {
    return [];
  }
}

async function loadSeedUrls() {
  try {
    const res = await fetch(base + '/api/specials/seed-urls?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : Array.isArray(data.urls) ? data.urls : [];
  } catch {
    return [];
  }
}

function parseRssItems(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const link =
      (block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] ||
      (block.match(/<link[^>]+href=["']([^"']+)["']/i) || [])[1] ||
      '';
    const desc =
      (block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] ||
      (block.match(/<content[^>]*>([\s\S]*?)<\/content>/i) || [])[1] ||
      '';
    const clean = (s) =>
      String(s || '')
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const caption = `${clean(title)}\n${clean(desc)}`.trim();
    if (!isSpecial(caption)) continue;
    const img =
      (desc.match(/src=["'](https?:\/\/[^"']+)["']/i) || [])[1] ||
      (block.match(/url=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i) || [])[1] ||
      null;
    items.push({
      title: clean(title) || 'Special',
      link: clean(link),
      captionText: caption,
      image: img,
      source: 'rsshub'
    });
  }
  return items;
}

async function tryFacebookScraper() {
  const pyBins = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  const script = `
try:
  from facebook_scraper import get_posts
  import json
  out=[]
  for i,p in enumerate(get_posts('${PAGE}', pages=3, timeout=30)):
    text=(p.get('text') or p.get('post_text') or '')
    out.append({
      'title': (text.split('\\n')[0] if text else 'Special')[:120],
      'link': p.get('post_url') or '',
      'captionText': text,
      'image': (p.get('images') or [None])[0] or p.get('image'),
      'published': str(p.get('time') or ''),
      'source': 'facebook-scraper'
    })
    if i>=12: break
  print(json.dumps(out))
except Exception:
  print('[]')
`;
  for (const bin of pyBins) {
    const py = spawnSync(bin, ['-c', script], { encoding: 'utf8', timeout: 90000 });
    if (py.status !== 0 || !py.stdout) continue;
    try {
      const arr = JSON.parse(py.stdout.trim() || '[]');
      if (Array.isArray(arr) && arr.length) {
        return arr.filter((p) => isSpecial(p.captionText || p.title));
      }
    } catch {
      /* try next bin */
    }
  }
  return [];
}

async function tryApify() {
  if (!APIFY_TOKEN) return [];
  try {
    const start = await fetch(`https://api.apify.com/v2/acts/${encodeURIComponent(APIFY_ACTOR)}/runs?token=${APIFY_TOKEN}&waitForFinish=90`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startUrls: [{ url: `https://www.facebook.com/${PAGE}/` }],
        resultsLimit: 12,
        onlyPostsNewerThan: '7 days'
      })
    });
    if (!start.ok) {
      console.log('  apify start', start.status);
      return [];
    }
    const run = await start.json();
    const datasetId = run?.data?.defaultDatasetId;
    if (!datasetId) return [];
    const itemsRes = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true&format=json`
    );
    if (!itemsRes.ok) return [];
    const items = await itemsRes.json();
    if (!Array.isArray(items)) return [];
    return items
      .map((p) => ({
        title: String(p.text || p.message || 'Special').split('\n')[0].slice(0, 120),
        link: p.url || p.postUrl || p.facebookUrl || '',
        captionText: p.text || p.message || '',
        image: (p.media && p.media[0] && (p.media[0].photo_image?.uri || p.media[0].thumbnail)) || p.image || null,
        published: p.time || p.timestamp || '',
        source: 'apify'
      }))
      .filter((p) => isSpecial(p.captionText || p.title));
  } catch (err) {
    console.log('  apify error', err.message || err);
    return [];
  }
}

async function downloadImageAsBase64(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(withBust(url), {
        headers: {
          'User-Agent': UAS[(i + 1) % UAS.length],
          Accept: 'image/*,*/*',
          'Cache-Control': 'no-cache'
        }
      });
      if (!res.ok) {
        await sleep(400 * (i + 1));
        continue;
      }
      const type = res.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 4 * 1024 * 1024) return null;
      return { type, base64: buf.toString('base64') };
    } catch {
      await sleep(400 * (i + 1));
    }
  }
  return null;
}

function normalizeId(link, caption) {
  const m =
    String(link || '').match(/\/(\d{10,})\/?$/) ||
    String(link || '').match(/\/share\/p\/([A-Za-z0-9]+)/) ||
    String(link || '').match(/story_fbid=(\d+)/) ||
    String(link || '').match(/\/posts\/[^/]+\/(\d+)/);
  if (m) return m[1];
  let h = 2166136261;
  const s = String(caption || link || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

const [liveUrls, seedUrls] = await Promise.all([loadLiveUrls(), loadSeedUrls()]);
const targets = uniq([...SEED, ...loadFileUrls(), ...seedUrls, ...liveUrls]).slice(0, 24);
console.log('Worker', base);
console.log('Proxies', PROXIES.length, '(includes direct)');
console.log('Targets', targets.length);

const collected = [];

// Strategy A: OG on known URLs (+ mbasic variants inside retries)
for (const url of targets) {
  console.log('OG', url);
  const html = await curlHtmlRetries(url, 6);
  if (!html) {
    console.log('  miss');
    continue;
  }
  const title = meta(html, 'og:title') || '';
  const desc = meta(html, 'og:description') || '';
  const image = meta(html, 'og:image');
  const canonical = meta(html, 'og:url') || url;
  const caption = title && desc && title !== desc ? `${title}\n${desc}` : desc || title;
  if (!isSpecial(caption) && !isSpecial(title)) {
    console.log('  skip', JSON.stringify((caption || title).slice(0, 70)));
    continue;
  }
  collected.push({
    title: title || 'Special',
    link: canonical,
    captionText: caption,
    image,
    source: 'facebook-og-push'
  });
  console.log('  ok');
}

// Strategy B: RSSHub mirrors
for (const feed of RSSHUB) {
  console.log('RSS', feed);
  const xml = await curlHtmlRetries(feed, 4);
  if (!xml || xml.length < 200) {
    console.log('  miss');
    continue;
  }
  const items = parseRssItems(xml);
  console.log('  matched', items.length);
  collected.push(...items);
  if (items.length) break;
}

// Strategy C: facebook-scraper (optional)
console.log('Trying facebook-scraper...');
const scraped = await tryFacebookScraper();
console.log('  scraper posts', scraped.length);
collected.push(...scraped);

// Strategy D: Apify (optional paid)
if (APIFY_TOKEN) {
  console.log('Trying Apify...');
  const apifyPosts = await tryApify();
  console.log('  apify posts', apifyPosts.length);
  collected.push(...apifyPosts);
}

// Dedupe
const posts = [];
const seen = new Set();
for (const raw of collected) {
  if (!isSpecial(raw.captionText || raw.title)) continue;
  const id = normalizeId(raw.link, raw.captionText);
  if (seen.has(id)) continue;
  seen.add(id);
  let imagePayload = null;
  if (raw.image) {
    console.log('  image', id);
    imagePayload = await downloadImageAsBase64(raw.image);
  }
  posts.push({
    id,
    network: 'facebook',
    title: raw.title || 'Special',
    link: raw.link || `https://www.facebook.com/${PAGE}/`,
    published: raw.published || new Date().toISOString(),
    captionText: raw.captionText || raw.title || '',
    image: raw.image || null,
    imageRemote: raw.image || null,
    source: raw.source || 'push',
    _imageBase64: imagePayload?.base64 || null,
    _imageType: imagePayload?.type || null
  });
}

if (!posts.length) {
  console.log('No specials found — leaving live KV unchanged (safe no-op).');
  process.exit(0);
}

const payload = {
  updatedAt: new Date().toISOString(),
  scrapedAt: new Date().toISOString(),
  timezone: 'America/Denver',
  source: [...new Set(posts.map((p) => p.source))].join('+'),
  found: true,
  scrapeOk: true,
  stale: false,
  post: posts[0],
  posts,
  allKnown: posts,
  errors: []
};

const headers = { 'Content-Type': 'application/json' };
if (INGEST_SECRET) headers['X-Ingest-Secret'] = INGEST_SECRET;

let lastErr = null;
for (let i = 0; i < 5; i++) {
  try {
    const res = await fetch(base + '/api/specials/ingest', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    console.log('ingest', res.status, json.success ? 'ok' : json);
    if (res.ok && json.success) {
      console.log('Pushed', posts.length, 'special(s)');
      process.exit(0);
    }
    lastErr = json;
  } catch (err) {
    lastErr = err;
  }
  await sleep(900 * (i + 1));
}
console.error('Ingest failed', lastErr);
process.exit(1);
