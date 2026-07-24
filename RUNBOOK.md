# El Sombrero Express — Agent Runbook

This is the operating manual for coding agents working on this project.
Read it before changing, deploying, or debugging anything.

## What this project is

Static restaurant website + admin panel for **El Sombrero Express** (Las Cruces, NM).

| Piece | Role |
|-------|------|
| HTML/CSS/JS in repo root | Public site (`index.html`, `page/`, `css/`, `js/`, `public/`) |
| `admin/index.html` | Menu catalog editor + PDF generate/publish + contact submissions |
| `worker/index.js` | **Production backend** (Cloudflare Worker) |
| `server.js` | **Local-only** Express mirror (optional; not used in production) |
| KV namespace `EL_SOMBRERO_DATA` | Live content, menus, submissions, published PDFs |

Production is **Cloudflare Workers + static assets + KV**. Do not assume Express/`localhost:3456` for live changes.

---

## Canonical URLs & IDs

| Item | Value |
|------|-------|
| Live site | https://el-sombrero-express.nic-58f.workers.dev |
| Admin | https://el-sombrero-express.nic-58f.workers.dev/admin/index.html |
| GitHub repo | https://github.com/nicholasxdavis/el-sombrero-express (private) |
| Cloudflare account | `Nic@blacnova.net's Account` (`58fc4587a33bb19f74e7250bde60023c`) |
| Worker name | `el-sombrero-express` |
| KV binding | `DATA` |
| KV namespace title | `EL_SOMBRERO_DATA` |
| KV namespace id | `0df6e94205c146ad84a2448345417efa` |
| Client domain (future) | `elsombreroexpress.com` / `www.elsombreroexpress.com` |

Custom domain may not be attached yet. Prefer the `workers.dev` URL until DNS is wired in the Cloudflare dashboard (Workers → el-sombrero-express → Domains / Triggers).

---

## Auth you already have

Agents typically already have:

- `gh` logged in as `nicholasxdavis`
- `wrangler` / `npx wrangler` logged in as `nic@blacnova.net`

Verify before deploy:

```bash
gh auth status
npx wrangler whoami
```

If wrangler is missing scopes or auth is stale: `npx wrangler login`.

---

## Repo layout (what to touch)

```
worker/index.js          # Production API + PDF/upload routing
wrangler.jsonc           # Worker name, assets (./site), KV binding
site/                    # Generated deploy assets (gitignored) — from prepare-assets
scripts/prepare-assets.mjs
.assetsignore            # Legacy; prepare-assets is the real filter now
content.json             # Source of truth for menus/content (also seeded to KV)
special.json             # Special-of-the-day (also seeded to KV as key "special")
submissions.json         # Local/dev only; production submissions live in KV
public/menu.pdf          # Bundled fallback; live PDF is KV key "menu.pdf"
public/catering.pdf      # Bundled fallback; live PDF is KV key "catering.pdf"
admin/index.html         # Admin UI (Alpine) — posts to /api/*
js/special.js            # Homepage specials — MUST use /api/specials (not special.json)
scripts/seed-kv.mjs      # Push local JSON/PDFs into remote KV
scripts/smoke-prod.mjs   # Production health checks
RUNBOOK.md               # This file — required reading for agents
server.js                # Local Express only
```

---

## Data model (KV)

All production writes go to KV binding `DATA`:

| Key | Contents |
|-----|----------|
| `content` | Full `content.json` (includes `menu`, `cateringMenu`, `links`, wording) |
| `special` | Special-of-the-day JSON |
| `submissions` | `{ submissions: [...] }` contact/CRM entries |
| `menu.pdf` | Binary takeout menu PDF (admin publish) |
| `catering.pdf` | Binary catering menu PDF (admin publish) |
| `upload:<filename>` | Optional files from `/api/upload` |

**Important:** Editing `content.json` / `special.json` in git does **not** update production by itself. After changing those files you must either:

1. Re-seed KV (`npm run seed -- <KV_ID>`), or  
2. Save via the admin UI / API (writes KV directly), or  
3. Rely on the GitHub Action that syncs `special` after scrape.

Static HTML/CSS/JS **do** update on `wrangler deploy` only.

---

## API surface (Worker)

Same paths as local Express:

