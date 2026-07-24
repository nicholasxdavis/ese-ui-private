/**
 * El Sombrero Express — site.js
 * Unified site-wide JavaScript for all public pages.
 * Handles: mobile menu, scroll-to-top button.
 */

(function () {
    'use strict';

    // ── Mobile Menu ──────────────────────────────────────────────
    var menuToggle = document.getElementById('menuToggle');
    var menuClose  = document.getElementById('menuClose');
    var mobileMenu = document.getElementById('mobileMenu');

    function openMobileMenu() {
        if (!mobileMenu) return;
        mobileMenu.classList.add('active');
        mobileMenu.setAttribute('aria-hidden', 'false');
        if (menuToggle) menuToggle.setAttribute('aria-expanded', 'true');
        document.body.style.overflow = 'hidden';
    }

    function closeMobileMenu() {
        if (!mobileMenu) return;
        mobileMenu.classList.remove('active');
        mobileMenu.setAttribute('aria-hidden', 'true');
        if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
    }

    if (menuToggle) menuToggle.addEventListener('click', openMobileMenu);
    if (menuClose)  menuClose.addEventListener('click', closeMobileMenu);

    // Close when any mobile nav link is clicked
    if (mobileMenu) {
        mobileMenu.querySelectorAll('.mobile-nav-links a').forEach(function (link) {
            link.addEventListener('click', closeMobileMenu);
        });
    }

    // Close on outside click
    document.addEventListener('click', function (e) {
        if (
            mobileMenu &&
            mobileMenu.classList.contains('active') &&
            !mobileMenu.contains(e.target) &&
            menuToggle && !menuToggle.contains(e.target)
        ) {
            closeMobileMenu();
        }
    });

    // Close on Escape key
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && mobileMenu && mobileMenu.classList.contains('active')) {
            closeMobileMenu();
        }
    });

    // ── Scroll-to-Top Button ────────────────────────────────────
    var scrollBtn = document.getElementById('scrollToTopBtn');

    if (scrollBtn) {
        var ticking = false;

        window.addEventListener('scroll', function () {
            if (!ticking) {
                window.requestAnimationFrame(function () {
                    var scrollY = window.scrollY || window.pageYOffset;
                    if (scrollY > 300) {
                        scrollBtn.classList.add('show');
                    } else {
                        scrollBtn.classList.remove('show');
                    }
                    ticking = false;
                });
                ticking = true;
            }
        }, { passive: true });

        scrollBtn.addEventListener('click', function () {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

})();
