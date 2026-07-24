/**
 * Daily specials — multi-source Facebook scraper + KV persistence.
 * Never clears last-good specials on failure. Caches images in KV.
 */

import puppeteer from '@cloudflare/puppeteer';

const FB_PAGE = 'elsombreroexpress';
const FB_PAGE_URL = `https://www.facebook.com/${FB_PAGE}/`;
const TZ = 'America/Denver';
const MAX_SPECIALS = 8;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Do not show specials older than this (ms). */
const MAX_AGE_MS = 36 * 60 * 60 * 1000;

/** Only intentionally current share/post URLs — never pin old specials here. */
const SEED_SHARE_URLS = [];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_FACEBOOK_BOT =
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

function metaProp(html, prop) {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta\\s+property=["']${esc}["']\\s+content=["'](.*?)["']`, 'is'),
    new RegExp(`<meta\\s+content=["'](.*?)["']\\s+property=["']${esc}["']`, 'is'),
    new RegExp(`<meta\\s+name=["']${esc}["']\\s+content=["'](.*?)["']`, 'is')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeHtml(m[1].trim());
  }
  return null;
}

/** Smart special detector — avoids "special thanks" noise. */
export function isSpecialText(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return false;
  if (/special\s+thanks|especially|specialty\s+coffee/.test(s)) return false;
  if (/special\s+of\s+the\s+day/.test(s)) return true;
  if (/\btoday'?s\s+specials?\b/.test(s)) return true;
  if (/\b(daily|lunch|dinner)\s+specials?\b/.test(s)) return true;
  if (/\b\d{1,2}\.\d{2}\s+specials?\b/.test(s) || /\$\d+(?:\.\d{2})?\s+specials?\b/.test(s)) {
    return true;
  }
  if (/\b(tuesday|monday|wednesday|thursday|friday|saturday|sunday)\s+specials?\b/.test(s)) {
    return true;
  }
  if (/\btaco\s+tuesday\b/.test(s)) return true;
  if (/\bmenudo\b/.test(s) && (/\bspecial\b|\btoday\b|\bwhile\s+it\s+lasts\b|\bcall\b/.test(s))) {
    return true;
  }
  // Generic "special" / "specials" as a word, with food/price cues nearby
  if (/\bspecials?\b/.test(s)) {
    if (/\$\d|call\s+\d|pick\s*up|plate|burger|taco|enchilada|burrito|menudo|pozole|chile|salsa|fajita/i.test(s)) {
      return true;
    }
    // Short restaurant-style captions that lead with special
    if (/^[\s\W]*\$?\d/.test(s) || s.length < 280) return true;
  }
  return false;
}

function localParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const bits = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    y: bits.year,
    m: bits.month,
    d: bits.day,
    key: `${bits.year}-${bits.month}-${bits.day}`
  };
}

function publishedLocalKey(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return localParts(d).key;
  } catch {
    return null;
  }
}

const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
};

/**
 * Pull an explicit calendar date from caption text (e.g. "April 21", "Aug 21st", "8/21").
 * Returns YYYY-MM-DD in America/Denver year context, or null.
 */