| Method | Path | Notes |
|--------|------|-------|
| GET/POST | `/api/content` | Site links/wording + full content blob |
| GET/POST | `/api/menu` | Takeout catalog (`content.menu`) |
| GET/POST | `/api/catering-menu` | Catering catalog (`content.cateringMenu`) |
| GET/POST | `/api/menu-pdf` | Meta / multipart field `pdf` publish |
| GET/POST | `/api/catering-menu-pdf` | Same for catering |
| GET/POST | `/api/specials` | Special of the day |
| GET/POST | `/api/submissions` | CRM store |
| PATCH/DELETE | `/api/submissions/:id` | Single submission |
| POST | `/api/contact` | Public contact form |
| POST | `/api/upload` | Multipart `image` or `file` |

PDFs are served at `/public/menu.pdf` and `/public/catering.pdf` from KV first, then static assets.

Optional secret `ADMIN_TOKEN`: if set on the Worker, mutating `/api/*` (except `POST /api/contact`) and reading submissions require `Authorization: Bearer <token>` or `X-Admin-Token: <token>`. Leave unset unless admin UI is updated to send it.

---

## Standard workflow (when the user asks you to work on things)

### 1. Make the change in the repo

- Prefer matching existing patterns (Mali font, clean About/Contact pages, PDF menus via admin).
- Public menus are **PDFs**, not HTML item cards.
- Nav Menu/Catering open `public/menu.pdf` / `public/catering.pdf` in a new tab.
- Cursor rule `.cursor/rules/el-sombrero-runbook.mdc` points agents here — keep this file accurate.

### 2. Decide what must be updated in production

| Change type | Action |
|-------------|--------|
| HTML / CSS / JS / images / admin UI | `npm run deploy` (prepare `site/` + wrangler deploy) |
| Menu catalog / content copy in KV | Admin save **or** edit `content.json` + `npm run seed -- 0df6e94205c146ad84a2448345417efa` |
| Published menu PDF | Admin **Generate & publish** (writes KV) — redeploy not required |
| `special.json` scrape | Commit file + ensure GH Action / manual KV put for key `special` |
| Worker API logic | Edit `worker/index.js` + deploy |
| Wrangler bindings | Edit `wrangler.jsonc` + deploy |

`npm run deploy` runs `scripts/prepare-assets.mjs` first (copies only public files into `./site`). Do not point `assets.directory` back at repo root — that scans `node_modules`.

### 3. Deploy Worker + assets

From repo root (PowerShell-safe):

```bash
npm run deploy
```

Equivalent:

```bash
npx wrangler deploy
```

Confirm output shows: `https://el-sombrero-express.nic-58f.workers.dev`

### 4. Seed / refresh KV when needed

```bash
npm run seed -- 0df6e94205c146ad84a2448345417efa
```

Uses `scripts/seed-kv.mjs` (spawn without shell so Windows paths with spaces work).

Seeds: `content`, `special`, `submissions`, `menu.pdf`, `catering.pdf`.

### 5. Smoke-test production

```bash
npm run smoke
```

Or:

```bash
node scripts/smoke-prod.mjs https://el-sombrero-express.nic-58f.workers.dev
```

Must pass: home, content API, menu API, specials API, both PDFs, about image, contact POST, admin HTML.

### 6. Commit & push to GitHub

Only when the user asks for a commit/push, or when finishing a deploy task they requested end-to-end.

```bash
git status
git add -A
git commit -m "Short why-focused message."
git push origin master
```

On Windows PowerShell do **not** use bash heredocs; use a normal `-m "message"` string.

Repo default branch: **`master`**.

Create PRs with `gh pr create` only if the user wants a PR workflow; this project usually pushes to `master`.

---

## Local development

**Option A — Cloudflare local (preferred for prod parity):**

```bash
npm run dev
```

Uses wrangler + local KV simulation. Seed local KV separately if needed (`wrangler kv key put ... --local`).

**Option B — Express (legacy):**

```bash
npm run serve
```

Serves on `http://localhost:3456` and reads/writes local JSON files + `public/*.pdf`. Fine for UI work; **not** what production runs.

---

## Admin PDF pipeline (do not break)

1. Admin edits catalog → `POST /api/menu` or `/api/catering-menu` (KV `content`).
2. Generate uses html2canvas + jsPDF in the browser.
3. Publish uploads multipart to `/api/menu-pdf` or `/api/catering-menu-pdf` → KV binary.
4. Takeout layout is versioned in admin; Quesadillas belong on page 2 — do not regress that.
5. Catering QR on takeout PDF points at production catering URL (`https://www.elsombreroexpress.com/public/catering.pdf`). Do not bake `localhost` into PDFs.

