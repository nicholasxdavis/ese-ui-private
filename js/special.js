// Special of the Day — reads special.json (git-scraped from Facebook)
(function () {
    const KEYWORDS = ['special of the day', 'specials', 'special'];
    const statusEl = document.getElementById('specialStatus');
    const captionEl = document.getElementById('specialCaption');
    const ctaEl = document.getElementById('specialCta');
    const listEl = document.getElementById('specialList');
    const updatedEl = document.getElementById('specialUpdated');

    function hasKeyword(text) {
        if (!text) return false;
        const s = String(text).toLowerCase();
        return KEYWORDS.some((k) => s.includes(k));
    }

    function formatCaption(post) {
        let c = String(post.captionText || post.title || '').trim();
        c = c.replace(/^El Sombrero Express\s*\n+/i, '');
        c = c
            .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2934}\u{2935}\u{25AA}\u{25AB}\u{25FE}\u{25FD}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
            .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
            .replace(/[—–]/g, '-')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        return c;
    }

    function formatUpdated(iso) {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return String(iso);
            return d.toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
            });
        } catch (e) {
            return String(iso);
        }
    }

    function setUpdated(iso) {
        if (!updatedEl) return;
        const label = formatUpdated(iso);
        if (!label) {
            updatedEl.hidden = true;
            updatedEl.textContent = '';
            return;
        }
        updatedEl.textContent = 'Last updated: ' + label;
        updatedEl.hidden = false;
    }

    function setCopy(post) {
        const caption = formatCaption(post);
        if (captionEl) {
            if (caption) {
                captionEl.textContent = caption;
                captionEl.hidden = false;
            } else {
                captionEl.textContent = '';
                captionEl.hidden = true;
            }
        }
        if (ctaEl) {
            if (post.link) {
                ctaEl.href = post.link;
                ctaEl.hidden = false;
            } else {
                ctaEl.removeAttribute('href');
                ctaEl.hidden = true;
            }
        }
        if (statusEl) statusEl.hidden = true;
    }

    function renderPosts(posts) {
        listEl.innerHTML = '';
        const primary = posts[0];
        if (primary) setCopy(primary);

        posts.forEach((post) => {
            if (!post.image) return;

            // Outer wrapper: holds drop-shadow + wavy clip (same as map card)
            const wrap = document.createElement('div');
            wrap.className = 'special-card-wrap';

            // Inline SVG clipPath (objectBoundingBox so it scales at any size)
            wrap.insertAdjacentHTML('afterbegin', `
                <svg style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">
                    <defs>
                        <clipPath id="specialWaveClip-${post.image.slice(-8).replace(/[^a-z0-9]/gi,'_')}" clipPathUnits="objectBoundingBox">
                            <path d="
                                M 0.03,0.07
                                C 0.16,0.03 0.28,0.09 0.41,0.05
                                C 0.53,0.01 0.66,0.07 0.78,0.04
                                C 0.88,0.02 0.94,0.06 0.97,0.07
                                L 0.97,0.93
                                C 0.84,0.97 0.72,0.91 0.59,0.95
                                C 0.47,0.99 0.34,0.93 0.22,0.97
                                C 0.14,0.98 0.08,0.94 0.03,0.93
                                Z
                            "/>
                        </clipPath>
                    </defs>
                </svg>
            `);

            const card = document.createElement(post.link ? 'a' : 'div');
            card.className = 'special-card';
            const clipId = `specialWaveClip-${post.image.slice(-8).replace(/[^a-z0-9]/gi,'_')}`;
            card.style.clipPath = `url(#${clipId})`;
            if (post.link) {
                card.href = post.link;
                card.target = '_blank';
                card.rel = 'noopener noreferrer';
            }

            const media = document.createElement('div');
            media.className = 'special-card-media';
            const img = document.createElement('img');
            img.src = post.image;
            img.alt = formatCaption(post).split('\n')[0] || 'Special of the day';
            img.loading = 'lazy';
            img.onerror = () => { wrap.remove(); };
            media.appendChild(img);
            card.appendChild(media);
            wrap.appendChild(card);

            // Add the Today's Special wavy label
            const label = document.createElement('div');
            label.className = 'special-card-label';
            label.innerHTML = `
                <svg viewBox="0 0 220 76" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path fill="#e8722e" d="M6,16 C28,11 48,18 72,13 C96,8 120,17 146,12 C172,7 198,16 214,13 L214,60 C192,65 166,58 140,63 C114,68 88,59 62,64 C36,69 18,60 6,58 Z"/>
                </svg>
                <span>Today's Special</span>
            `;
            wrap.appendChild(label);

            listEl.appendChild(wrap);
        });
        listEl.hidden = false;
    }

    const FALLBACK_SPECIAL = {
        title: 'Menudo',
        captionText:
            'Menudo Special!\n' +
            'Classic house menudo with onion, oregano & lime\n' +
            'Call 323-3322 to order\n' +
            'Pick up 115 Roadrunner Pkwy\n' +
            'Hot & ready - while it lasts',
        image: 'public/collage/plate-pozole.png',
        link: 'https://www.facebook.com/elsombreroexpress/',
    };

    function renderFallback(updatedAt) {
        renderPosts([FALLBACK_SPECIAL]);
        setUpdated(updatedAt || new Date().toISOString());
    }

    fetch('special.json?t=' + Date.now(), { cache: 'no-store' })
        .then((r) => {
            if (!r.ok) throw new Error('special.json HTTP ' + r.status);
            return r.json();
        })
        .then((data) => {
            let posts = Array.isArray(data.posts) && data.posts.length
                ? data.posts
                : (data.post ? [data.post] : []);
            posts = posts.filter((p) => hasKeyword(p.captionText || p.title));
            if (!posts.length) {
                renderFallback(data.updatedAt);
                return;
            }
            renderPosts(posts);
            setUpdated(data.updatedAt);
        })
        .catch(() => {
            renderFallback();
        });
})();
