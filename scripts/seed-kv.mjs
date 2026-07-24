/**
 * Seed Cloudflare KV with site data + menu PDFs.
 *
 *   node scripts/seed-kv.mjs <namespace-id>
 */
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const nsId = process.argv[2] || process.env.KV_ID;

if (!nsId) {
  console.error('Usage: node scripts/seed-kv.mjs <kv-namespace-id>');
  process.exit(1);
}

function wrangler(args) {
  console.log('>', 'wrangler', args.join(' '));
  const r = spawnSync(
    process.execPath,
    [resolve(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), ...args],
    {
      cwd: root,
      stdio: 'inherit',
      shell: false,
      env: process.env
    }
  );
  if (r.status !== 0) process.exit(r.status || 1);
}

function putPath(key, filePath) {
  wrangler([
    'kv',
    'key',
    'put',
    key,
    '--namespace-id',
    nsId,
    '--path',
    filePath,
    '--remote'
  ]);
}

putPath('content', resolve(root, 'content.json'));
putPath('special', resolve(root, 'special.json'));

const submissionsSrc = resolve(root, 'submissions.json');
if (existsSync(submissionsSrc)) {
  putPath('submissions', submissionsSrc);
} else {
  const tmp = resolve(root, '.seed-submissions.json');
  writeFileSync(tmp, JSON.stringify({ submissions: [] }, null, 2));
  try {
    putPath('submissions', tmp);
  } finally {
    unlinkSync(tmp);
  }
}

const menuPdf = resolve(root, 'public', 'menu.pdf');
const cateringPdf = resolve(root, 'public', 'catering.pdf');
if (existsSync(menuPdf)) putPath('menu.pdf', menuPdf);
else console.warn('Skipping menu.pdf — file missing');
if (existsSync(cateringPdf)) putPath('catering.pdf', cateringPdf);
else console.warn('Skipping catering.pdf — file missing');

console.log('KV seed complete.');
