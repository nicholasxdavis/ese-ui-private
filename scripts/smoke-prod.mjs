/**
 * Production smoke test against the live Worker.
 *   node scripts/smoke-prod.mjs [baseUrl]
 */
const base = (process.argv[2] || 'https://el-sombrero-express.nic-58f.workers.dev').replace(
  /\/$/,
  ''
);

async function check(name, fn) {
  try {
    await fn();
    console.log('OK  ', name);
    return true;
  } catch (err) {
    console.error('FAIL', name, '-', err.message);
    return false;
  }
}

async function mustOk(path, opts) {
  const res = await fetch(base + path, opts);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res;
}

const results = [];

results.push(
  await check('GET /', async () => {
    await mustOk('/');
  })
);

results.push(
  await check('GET /api/content', async () => {
    const data = await (await mustOk('/api/content')).json();
    if (!data.links || !data.links.phone) throw new Error('missing links.phone');
  })
);

results.push(
  await check('GET /api/menu', async () => {
    const data = await (await mustOk('/api/menu')).json();
    if (!Array.isArray(data.items) || data.items.length < 1) throw new Error('no menu items');
  })
);

results.push(
  await check('GET /api/catering-menu', async () => {
    await mustOk('/api/catering-menu');
  })
);

results.push(
  await check('GET /api/specials', async () => {
    await mustOk('/api/specials');
  })
);

results.push(
  await check('GET /public/menu.pdf', async () => {
    const res = await mustOk('/public/menu.pdf');
    const type = res.headers.get('content-type') || '';
    if (!type.includes('pdf')) throw new Error('not pdf: ' + type);
  })
);

results.push(
  await check('GET /public/catering.pdf', async () => {
    const res = await mustOk('/public/catering.pdf');
    const type = res.headers.get('content-type') || '';
    if (!type.includes('pdf')) throw new Error('not pdf: ' + type);
  })
);

results.push(
  await check('GET about image', async () => {
    await mustOk('/public/collage/about-us.webp');
  })
);

results.push(
  await check('GET /page/contact/', async () => {
    await mustOk('/page/contact/');
  })
);

results.push(
  await check('GET /admin/', async () => {
    await mustOk('/admin/');
  })
);

results.push(
  await check('POST /api/contact', async () => {
    const res = await fetch(base + '/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Smoke Test',
        email: 'smoke@example.com',
        message: 'Automated production smoke test'
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(JSON.stringify(data));
  })
);

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