---

## GitHub Actions

Workflow: `.github/workflows/update-special.yml`

- Cron every 4 hours + `workflow_dispatch`
- Runs `scripts/update_special.py` → may commit `special.json`
- If secret `CLOUDFLARE_API_TOKEN` exists, syncs `special.json` to KV key `special`

Without that secret, scraped specials update git only — homepage still reads KV via `/api/specials`, so **manually seed** after scrape if Action cannot write KV.

---

## Common tasks cheat sheet

### “Fix the homepage / about / contact UI”

1. Edit the HTML/CSS.
2. `npm run deploy`
3. `npm run smoke`
4. Commit/push if asked.

### “Update menu items / prices”

1. Prefer admin on live site, **or** edit `content.json` then seed KV.
2. If they need a new PDF: open admin → Generate & publish.
3. No deploy needed for catalog/PDF-only KV updates.

### “API bug in production”

1. Fix `worker/index.js` (keep `server.js` in sync if the change applies locally).
2. `npm run deploy`
3. Smoke + spot-check the failing route with `curl` / `Invoke-RestMethod`.

### “Add a new static image”

1. Put it under `public/` (or `public/collage/` for gallery/about).
2. Ensure it is **not** listed in `.assetsignore`.
3. Commit the binary + deploy.

### “Wire custom domain”

1. Cloudflare Dashboard → Workers → `el-sombrero-express` → add `elsombreroexpress.com` / `www`.
2. Point DNS as instructed.
3. Update any hardcoded production URLs (admin catering QR already uses www domain).

### “Create / reset KV”

```bash
npx wrangler kv namespace list
npx wrangler kv namespace create EL_SOMBRERO_DATA
# put new id into wrangler.jsonc kv_namespaces[0].id
npm run seed -- <new-id>
npm run deploy
```

---

## Hard rules for agents

1. **Production backend is the Worker + KV**, not `server.js`.
2. After frontend or worker changes: **deploy**, don’t stop at local files.
3. After `content.json` / PDF / specials source changes intended for live: **seed KV or publish via admin**.
4. Never commit secrets (`.dev.vars`, API tokens). Use `wrangler secret put` for Worker secrets.
5. Never force-push `master` unless the user explicitly asks.
6. Don’t enable `ADMIN_TOKEN` until admin UI sends it — it will lock writes.
7. Don’t exclude `public/collage/` from deploy — about + homepage gallery need those images.
8. Homepage specials must call **`/api/specials`**, never static `/special.json` (that file is not an asset).
9. Keep `.assetsignore` excluding `node_modules`, `scratch`, source JSON, and `worker/` source — but not the public site files.
10. Windows paths contain spaces (`El Sombrero Express Website`) — prefer `spawn`/Node scripts over unquoted shell paths.

---

## Quick health commands (PowerShell)

```powershell
$base = "https://el-sombrero-express.nic-58f.workers.dev"
Invoke-RestMethod "$base/api/menu" | Select-Object -ExpandProperty items | Measure-Object
Invoke-WebRequest "$base/public/menu.pdf" -UseBasicParsing | Select-Object StatusCode, Headers
Invoke-RestMethod "$base/api/specials" | Select-Object updatedAt, found
npm run smoke
```

---

## When something is wrong

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Site HTML old | Forgot deploy | `npm run deploy` |
| Menu items old but PDF new | KV `content` stale | Admin save or seed `content` |
| PDF old | KV PDF not published | Admin Generate & publish |
| Specials always fallback | `/api/specials` empty/fail or JS still pointing at `special.json` | Seed `special`; confirm `js/special.js` uses API |
| About images 404 | Collage missing from assets | Ensure files exist under `public/collage/` and are not in `.assetsignore` |
| Contact form fails | Worker/API error | `wrangler tail`; check POST `/api/contact` |
| Admin save 401 | `ADMIN_TOKEN` set without UI support | Remove secret or wire token into admin fetches |
| Deploy scans thousands of files | `.assetsignore` broken | Restore ignore for `node_modules/` etc. |

Live logs:

```bash
npx wrangler tail el-sombrero-express
```

---

## Definition of done (production change)

A task is done when:

1. Code is updated in the repo  
2. Worker/assets deployed **or** KV seeded/published as appropriate  
3. `npm run smoke` passes  
4. The specific user-facing path was manually verified  
5. Changes are committed/pushed if the user wanted that saved on GitHub  