export function parseCaptionDateKey(text, ref = new Date()) {
  const s = String(text || '');
  if (!s.trim()) return null;
  const today = localParts(ref);
  const yearHint = Number(today.y);

  const named = s.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i
  );
  if (named) {
    const month = MONTHS[named[1].toLowerCase().replace(/\.$/, '')];
    const day = Number(named[2]);
    if (month && day >= 1 && day <= 31) {
      return `${yearHint}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const numeric = s.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (numeric) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    let year = numeric[3] ? Number(numeric[3]) : yearHint;
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return null;
}

function addDaysKey(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + delta));
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`;
}

function isTodayOrYesterday(key, ref = new Date()) {
  if (!key) return false;
  const today = localParts(ref).key;
  return key === today || key === addDaysKey(today, -1);
}

/**
 * Resolve best-effort publish time. Never invent "now" for undated OG scrapes —
 * that made April/Aug specials look fresh forever.
 */
export function resolvePublishedIso(post, scrapedAt = null) {
  const meta = post.published || post.created_time || post.publishedAt || null;
  if (meta) {
    const t = Date.parse(meta);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  const captionKey = parseCaptionDateKey(post.captionText || post.title || '');
  if (captionKey) {
    // Noon Denver ≈ 18:00/19:00 UTC depending on DST — store as date-only noon Z for sorting
    return `${captionKey}T18:00:00.000Z`;
  }
  // Timeline scrapes from this run may use scrape time only when source says so
  const src = String(post.source || '');
  if (scrapedAt && /timeline|browser-timeline|graph/i.test(src)) {
    return scrapedAt;
  }
  return null;
}

/** True when post is allowed on the homepage (≤ ~1 day old, caption date not ancient). */
export function isFreshSpecial(post, now = new Date()) {
  if (!post) return false;
  if (String(post.source || '') === 'test') return false;
  const text = `${post.captionText || ''}\n${post.title || ''}`;
  if (!isSpecialText(text)) return false;

  const captionKey = parseCaptionDateKey(text, now);
  if (captionKey && !isTodayOrYesterday(captionKey, now)) {
    return false;
  }

  const published = resolvePublishedIso(post);
  if (published) {
    const ts = Date.parse(published);
    if (!Number.isNaN(ts) && now.getTime() - ts > MAX_AGE_MS) return false;
    // Future posts more than a day out are also invalid
    if (!Number.isNaN(ts) && ts - now.getTime() > MAX_AGE_MS) return false;
    return true;
  }

  // No usable date → only allow if caption explicitly says today/yesterday
  return !!(captionKey && isTodayOrYesterday(captionKey, now));
}

export function filterFreshPosts(posts, now = new Date()) {
  return (Array.isArray(posts) ? posts : [])
    .map((p) => {
      const published = resolvePublishedIso(p) || p.published || null;
      return { ...p, published };
    })
    .filter((p) => isFreshSpecial(p, now))
    .sort((a, b) => (Date.parse(b.published || 0) || 0) - (Date.parse(a.published || 0) || 0));
}

/** Public API shape — never expose stale specials. */
export function publicSpecialsView(raw, now = new Date()) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const candidates = [
    ...(Array.isArray(base.posts) ? base.posts : []),
    base.post,
    ...(Array.isArray(base.allKnown) ? base.allKnown : [])
  ].filter(Boolean);
  const fresh = filterFreshPosts(dedupePosts(candidates.map((p) => normalizePost(p))), now).slice(
    0,
    MAX_SPECIALS
  );
  return {
    ...base,
    updatedAt: base.updatedAt || nowIso(),
    scrapedAt: base.scrapedAt || null,
    timezone: TZ,
    localDate: localParts(now).key,
    found: fresh.length > 0,
    stale: false,
    post: fresh[0] || null,
    posts: fresh,
    allKnown: Array.isArray(base.allKnown) ? base.allKnown.slice(0, 40) : fresh
  };
}

function postIdFromUrl(url) {
  const u = String(url || '');
  const m =
    u.match(/\/posts\/[^/]+\/(\d+)/) ||
    u.match(/story_fbid=(\d+)/) ||
    u.match(/\/permalink\/(\d+)/) ||
    u.match(/\/share\/p\/([A-Za-z0-9]+)/) ||
    u.match(/\/(\d{10,})\/?$/);
  return m ? m[1] : null;
}

function normalizePost(raw) {
  const link = String(raw.link || raw.url || '').trim();
  const captionText = String(raw.captionText || raw.message || raw.description || '').trim();
  const title = String(raw.title || '').trim() || captionText.split('\n')[0] || 'Special';
  const image = raw.image || raw.full_picture || raw.picture || null;
  const published = raw.published || raw.created_time || raw.publishedAt || null;
  const id = String(raw.id || postIdFromUrl(link) || hashStr(link + captionText).slice(0, 16));
  return {
    id,
    network: raw.network || 'facebook',
    title,
    link,
    published,
    captionText: captionText || title,
    image: image ? decodeHtml(String(image)) : null,
    source: raw.source || 'unknown'
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': opts.ua || UA,
      Accept: opts.accept || 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache'
    },
    signal: AbortSignal.timeout(opts.timeout || 25000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function scrapeOgPost(url) {
  for (const ua of [UA_FACEBOOK_BOT, UA]) {
    try {
      const html = await fetchText(url, { ua });
      if (!html || html.length < 500) continue;
      const post = parseOgHtml(html, url, 'facebook-og');
      if (post) return post;
    } catch {
      /* try next UA */
    }
  }
  return null;
}

function parseOgHtml(html, url, source) {
  if (!html || html.length < 400) return null;
  const title = metaProp(html, 'og:title') || '';
  const desc =
    metaProp(html, 'og:description') || metaProp(html, 'twitter:description') || '';
  const image = metaProp(html, 'og:image') || metaProp(html, 'twitter:image');
  const canonical = metaProp(html, 'og:url') || url;
  // Never invent "now" — that made old share URLs look fresh forever
  const published =
    metaProp(html, 'article:published_time') || metaProp(html, 'og:updated_time') || null;
  const caption =
    title && desc && title !== desc ? `${title}\n${desc}` : desc || title;
  if (!isSpecialText(caption) && !isSpecialText(title)) return null;
  const post = normalizePost({
    title: title || 'Facebook special',
    link: canonical,
    captionText: caption,
    image,
    published,
    source,
    network: 'facebook'
  });
  post.published = resolvePublishedIso(post);
  if (!isFreshSpecial(post)) return null;
  return post;
}

async function scrapeOgViaBrowserPage(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(1200);
    const html = await page.content();
    let post = parseOgHtml(html, url, 'facebook-browser-og');

    if (!post) {
      const visible = await page.evaluate(() => {
        const msg =
          document.querySelector('[data-ad-preview="message"]') ||
          document.querySelector('div[dir="auto"]');
        const text = (msg && msg.innerText) || document.body.innerText || '';
        const img = document.querySelector('img[src*="scontent"], img[src*="fbcdn"]');
        return {
          text: text.slice(0, 1500),
          image: img && img.src && !/emoji|static\.xx\.fbcdn/.test(img.src) ? img.src : null
        };
      });
      if (!isSpecialText(visible.text)) return null;
      post = normalizePost({
        title: visible.text.split('\n').find((l) => l.trim()) || 'Special',
        captionText: visible.text,
        link: url,
        image: visible.image,
        published: null,
        source: 'facebook-browser-og',
        network: 'facebook'
      });
      post.published = resolvePublishedIso(post);
      if (!isFreshSpecial(post)) return null;
    }

    if (post?.image) {
      try {
        const imgData = await page.evaluate(async (imageUrl) => {
          const res = await fetch(imageUrl, { credentials: 'omit' });
          if (!res.ok) return null;
          const type = res.headers.get('content-type') || 'image/jpeg';
          if (!type.startsWith('image/')) return null;
          const buf = new Uint8Array(await res.arrayBuffer());
          if (!buf.length || buf.length > 4 * 1024 * 1024) return null;
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < buf.length; i += chunk) {
            binary += String.fromCharCode(...buf.subarray(i, i + chunk));
          }
          return { type, base64: btoa(binary) };
        }, post.image);
        if (imgData?.base64) {
          post._imageBase64 = imgData.base64;
          post._imageType = imgData.type;
        }
      } catch {
        /* keep remote URL */
      }
    }
    return post;
  } catch {
    return null;
  }
}

async function scrapeGraphApi(env) {
  const token = env.FB_PAGE_ACCESS_TOKEN;
  if (!token) return { posts: [], error: null, skipped: true };
  const pageId = env.FB_PAGE_ID || FB_PAGE;
  const fields = 'id,message,full_picture,created_time,permalink_url';
  const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/posts?fields=${fields}&limit=25&access_token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const data = await res.json();
    if (!res.ok) {
      return { posts: [], error: `graph:${data.error?.message || res.status}` };
    }
    const posts = (data.data || [])
      .map((p) =>
        normalizePost({
          id: p.id,
          title: (p.message || '').split('\n')[0],
          captionText: p.message || '',
          image: p.full_picture,
          published: p.created_time,
          link: p.permalink_url,
          source: 'facebook-graph',
          network: 'facebook'
        })
      )
      .filter((p) => isSpecialText(p.captionText || p.title));
    return { posts, error: null };
  } catch (err) {
    return { posts: [], error: `graph:${err.message}` };
  }
}

