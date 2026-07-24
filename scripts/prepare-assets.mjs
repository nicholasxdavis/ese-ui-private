/**
 * Copy only public site files into ./site for wrangler assets.directory.
 * Keeps deploys from walking node_modules / scratch / etc.
 */
import {
  cpSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync
} from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'site');

const ROOT_FILES = [
  'index.html',
  '404.html',
  'robots.txt',
  'sitemap.xml',
  'site.webmanifest'
];

const ROOT_DIRS = ['admin', 'css', 'js', 'page', 'public'];

function shouldSkipPublic(rel) {
  const n = rel.replace(/\\/g, '/');
  if (n.startsWith('unused/') || n === 'unused') return true;
  if (n.endsWith('.b64.txt')) return true;
  if (/^menu_\d+\.pdf$/i.test(n.split('/').pop() || '')) return true;
  return false;
}

function copyPublic(srcDir, destDir, prefix = '') {
  mkdirSync(destDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (shouldSkipPublic(rel)) continue;
    const from = join(srcDir, name);
    const to = join(destDir, name);
    const st = statSync(from);
    if (st.isDirectory()) copyPublic(from, to, rel);
    else cpSync(from, to);
  }
}

if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of ROOT_FILES) {
  const from = join(root, f);
  if (existsSync(from)) cpSync(from, join(out, f));
}

for (const d of ROOT_DIRS) {
  const from = join(root, d);
  if (!existsSync(from)) continue;
  if (d === 'public') copyPublic(from, join(out, 'public'));
  else cpSync(from, join(out, d), { recursive: true });
}

console.log('Prepared ./site for deploy');
