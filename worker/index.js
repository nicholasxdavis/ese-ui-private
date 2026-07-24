/**
 * El Sombrero Express — Cloudflare Worker
 * Static site via ASSETS + API/data via KV (DATA).
 */

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

const PDF_HEADERS = {
  'Content-Type': 'application/pdf',
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function defaultMenu() {
  return {
    meta: {
      phone: '575-323-3322',
      website: 'www.elsombreroexpress.com',
      address: '115 S. Roadrunner Parkway, Las Cruces, NM 88011',
      closedNote: '',
      partyNote: ''
    },
    categories: [],
    items: []
  };
}

function defaultCateringMenu() {
  return {
    meta: {
      phone: '575-323-3322',
      website: 'www.elsombreroexpress.com',
      address: '115 S. Roadrunner Parkway, Las Cruces, NM 88011',
      closedNote: '',
      partyNote: 'Call for custom party trays and packages.',
      printLimits: {
        maxItems: 60,
        maxDescription: 160,
        maxAddons: 80,
        maxName: 48
      },
      printLayout: {
        page1Left: ['Party Trays', 'Taco Bars', 'Packages'],
        page1Right: ['Enchilada Trays', 'Burrito Trays', 'Sides', 'Extras'],
        page2Left: [],
        page2Right: [],
        version: 1
      }
    },
    categories: [
      'Party Trays',
      'Taco Bars',
      'Enchilada Trays',
      'Burrito Trays',
      'Sides',
      'Packages',
      'Extras'
    ],
    items: []
  };
}

function normalizeMenu(raw, fallback) {
  const base = typeof fallback === 'function' ? fallback() : defaultMenu();
  if (!raw) return base;
  if (Array.isArray(raw)) {
    const categories = [...new Set(raw.map((i) => i.category).filter(Boolean))];
    return {
      ...base,
      categories: categories.length ? categories : base.categories,
      items: raw.map((i) => ({
        id: i.id,
        category: i.category || 'Other',
        name: i.name || '',
        price: i.price || '',
        price2: '',
        price2Label: '',
        description: i.description || '',
        addons: i.comboAddon || i.addons || '',
        active: i.active !== false
      }))
    };
  }
  return {
    meta: { ...base.meta, ...(raw.meta || {}) },
    categories:
      Array.isArray(raw.categories) && raw.categories.length
        ? raw.categories
        : base.categories,
    items: Array.isArray(raw.items) ? raw.items : []
  };
}

async function getJson(env, key, fallback) {
  const raw = await env.DATA.get(key);
  if (!raw) return typeof fallback === 'function' ? fallback() : fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return typeof fallback === 'function' ? fallback() : fallback;
  }
}

async function putJson(env, key, value) {
  await env.DATA.put(key, JSON.stringify(value));
}

async function pdfMeta(env, key, publicUrl, filename) {
  const meta = await env.DATA.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!meta || !meta.value) {
    return json({ exists: false, url: publicUrl, filename });
  }
  return json({
    exists: true,
    url: publicUrl,
    filename,
    size: meta.value.byteLength,
    modified: (meta.metadata && meta.metadata.modified) || null
  });
}

async function savePdf(env, request, key, publicUrl, filename) {
  let file;
  try {
    const form = await request.formData();
    file = form.get('pdf');
  } catch {
    return json({ error: 'Invalid multipart body' }, 400);
  }
  if (!file || typeof file.arrayBuffer !== 'function') {
    return json({ error: 'No PDF uploaded' }, 400);
  }
  const name = (file.name || '').toLowerCase();
  const type = file.type || '';
  if (!name.endsWith('.pdf') && type !== 'application/pdf') {
    return json({ error: 'Only PDF files are allowed' }, 400);
  }
  const buf = await file.arrayBuffer();
  if (!buf.byteLength) return json({ error: 'Empty PDF' }, 400);
  // Soft guard — KV value limit is 25 MiB
  if (buf.byteLength > 20 * 1024 * 1024) {
    return json({ error: 'PDF too large (max 20MB)' }, 400);
  }
  const modified = new Date().toISOString();
  await env.DATA.put(key, buf, {
    metadata: { modified, contentType: 'application/pdf' }
  });
  return json({
    success: true,
    message: filename + ' updated',
    url: publicUrl,
    filename
  });
}

function isMutating(method) {
  return method === 'POST' || method === 'PATCH' || method === 'DELETE' || method === 'PUT';
}