async function scrapeWithBrowser(env, seedUrls = []) {
  if (!env.BROWSER) return { posts: [], urls: [], error: 'no-browser-binding' };
  let browser;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 1600 });
    page.setDefaultTimeout(45000);

    const specials = [];
    const discoveredUrls = [];

    // A) OG-scrape known share/post URLs inside the browser (Worker fetch is blocked by Meta)
    const ogTargets = [...new Set(seedUrls)].slice(0, 12);
    for (const url of ogTargets) {
      const post = await scrapeOgViaBrowserPage(page, url);
      if (post) {
        specials.push(post);
        if (post.link) discoveredUrls.push(post.link);
      }
    }

    // B) Timeline pass — may hit login wall; still try
    try {
      await page.goto(FB_PAGE_URL, { waitUntil: 'networkidle2', timeout: 45000 });
      await sleep(2000);
      await page.evaluate(() => {
        const closeTexts = ['Not Now', 'Decline optional cookies', 'Allow all cookies', 'Close'];
        for (const label of closeTexts) {
          const buttons = [...document.querySelectorAll('div[role="button"], button, span')];
          const el = buttons.find((b) => (b.textContent || '').trim() === label);
          if (el) el.click();
        }
        const close = document.querySelector('[aria-label="Close"]');
        if (close) close.click();
      });
      await sleep(1000);
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, 1400));
        await sleep(900);
      }

      const extracted = await page.evaluate(() => {
        const posts = [];
        const articles = [...document.querySelectorAll('div[role="article"]')];
        const seen = new Set();
        for (const art of articles) {
          const text = (art.innerText || '').trim();
          if (!text || text.length < 20) continue;
          const key = text.slice(0, 120);
          if (seen.has(key)) continue;
          seen.add(key);
          let link = null;
          for (const a of art.querySelectorAll('a[href]')) {
            const href = a.href || '';
            if (/\/posts\//.test(href) || /story_fbid=/.test(href) || /\/share\/p\//.test(href)) {
              link = href.split('?')[0];
              break;
            }
          }
          let image = null;
          const img = art.querySelector('img[src*="scontent"], img[src*="fbcdn"]');
          if (img && img.src && !/emoji|static\.xx\.fbcdn/.test(img.src)) image = img.src;
          posts.push({ text, link, image });
        }
        const urls = [...document.querySelectorAll('a[href*="/posts/"], a[href*="/share/p/"]')]
          .map((a) => (a.href || '').split('?')[0])
          .filter(Boolean);
        return { posts, urls: [...new Set(urls)].slice(0, 30) };
      });

      for (const u of extracted.urls || []) discoveredUrls.push(u);
      for (const p of extracted.posts || []) {
        if (!isSpecialText(p.text)) continue;
        const scrapedAt = nowIso();
        const post = normalizePost({
          title: p.text.split('\n').find((l) => l.trim()) || 'Special',
          captionText: p.text,
          link: p.link || FB_PAGE_URL,
          image: p.image,
          published: null,
          source: 'facebook-browser-timeline',
          network: 'facebook'
        });
        post.published = resolvePublishedIso(post, scrapedAt);
        if (isFreshSpecial(post)) specials.push(post);
      }

      // C) Newly discovered post URLs → browser OG
      for (const url of [...new Set(discoveredUrls)].slice(0, 8)) {
        if (ogTargets.includes(url)) continue;
        const post = await scrapeOgViaBrowserPage(page, url);
        if (post) specials.push(post);
      }
    } catch (err) {
      // Timeline can fail while OG seed URLs still succeeded
      discoveredUrls.push(`timeline-error:${err.message}`);
    }

    await browser.close();
    browser = null;

    return {
      posts: dedupePosts(specials),
      urls: [...new Set(discoveredUrls.filter((u) => /^https?:/i.test(u)))],
      error: null
    };
  } catch (err) {
    try {
      if (browser) await browser.close();
    } catch {
      /* ignore */
    }
    return { posts: [], urls: [], error: `browser:${err.message}` };
  }
}

