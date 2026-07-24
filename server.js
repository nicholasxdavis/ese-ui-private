const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3456;

// Parse JSON request bodies
app.use(express.json());

// Set up storage for image uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, 'public'));
    },
    filename: function (req, file, cb) {
        if (req.body.targetName) {
            const cleanName = path.basename(req.body.targetName);
            cb(null, cleanName);
        } else {
            const ext = path.extname(file.originalname);
            const base = path.basename(file.originalname, ext).replace(/[^a-z0-9]/gi, '_');
            cb(null, `${base}_${Date.now()}${ext}`);
        }
    }
});

const upload = multer({
    storage: storage,
    fileFilter: function (req, file, cb) {
        const allowedTypes = /jpeg|jpg|png|gif|webp|svg|pdf/;
        const ext = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mime = allowedTypes.test(file.mimetype) || file.mimetype === 'application/pdf';
        if (ext && mime) {
            return cb(null, true);
        }
        cb(new Error('Only images (jpg, png, gif, webp, svg) and PDFs are allowed.'));
    }
});

// ─────────────────────────────────────────────────────────────
// CONTENT API (site wording, links, etc.)
// ─────────────────────────────────────────────────────────────

app.get('/api/content', (req, res) => {
    const filePath = path.join(__dirname, 'content.json');
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read content file' });
        try { res.json(JSON.parse(data)); }
        catch (e) { res.status(500).json({ error: 'Failed to parse content JSON' }); }
    });
});

app.post('/api/content', (req, res) => {
    const filePath = path.join(__dirname, 'content.json');
    fs.writeFile(filePath, JSON.stringify(req.body, null, 2), 'utf8', (err) => {
        if (err) return res.status(500).json({ error: 'Failed to write content file' });
        res.json({ success: true, message: 'Content saved successfully' });
    });
});

// ─────────────────────────────────────────────────────────────
// MENU PDF — takeout + catering (same pipeline, separate files)
// ─────────────────────────────────────────────────────────────

const MENU_PDF_PATH = path.join(__dirname, 'public', 'menu.pdf');
const CATERING_PDF_PATH = path.join(__dirname, 'public', 'catering.pdf');

function registerMenuPdfRoutes(apiPath, pdfPath, publicUrl, filename) {
    app.get(apiPath, (req, res) => {
        fs.stat(pdfPath, (err, stats) => {
            if (err) {
                return res.json({ exists: false, url: publicUrl, filename });
            }
            res.json({
                exists: true,
                url: publicUrl,
                filename,
                size: stats.size,
                modified: stats.mtime.toISOString()
            });
        });
    });

    app.post(apiPath, upload.single('pdf'), (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
        const uploadedPath = req.file.path;
        const isPdf =
            path.extname(req.file.originalname).toLowerCase() === '.pdf' ||
            req.file.mimetype === 'application/pdf';

        if (!isPdf) {
            fs.unlink(uploadedPath, () => {});
            return res.status(400).json({ error: 'Only PDF files are allowed' });
        }

        const publish = () => {
            fs.copyFile(uploadedPath, pdfPath, (copyErr) => {
                fs.unlink(uploadedPath, () => {});
                if (copyErr) return res.status(500).json({ error: 'Failed to save PDF' });
                res.json({
                    success: true,
                    message: filename + ' updated',
                    url: publicUrl,
                    filename
                });
            });
        };

        fs.unlink(pdfPath, () => publish());
    });

    app.get(publicUrl, (req, res) => {
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            Pragma: 'no-cache',
            Expires: '0'
        });
        res.sendFile(pdfPath, (err) => {
            if (!err || res.headersSent) return;
            res.status(404).send(filename + ' not found');
        });
    });
}

registerMenuPdfRoutes('/api/menu-pdf', MENU_PDF_PATH, '/public/menu.pdf', 'menu.pdf');
registerMenuPdfRoutes('/api/catering-menu-pdf', CATERING_PDF_PATH, '/public/catering.pdf', 'catering.pdf');

// ─────────────────────────────────────────────────────────────
// MENU API — takeout + catering catalogs in content.json
// ─────────────────────────────────────────────────────────────

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
        categories: ['Party Trays', 'Taco Bars', 'Enchilada Trays', 'Burrito Trays', 'Sides', 'Packages', 'Extras'],
        items: []
    };
}

function normalizeMenu(raw, fallback) {
    const base = typeof fallback === 'function' ? fallback() : defaultMenu();
    if (!raw) return base;
    if (Array.isArray(raw)) {
        const categories = [...new Set(raw.map(i => i.category).filter(Boolean))];
        return {
            ...base,
            categories: categories.length ? categories : base.categories,
            items: raw.map(i => ({
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
        categories: Array.isArray(raw.categories) && raw.categories.length ? raw.categories : base.categories,
        items: Array.isArray(raw.items) ? raw.items : []
    };
}

function registerMenuDataRoutes(apiPath, contentKey, fallback) {
    app.get(apiPath, (req, res) => {
        const filePath = path.join(__dirname, 'content.json');
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) return res.status(500).json({ error: 'Failed to read menu' });
            try {
                const content = JSON.parse(data);
                res.json(normalizeMenu(content[contentKey], fallback));
            } catch (e) { res.status(500).json({ error: 'Failed to parse menu' }); }
        });
    });

    app.post(apiPath, (req, res) => {
        const filePath = path.join(__dirname, 'content.json');
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) return res.status(500).json({ error: 'Failed to read content file' });
            try {
                const content = JSON.parse(data);
                content[contentKey] = normalizeMenu(req.body, fallback);
                fs.writeFile(filePath, JSON.stringify(content, null, 2), 'utf8', (writeErr) => {
                    if (writeErr) return res.status(500).json({ error: 'Failed to save menu' });
                    res.json({ success: true, message: 'Menu saved successfully', menu: content[contentKey] });
                });
            } catch (e) { res.status(500).json({ error: 'Failed to parse content' }); }
        });
    });
}

