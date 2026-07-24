/**
 * Bootstrap / refresh specials from this machine (Meta allows residential curl),
 * then POST into the live Worker so images get cached in KV.
 *
 *   node scripts/push-specials.mjs
 *   node scripts/push-specials.mjs https://el-sombrero-express.nic-58f.workers.dev
 */
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const base = (process.argv[2] || 'https://el-sombrero-express.nic-58f.workers.dev').replace(
  /\/$/,
  ''
);

const SEED = [
  'https://www.facebook.com/share/p/14YXEbC1wLB/'
];

function curlHtml(url) {
  const exe = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const r = spawnSync(
    exe,
    [
      '-sL',
      '-A',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
      '--max-time',
      '35',
      '-H',
      'Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      url
    ],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout;
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
  if (/special\s+thanks/.test(s)) return false;
  return /\bspecials?\b|special of the day|taco tuesday|menudo/.test(s);
}

function loadExtraUrls() {
  const out = [...SEED];
  const file = resolve(root, 'facebook-post-urls.txt');
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (/facebook\.com/i.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
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

const posts = [];
for (const url of loadExtraUrls()) {
  console.log('Fetching', url);
  const html = curlHtml(url);
  if (!html || html.length < 800) {
    console.log('  skip: no html');
    continue;
  }
  const title = meta(html, 'og:title') || '';
  const desc = meta(html, 'og:description') || '';
  const image = meta(html, 'og:image');
  const canonical = meta(html, 'og:url') || url;
  const caption = title && desc && title !== desc ? `${title}\n${desc}` : desc || title;
  if (!isSpecial(caption) && !isSpecial(title)) {
    console.log('  skip: not a special');
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
  console.log('  ok:', title.slice(0, 60));
}

if (!posts.length) {
  console.error('No specials found — aborting (will not wipe live data).');
  process.exit(1);
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

// Write via Worker ingest endpoint that caches images
const res = await fetch(base + '/api/specials/ingest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});
const json = await res.json();
console.log(res.status, json);
if (!res.ok || !json.success) process.exit(1);
console.log('Pushed', posts.length, 'special(s) to', base);