async function loadSeedUrls(env) {
  const fromKv = await env.DATA.get('special-seed-urls', 'json');
  const list = [];
  const push = (u) => {
    const s = String(u || '').trim();
    if (s && /facebook\.com/i.test(s) && !list.includes(s)) list.push(s);
  };
  for (const u of SEED_SHARE_URLS) push(u);
  if (Array.isArray(fromKv)) for (const u of fromKv) push(u);
  if (fromKv && Array.isArray(fromKv.urls)) for (const u of fromKv.urls) push(u);
  return list;
}

async function cacheImage(env, post) {
  if (!post.image || post.image.startsWith('/api/specials/media/')) {
    return stripImageTemps(post);
  }

  // Prefer bytes captured inside Browser Rendering (Meta often blocks Worker image fetch)
  if (post._imageBase64) {
    try {
      const bin = Uint8Array.from(atob(post._imageBase64), (c) => c.charCodeAt(0));
      if (bin.byteLength && bin.byteLength <= MAX_IMAGE_BYTES) {
        const key = `special-img:${post.id}`;
        await env.DATA.put(key, bin, {
          metadata: {
            contentType: post._imageType || 'image/jpeg',
            source: post.image,
            cachedAt: nowIso()
          }
        });
        return stripImageTemps({
          ...post,
          imageRemote: post.image,
          image: `/api/specials/media/${encodeURIComponent(post.id)}`
        });
      }
    } catch {
      /* fall through */
    }
  }

  try {
    const res = await fetch(post.image, {
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*' },
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) return stripImageTemps(post);
    const type = res.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) return stripImageTemps(post);
    const buf = await res.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX_IMAGE_BYTES) return stripImageTemps(post);
    const key = `special-img:${post.id}`;
    await env.DATA.put(key, buf, {
      metadata: { contentType: type, source: post.image, cachedAt: nowIso() }
    });
    return stripImageTemps({
      ...post,
      imageRemote: post.image,
      image: `/api/specials/media/${encodeURIComponent(post.id)}`
    });
  } catch {
    return stripImageTemps(post);
  }
}

