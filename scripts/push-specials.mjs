/**
 * Scrape Facebook specials via curl+OG (residential / GitHub IPs) and ingest to Worker.
 *
 *   node scripts/push-specials.mjs [workerBase]
 *
 * Never wipes live KV on failure — exits 0 if nothing new (keeps Action green).
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const base = (process.argv[2] || 'https://el-sombrero-express.nic-58f.workers.dev').replace(
  /\/$/,
  ''
);

const SEED = ['https://www.facebook.com/share/p/14YXEbC1wLB/'];

function curlHtml(url) {
  const exe = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const attempts = [
    [
      '-sL',
      '-A',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
      '--max-time',
      '35',
      '-H',
      'Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      '-H',
      'Accept-Language: en-US,en;q=0.9',
      url
    ],
    [
      '-sL',
      '-A',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      '--max-time',
      '35',
      url
    ]
  ];
  for (const args of attempts) {
    const r = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    if (r.status === 0 && r.stdout && r.stdout.length > 800 && /og:description|og:title/i.test(r.stdout)) {
      return r.stdout;
    }
  }
  return null;
}

function meta(html, prop) {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta\\s+property=["']${esc}["']\\s+content=["'](.*?)["']`, 'is'),
    new RegExp(`<meta\\s+content=["'](.*?)["']\\s+property=["']${esc}["']`, 'is')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      return m[1]
        .replace(/&amp;/g, '&')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
        .trim();
    }
  }
  return null;
}

function isSpecial(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return false;
  if (/special\s+thanks|log in or sign up|see posts, photos/.test(s)) return false;
  if (/\bspecials?\b|special of the day|taco tuesday|\bmenudo\b/.test(s)) return true;
  // Restaurant promo shape: price + call/order language
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

async function downloadImageAsBase64(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
      Accept: 'image/*,*/*'
    }
  });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > 4 * 1024 * 1024) return null;
  return { type, base64: buf.toString('base64') };
}

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

const liveUrls = await loadLiveUrls();
const targets = uniq([...SEED, ...loadFileUrls(), ...liveUrls]).slice(0, 15);
console.log('Targets:', targets.length);

const posts = [];
for (const url of targets) {
  console.log('Fetching', url);
  const html = curlHtml(url);
  if (!html) {
    console.log('  skip: no usable HTML/OG');
    continue;
  }
  const title = meta(html, 'og:title') || '';
  const desc = meta(html, 'og:description') || '';
  const image = meta(html, 'og:image');
  const canonical = meta(html, 'og:url') || url;
  const caption = title && desc && title !== desc ? `${title}\n${desc}` : desc || title;
  if (!isSpecial(caption) && !isSpecial(title)) {
    console.log('  skip: not a special —', JSON.stringify((caption || title).slice(0, 80)));
    continue;
  }
  const idMatch =
    canonical.match(/\/(\d{10,})\/?$/) ||
    canonical.match(/\/share\/p\/([A-Za-z0-9]+)/) ||
    url.match(/\/share\/p\/([A-Za-z0-9]+)/);
  const id = idMatch ? idMatch[1] : String(Date.now());
  let imagePayload = null;
  if (image) {
    console.log('  downloading image...');
    imagePayload = await downloadImageAsBase64(image);
  }
  posts.push({
    id,
    network: 'facebook',
    title: title || 'Special',
    link: canonical,
    published: new Date().toISOString(),
    captionText: caption,
    image,
    imageRemote: image,
    source: 'facebook-og-push',
    _imageBase64: imagePayload?.base64 || null,
    _imageType: imagePayload?.type || null
  });
  console.log('  ok:', (title || caption).slice(0, 60));
}

if (!posts.length) {
  console.log('No new specials scraped — leaving live KV unchanged.');
  process.exit(0);
}

const payload = {
  updatedAt: new Date().toISOString(),
  scrapedAt: new Date().toISOString(),
  timezone: 'America/Denver',
  source: 'facebook-og-push',
  found: true,
  scrapeOk: true,
  stale: false,
  post: posts[0],
  posts,
  allKnown: posts,
  errors: []
};

const res = await fetch(base + '/api/specials/ingest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});
const json = await res.json();
console.log(res.status, json.success ? 'ingest ok' : json);
if (!res.ok || !json.success) process.exit(1);
console.log('Pushed', posts.length, 'special(s) to', base);