/** Optional admin gate: when ADMIN_TOKEN is set, mutating /api/* (except contact) require it. */
function adminAuthorized(request, env) {
  const token = env.ADMIN_TOKEN;
  if (!token) return true;
  const header = request.headers.get('Authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const alt = request.headers.get('X-Admin-Token') || '';
  return bearer === token || alt === token;
}

async function handleApi(request, env, pathname) {
  const method = request.method.toUpperCase();

  // Public contact form — never require admin token
  const publicWrite = pathname === '/api/contact' && method === 'POST';
  if (isMutating(method) && !publicWrite && !adminAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  if (pathname === '/api/content' && method === 'GET') {
    return json(await getJson(env, 'content', () => ({})));
  }
  if (pathname === '/api/content' && method === 'POST') {
    const body = await request.json();
    await putJson(env, 'content', body);
    return json({ success: true, message: 'Content saved successfully' });
  }

  if (pathname === '/api/menu' && method === 'GET') {
    const content = await getJson(env, 'content', () => ({}));
    return json(normalizeMenu(content.menu, defaultMenu));
  }
  if (pathname === '/api/menu' && method === 'POST') {
    const body = await request.json();
    const content = await getJson(env, 'content', () => ({}));
    content.menu = normalizeMenu(body, defaultMenu);
    await putJson(env, 'content', content);
    return json({ success: true, message: 'Menu saved successfully', menu: content.menu });
  }

  if (pathname === '/api/catering-menu' && method === 'GET') {
    const content = await getJson(env, 'content', () => ({}));
    return json(normalizeMenu(content.cateringMenu, defaultCateringMenu));
  }
  if (pathname === '/api/catering-menu' && method === 'POST') {
    const body = await request.json();
    const content = await getJson(env, 'content', () => ({}));
    content.cateringMenu = normalizeMenu(body, defaultCateringMenu);
    await putJson(env, 'content', content);
    return json({
      success: true,
      message: 'Menu saved successfully',
      menu: content.cateringMenu
    });
  }

  if (pathname === '/api/menu-pdf' && method === 'GET') {
    return pdfMeta(env, 'menu.pdf', '/public/menu.pdf', 'menu.pdf');
  }
  if (pathname === '/api/menu-pdf' && method === 'POST') {
    return savePdf(env, request, 'menu.pdf', '/public/menu.pdf', 'menu.pdf');
  }
  if (pathname === '/api/catering-menu-pdf' && method === 'GET') {
    return pdfMeta(env, 'catering.pdf', '/public/catering.pdf', 'catering.pdf');
  }
  if (pathname === '/api/catering-menu-pdf' && method === 'POST') {
    return savePdf(env, request, 'catering.pdf', '/public/catering.pdf', 'catering.pdf');
  }

  if (pathname === '/api/specials' && method === 'GET') {
    return json(await getJson(env, 'special', () => ({ posts: [] })));
  }
  if (pathname === '/api/specials' && method === 'POST') {
    const body = await request.json();
    await putJson(env, 'special', body);
    return json({ success: true, message: 'Specials saved successfully' });
  }

  if (pathname === '/api/submissions' && method === 'GET') {
    if (!adminAuthorized(request, env) && env.ADMIN_TOKEN) {
      return json({ error: 'Unauthorized' }, 401);
    }
    return json(await getJson(env, 'submissions', () => ({ submissions: [] })));
  }
  if (pathname === '/api/submissions' && method === 'POST') {
    const body = await request.json();
    await putJson(env, 'submissions', body);
    return json({ success: true, message: 'Submissions saved successfully' });
  }

  const subMatch = pathname.match(/^\/api\/submissions\/(\d+)$/);
  if (subMatch && method === 'PATCH') {
    const id = parseInt(subMatch[1], 10);
    const store = await getJson(env, 'submissions', () => ({ submissions: [] }));
    const idx = store.submissions.findIndex((s) => s.id === id);
    if (idx === -1) return json({ error: 'Submission not found' }, 404);
    const body = await request.json();
    store.submissions[idx] = { ...store.submissions[idx], ...body };
    await putJson(env, 'submissions', store);
    return json({ success: true, submission: store.submissions[idx] });
  }
  if (subMatch && method === 'DELETE') {
    const id = parseInt(subMatch[1], 10);
    const store = await getJson(env, 'submissions', () => ({ submissions: [] }));
    store.submissions = store.submissions.filter((s) => s.id !== id);
    await putJson(env, 'submissions', store);
    return json({ success: true });
  }

  if (pathname === '/api/contact' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const phone = String(body.phone || '').trim();
    const subject = String(body.subject || '').trim() || 'General Inquiry';
    const message = String(body.message || '').trim();
    if (!name || !email || !message) {
      return json({ error: 'Name, email, and message are required' }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Please enter a valid email' }, 400);
    }
    if (message.length > 5000) {
      return json({ error: 'Message is too long' }, 400);
    }
    const store = await getJson(env, 'submissions', () => ({ submissions: [] }));
    const newEntry = {
      id: Date.now(),
      name,
      email,
      phone,
      subject,
      message,
      date: new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }),
      timestamp: new Date().toISOString(),
      read: false,
      stage: 'New Inquiry',
      crmNote: ''
    };
    store.submissions.unshift(newEntry);
    // Cap store size
    if (store.submissions.length > 2000) {
      store.submissions = store.submissions.slice(0, 2000);
    }
    await putJson(env, 'submissions', store);
    return json({ success: true, message: 'Thank you! We will be in touch soon.' });
  }

  if (pathname === '/api/upload' && method === 'POST') {
    let file;
    let targetName = null;
    try {
      const form = await request.formData();
      file = form.get('image') || form.get('file');
      targetName = form.get('targetName');
    } catch {
      return json({ error: 'Invalid multipart body' }, 400);
    }
    if (!file || typeof file.arrayBuffer !== 'function') {
      return json({ error: 'No file uploaded' }, 400);
    }
    const original = file.name || 'upload.bin';
    const ext = original.includes('.')
      ? original.slice(original.lastIndexOf('.')).toLowerCase()
      : '';
    const allowed = /\.(jpe?g|png|gif|webp|svg|pdf)$/i;
    if (
      !allowed.test(ext) &&
      !(file.type || '').startsWith('image/') &&
      file.type !== 'application/pdf'
    ) {
      return json(
        { error: 'Only images (jpg, png, gif, webp, svg) and PDFs are allowed.' },
        400
      );
    }
    let filename;
    if (targetName) {
      filename = String(targetName).replace(/^.*[\\/]/, '');
    } else {
      const base = original.replace(ext, '').replace(/[^a-z0-9]/gi, '_');
      filename = `${base}_${Date.now()}${ext}`;
    }
    const buf = await file.arrayBuffer();
    if (buf.byteLength > 20 * 1024 * 1024) {
      return json({ error: 'File too large (max 20MB)' }, 400);
    }
    await env.DATA.put(`upload:${filename}`, buf, {
      metadata: { contentType: file.type || 'application/octet-stream' }
    });
    return json({
      success: true,
      message: 'File uploaded successfully',
      path: 'public/' + filename,
      filename
    });
  }

  return json({ error: 'Not found' }, 404);
}

function noStoreHtml(res) {
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  headers.set('Pragma', 'no-cache');
  headers.set('Expires', '0');
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token'
          }
        });
      }
      try {
        const res = await handleApi(request, env, pathname);
        const headers = new Headers(res.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        return new Response(res.body, { status: res.status, headers });
      } catch (err) {
        return json({ error: err.message || 'Server error' }, 500);
      }
    }

    // Live PDFs from KV (admin Generate & publish)
    if (pathname === '/public/menu.pdf' || pathname === '/public/catering.pdf') {
      const key = pathname === '/public/menu.pdf' ? 'menu.pdf' : 'catering.pdf';
      const obj = await env.DATA.get(key, { type: 'arrayBuffer' });
      if (obj) return new Response(obj, { headers: PDF_HEADERS });
    }

    // Optional KV uploads overlay static public files
    if (pathname.startsWith('/public/')) {
      const filename = decodeURIComponent(pathname.slice('/public/'.length));
      if (filename && !filename.includes('..') && !filename.includes('\\')) {
        const obj = await env.DATA.getWithMetadata(`upload:${filename}`, {
          type: 'arrayBuffer'
        });
        if (obj && obj.value) {
          const contentType =
            (obj.metadata && obj.metadata.contentType) || 'application/octet-stream';
          return new Response(obj.value, {
            headers: {
              'Content-Type': contentType,
              'Cache-Control': 'public, max-age=3600'
            }
          });
        }
      }
    }

    if (!env.ASSETS) return new Response('Not found', { status: 404 });

    const assetRes = await env.ASSETS.fetch(request);
    if (assetRes.status !== 404) {
      if (/\.html?$/i.test(pathname) || pathname === '/' || pathname.endsWith('/')) {
        return noStoreHtml(assetRes);
      }
      return assetRes;
    }

    if (!pathname.includes('.') || pathname.endsWith('/')) {
      const idx = pathname.endsWith('/') ? pathname + 'index.html' : pathname + '/index.html';
      const idxRes = await env.ASSETS.fetch(new URL(idx, url.origin));
      if (idxRes.status !== 404) return noStoreHtml(idxRes);
    }

    const notFound = await env.ASSETS.fetch(new URL('/404.html', url.origin));
    if (notFound.status !== 404) {
      return new Response(notFound.body, { status: 404, headers: notFound.headers });
    }
    return new Response('Not found', { status: 404 });
  }
};