function stripImageTemps(post) {
  const { _imageBase64, _imageType, ...rest } = post;
  return rest;
}

function dedupePosts(posts) {
  const map = new Map();
  for (const p of posts) {
    const key = p.link || p.id || hashStr(p.captionText);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, p);
      continue;
    }
    const prevT = Date.parse(prev.published || 0) || 0;
    const nextT = Date.parse(p.published || 0) || 0;
    if (nextT >= prevT) map.set(key, { ...prev, ...p });
  }
  return [...map.values()];
}

/**
 * Only fresh specials (≤ ~1 day). Never fall back to week-old / historic posts.
 */
export function selectDisplayPosts(allPosts, now = new Date()) {
  return filterFreshPosts(allPosts, now).slice(0, MAX_SPECIALS);
}

function buildPayload({ posts, source, errors, previous, scrapeOk }) {
  const display = selectDisplayPosts(posts);
  const found = display.length > 0;
  return {
    updatedAt: nowIso(),
    scrapedAt: nowIso(),
    timezone: TZ,
    localDate: localParts().key,
    source,
    found,
    scrapeOk: !!scrapeOk,
    stale: !scrapeOk && !found,
    post: display[0] || null,
    posts: display,
    // Keep known list for seed discovery only — display never uses stale entries
    allKnown: posts.slice(0, 40),
    errors: (errors || []).slice(0, 40)
  };
}

/**
 * Full refresh pipeline. Preserves previous good posts if scrape finds nothing new.
 */