registerMenuDataRoutes('/api/menu', 'menu', defaultMenu);
registerMenuDataRoutes('/api/catering-menu', 'cateringMenu', defaultCateringMenu);

// ─────────────────────────────────────────────────────────────
// SPECIALS API
// ─────────────────────────────────────────────────────────────

app.get('/api/specials', (req, res) => {
    const filePath = path.join(__dirname, 'special.json');
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read specials file' });
        try { res.json(JSON.parse(data)); }
        catch (e) { res.status(500).json({ error: 'Failed to parse specials JSON' }); }
    });
});

app.post('/api/specials', (req, res) => {
    const filePath = path.join(__dirname, 'special.json');
    fs.writeFile(filePath, JSON.stringify(req.body, null, 2), 'utf8', (err) => {
        if (err) return res.status(500).json({ error: 'Failed to write specials file' });
        res.json({ success: true, message: 'Specials saved successfully' });
    });
});

// ─────────────────────────────────────────────────────────────
// SUBMISSIONS / CRM API — persisted to submissions.json
// ─────────────────────────────────────────────────────────────

const SUBMISSIONS_PATH = path.join(__dirname, 'submissions.json');

function ensureSubmissionsFile() {
    if (!fs.existsSync(SUBMISSIONS_PATH)) {
        fs.writeFileSync(SUBMISSIONS_PATH, JSON.stringify({ submissions: [] }, null, 2), 'utf8');
    }
}

app.get('/api/submissions', (req, res) => {
    ensureSubmissionsFile();
    fs.readFile(SUBMISSIONS_PATH, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read submissions' });
        try { res.json(JSON.parse(data)); }
        catch (e) { res.status(500).json({ error: 'Failed to parse submissions' }); }
    });
});

app.post('/api/submissions', (req, res) => {
    ensureSubmissionsFile();
    const payload = req.body;
    fs.writeFile(SUBMISSIONS_PATH, JSON.stringify(payload, null, 2), 'utf8', (err) => {
        if (err) return res.status(500).json({ error: 'Failed to save submissions' });
        res.json({ success: true, message: 'Submissions saved successfully' });
    });
});

// Single submission update (PATCH by id)
app.patch('/api/submissions/:id', (req, res) => {
    ensureSubmissionsFile();
    fs.readFile(SUBMISSIONS_PATH, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read submissions' });
        try {
            const store = JSON.parse(data);
            const id = parseInt(req.params.id);
            const idx = store.submissions.findIndex(s => s.id === id);
            if (idx === -1) return res.status(404).json({ error: 'Submission not found' });
            store.submissions[idx] = { ...store.submissions[idx], ...req.body };
            fs.writeFile(SUBMISSIONS_PATH, JSON.stringify(store, null, 2), 'utf8', (writeErr) => {
                if (writeErr) return res.status(500).json({ error: 'Failed to update submission' });
                res.json({ success: true, submission: store.submissions[idx] });
            });
        } catch (e) { res.status(500).json({ error: 'Failed to process submission update' }); }
    });
});

// Delete a single submission
app.delete('/api/submissions/:id', (req, res) => {
    ensureSubmissionsFile();
    fs.readFile(SUBMISSIONS_PATH, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read submissions' });
        try {
            const store = JSON.parse(data);
            const id = parseInt(req.params.id);
            store.submissions = store.submissions.filter(s => s.id !== id);
            fs.writeFile(SUBMISSIONS_PATH, JSON.stringify(store, null, 2), 'utf8', (writeErr) => {
                if (writeErr) return res.status(500).json({ error: 'Failed to delete submission' });
                res.json({ success: true });
            });
        } catch (e) { res.status(500).json({ error: 'Failed to process deletion' }); }
    });
});

// New contact form submission (posted from public website)
app.post('/api/contact', (req, res) => {
    ensureSubmissionsFile();
    fs.readFile(SUBMISSIONS_PATH, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read submissions' });
        try {
            const store = JSON.parse(data);
            const { name, email, phone, subject, message } = req.body;
            const newEntry = {
                id: Date.now(),
                name: name || 'Anonymous',
                email: email || '',
                phone: phone || '',
                subject: subject || 'General Inquiry',
                message: message || '',
                date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
                timestamp: new Date().toISOString(),
                read: false,
                stage: 'New Inquiry',
                crmNote: ''
            };
            store.submissions.unshift(newEntry);
            fs.writeFile(SUBMISSIONS_PATH, JSON.stringify(store, null, 2), 'utf8', (writeErr) => {
                if (writeErr) return res.status(500).json({ error: 'Failed to save submission' });
                res.json({ success: true, message: 'Thank you! We will be in touch soon.' });
            });
        } catch (e) { res.status(500).json({ error: 'Failed to process contact form' }); }
    });
});

// ─────────────────────────────────────────────────────────────
// UPLOAD API
// ─────────────────────────────────────────────────────────────

app.post('/api/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const relativePath = 'public/' + req.file.filename;
    res.json({ success: true, message: 'File uploaded successfully', path: relativePath, filename: req.file.filename });
});

// ─────────────────────────────────────────────────────────────
// STATIC FILES
// ─────────────────────────────────────────────────────────────

// Never cache HTML — admin edits + Generate must always use the latest layout code
app.use((req, res, next) => {
    if (/\.html?$/i.test(req.path) || req.path === '/' || req.path.endsWith('/')) {
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            Pragma: 'no-cache',
            Expires: '0'
        });
    }
    next();
});

app.use(express.static(__dirname));

app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
    console.log(`Admin panel available at http://localhost:${PORT}/admin/index.html`);
});
