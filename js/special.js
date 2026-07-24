// Special of the Day — KV-backed /api/specials with multi-special carousel
(function () {
    const statusEl = document.getElementById('specialStatus');
    const captionEl = document.getElementById('specialCaption');
    const ctaEl = document.getElementById('specialCta');
    const listEl = document.getElementById('specialList');
    const updatedEl = document.getElementById('specialUpdated');
    const wrapEl = document.querySelector('.special-list-wrap');

    let posts = [];
    let index = 0;

    function formatCaption(post) {
        let c = String(post.captionText || post.title || '').trim();
        c = c.replace(/^El Sombrero Express\s*\n+/i, '');
        c = c
            .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
            .replace(
                /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2934}\u{2935}\u{25AA}\u{25AB}\u{25FE}\u{25FD}\u{FE0F}\u{200D}\u{20E3}]/gu,
                ''
            )
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
                timeStyle: 'short'
            });
        } catch (e) {
            return String(iso);
        }
    }

    function setUpdated(iso, meta) {
        if (!updatedEl) return;
        const label = formatUpdated(iso);
        if (!label) {
            updatedEl.hidden = true;
            updatedEl.textContent = '';
            return;
        }
        let text = 'Last updated: ' + label;
        if (meta && meta.stale) text += ' (showing latest available)';
        if (posts.length > 1) text += ' · ' + (index + 1) + ' of ' + posts.length;
        updatedEl.textContent = text;
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

    function waveClipId(seed) {
        return 'specialWaveClip-' + String(seed || 'x').replace(/[^a-z0-9]/gi, '').slice(-10);
    }

    function buildCard(post, clipId) {
        const wrap = document.createElement('div');
        wrap.className = 'special-card-wrap';

        wrap.insertAdjacentHTML(
            'afterbegin',
            `
            <svg style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">
                <defs>
                    <clipPath id="${clipId}" clipPathUnits="objectBoundingBox">
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
        `
        );

        const card = document.createElement(post.link ? 'a' : 'div');
        card.className = 'special-card';
        card.style.clipPath = `url(#${clipId})`;
        if (post.link) {
            card.href = post.link;
            card.target = '_blank';
            card.rel = 'noopener noreferrer';
        }

        const media = document.createElement('div');
        media.className = 'special-card-media';
        if (post.image) {
            const img = document.createElement('img');
            img.src = post.image;
            img.alt = formatCaption(post).split('\n')[0] || "Today's special";
            img.loading = 'eager';
            img.decoding = 'async';
            img.onerror = () => {
                if (post.imageRemote && img.src !== post.imageRemote) {
                    img.src = post.imageRemote;
                }
            };
            media.appendChild(img);
        }
        card.appendChild(media);
        wrap.appendChild(card);

        const label = document.createElement('div');
        label.className = 'special-card-label';
        label.innerHTML = `
            <svg viewBox="0 0 220 76" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path fill="#e8722e" d="M6,16 C28,11 48,18 72,13 C96,8 120,17 146,12 C172,7 198,16 214,13 L214,60 C192,65 166,58 140,63 C114,68 88,59 62,64 C36,69 18,60 6,58 Z"/>
            </svg>
            <span>Today's Special</span>
        `;
        wrap.appendChild(label);
        return wrap;
    }

    function ensureNav() {
        if (!wrapEl || wrapEl.querySelector('.special-nav')) return;
        wrapEl.classList.add('special-list-wrap--carousel');

        const prev = document.createElement('button');
        prev.type = 'button';
        prev.className = 'special-nav special-nav--prev';
        prev.setAttribute('aria-label', 'Previous special');
        prev.innerHTML =
            '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M15.4 7.4 10.8 12l4.6 4.6L14 18l-6-6 6-6z"/></svg>';

        const next = document.createElement('button');
        next.type = 'button';
        next.className = 'special-nav special-nav--next';
        next.setAttribute('aria-label', 'Next special');
        next.innerHTML =
            '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="m10 6 6 6-6 6-1.4-1.4 4.6-4.6-4.6-4.6z"/></svg>';

        const dots = document.createElement('div');
        dots.className = 'special-dots';
        dots.setAttribute('role', 'tablist');
        dots.setAttribute('aria-label', 'Specials');

        prev.addEventListener('click', () => go(index - 1));
        next.addEventListener('click', () => go(index + 1));

        wrapEl.insertBefore(prev, listEl);
        wrapEl.appendChild(next);
        wrapEl.appendChild(dots);
    }

    function syncNav() {
        if (!wrapEl) return;
        const multi = posts.length > 1;
        wrapEl.classList.toggle('has-multiple', multi);
        const prev = wrapEl.querySelector('.special-nav--prev');
        const next = wrapEl.querySelector('.special-nav--next');
        const dots = wrapEl.querySelector('.special-dots');
        if (prev) prev.hidden = !multi;
        if (next) next.hidden = !multi;
        if (!dots) return;
        dots.hidden = !multi;
        dots.innerHTML = '';
        if (!multi) return;
        posts.forEach((_, i) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'special-dot' + (i === index ? ' is-active' : '');
            b.setAttribute('aria-label', 'Special ' + (i + 1));
            b.setAttribute('aria-selected', i === index ? 'true' : 'false');
            b.addEventListener('click', () => go(i));
            dots.appendChild(b);
        });
    }

    function renderCurrent(meta) {
        if (!listEl) return;
        listEl.innerHTML = '';
        const post = posts[index];
        if (!post) return;
        setCopy(post);
        setUpdated(meta && meta.updatedAt, meta);
        const clipId = waveClipId(post.id || post.image || index);
        listEl.appendChild(buildCard(post, clipId));
        listEl.hidden = false;
        syncNav();
    }

    function go(nextIndex) {
        if (!posts.length) return;
        index = ((nextIndex % posts.length) + posts.length) % posts.length;
        renderCurrent(window.__specialMeta || {});
    }

    const FALLBACK_SPECIAL = {
        id: 'fallback-menudo',
        title: 'Menudo',
        captionText:
            'Menudo Special!\n' +
            'Classic house menudo with onion, oregano & lime\n' +
            'Call 323-3322 to order\n' +
            'Pick up 115 Roadrunner Pkwy\n' +
            'Hot & ready - while it lasts',
        image: 'public/collage/plate-pozole.png',
        link: 'https://www.facebook.com/elsombreroexpress/'
    };

    function showPosts(list, meta) {
        posts = Array.isArray(list) ? list.filter(Boolean) : [];
        index = 0;
        window.__specialMeta = meta || {};
        if (!posts.length) {
            posts = [FALLBACK_SPECIAL];
        }
        if (posts.length > 1) ensureNav();
        renderCurrent(meta || {});
    }

    // Keyboard support when section focused
    if (wrapEl) {
        wrapEl.addEventListener('keydown', (e) => {
            if (posts.length < 2) return;
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                go(index - 1);
            }
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                go(index + 1);
            }
        });
        // Light swipe on the card area
        let touchX = null;
        wrapEl.addEventListener(
            'touchstart',
            (e) => {
                touchX = e.changedTouches[0].clientX;
            },
            { passive: true }
        );
        wrapEl.addEventListener(
            'touchend',
            (e) => {
                if (touchX == null || posts.length < 2) return;
                const dx = e.changedTouches[0].clientX - touchX;
                touchX = null;
                if (Math.abs(dx) < 40) return;
                go(dx < 0 ? index + 1 : index - 1);
            },
            { passive: true }
        );
    }

    fetch('/api/specials?t=' + Date.now(), { cache: 'no-store' })
        .then((r) => {
            if (!r.ok) throw new Error('specials HTTP ' + r.status);
            return r.json();
        })
        .then((data) => {
            let list =
                Array.isArray(data.posts) && data.posts.length
                    ? data.posts
                    : data.post
                      ? [data.post]
                      : [];
            // Trust server selection; only drop empty captions without images
            list = list.filter((p) => p && (p.captionText || p.title || p.image));
            showPosts(list, data);
        })
        .catch(() => {
            showPosts([FALLBACK_SPECIAL], { updatedAt: new Date().toISOString(), stale: true });
        });
})();