export async function refreshSpecials(env, { force = false } = {}) {
  const previous = (await env.DATA.get('special', 'json')) || null;
  if (previous?.manual === true && previous.manualUntil) {
    const until = Date.parse(previous.manualUntil);
    if (!force && until && until > Date.now()) {
      return { ...previous, skipped: 'manual-lock' };
    }
  }

  const errors = [];
  let collected = [];
  let sources = [];

  const seedUrls = await loadSeedUrls(env);
  const priorLinks = [];
  if (previous?.posts) for (const p of previous.posts) if (p.link) priorLinks.push(p.link);
  if (previous?.allKnown) for (const p of previous.allKnown) if (p.link) priorLinks.push(p.link);

  // 1) Graph API (best when FB_PAGE_ACCESS_TOKEN is set)
  const graph = await scrapeGraphApi(env);
  if (graph.error) errors.push(graph.error);
  if (graph.posts?.length) {
    collected.push(...graph.posts);
    sources.push('facebook-graph');
  }

  // 2) Browser Rendering — primary path (Meta blocks plain Worker fetch)
  const browserSeeds = [...new Set([...seedUrls, ...priorLinks])].slice(0, 12);
  const browser = await scrapeWithBrowser(env, browserSeeds);
  if (browser.error) errors.push(browser.error);
  if (browser.posts?.length) {
    collected.push(...browser.posts);
    if (browser.posts.some((p) => String(p.source || '').includes('browser'))) {
      sources.push('facebook-browser');
    }
  }

  // 3) Plain OG fetch fallback (often 400 from datacenter IPs — best-effort)
  const ogTargets = [...new Set([...seedUrls, ...(browser.urls || []), ...priorLinks])].slice(
    0,
    10
  );
  for (const url of ogTargets) {
    try {
      const post = await scrapeOgPost(url);
      if (post) {
        collected.push(post);
        if (!sources.includes('facebook-og')) sources.push('facebook-og');
      }
    } catch (err) {
      errors.push(`og:${url}:${err.message}`);
    }
  }

  const scrapedAt = nowIso();
  const fresh = dedupePosts(collected)
    .map((p) => {
      const n = normalizePost(p);
      n.published = resolvePublishedIso(n, scrapedAt);
      return n;
    })
    .filter((p) => isFreshSpecial(p));
  const scrapeOk = fresh.length > 0;

  // Merge prior known for seed discovery only — display uses freshness filter
  let known = fresh;
  if (previous?.allKnown?.length) {
    known = dedupePosts([
      ...known,
      ...previous.allKnown.map((p) => normalizePost(p))
    ]);
  } else if (previous?.posts?.length) {
    known = dedupePosts([...known, ...previous.posts.map((p) => normalizePost(p))]);
  }

  // Scrape miss: do NOT resurrect old specials onto the homepage
  if (!scrapeOk) {
    const empty = {
      updatedAt: nowIso(),
      scrapedAt: nowIso(),
      timezone: TZ,
      localDate: localParts().key,
      source: sources.join('+') || 'none',
      found: false,
      scrapeOk: false,
      stale: true,
      post: null,
      posts: [],
      allKnown: known.slice(0, 40),
      errors: [...errors, 'no-fresh-specials'].slice(0, 40)
    };
    await env.DATA.put('special', JSON.stringify(empty));
    return empty;
  }

  // Cache images for display set (survives Facebook CDN expiry)
  const displayDraft = selectDisplayPosts(fresh);
  const cachedDisplay = [];
  for (const p of displayDraft) {
    cachedDisplay.push(await cacheImage(env, p));
  }
  const byId = new Map(cachedDisplay.map((p) => [p.id, p]));
  known = known.map((p) => byId.get(p.id) || p);

  const payload = buildPayload({
    posts: known,
    source: sources.join('+') || 'mixed',
    errors,
    previous,
    scrapeOk: true
  });
  payload.posts = cachedDisplay.length ? cachedDisplay : payload.posts;
  payload.post = payload.posts[0] || null;
  payload.found = payload.posts.length > 0;
  payload.stale = false;

  await env.DATA.put('special', JSON.stringify(payload));
  return payload;
}

export async function getSpecialMedia(env, id) {
  const key = `special-img:${id}`;
  const obj = await env.DATA.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!obj || !obj.value) return null;
  return {
    body: obj.value,
    contentType: (obj.metadata && obj.metadata.contentType) || 'image/jpeg'
  };
}
