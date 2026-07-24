document.addEventListener('DOMContentLoaded', () => {
    fetch('/api/content')
        .then(res => res.json())
        .then(data => {
            if (!data) return;

            // 1. Update links
            if (data.links) {
                // Order Online links
                document.querySelectorAll('a[href*="chownow.com"]').forEach(a => {
                    a.href = data.links.chownow;
                });

                // Get Directions links
                document.querySelectorAll('a[href*="maps/dir"], a[href*="maps/search"], a[href*="google.com/maps"]').forEach(a => {
                    // Skip link redirection if it is map iframe
                    if (a.tagName.toLowerCase() === 'iframe') return;
                    a.href = data.links.maps;
                });

                // Email links
                document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
                    a.href = 'mailto:' + data.links.email;
                    if (a.textContent.includes('@')) {
                        a.textContent = data.links.email;
                    }
                });

                // Phone links
                document.querySelectorAll('a[href^="tel:"]').forEach(a => {
                    a.href = 'tel:' + data.links.phoneRaw;
                    if (a.textContent.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/)) {
                        a.textContent = data.links.phone;
                    }
                });

                // Facebook links
                document.querySelectorAll('a[href*="facebook.com"]').forEach(a => {
                    a.href = data.links.facebook;
                });
            }

            // 2. Update wording (if present)
            if (data.wording) {
                // Hero titles
                const heroTitleLine1 = document.querySelector('.hero-title span:first-child');
                const heroTitleLine2 = document.querySelector('.hero-title span:nth-child(2)');
                const heroSubtitle = document.querySelector('.hero-subtitle');

                if (heroTitleLine1 && data.wording.heroTitleLine1) heroTitleLine1.textContent = data.wording.heroTitleLine1;
                if (heroTitleLine2 && data.wording.heroTitleLine2) heroTitleLine2.textContent = data.wording.heroTitleLine2;
                if (heroSubtitle && data.wording.heroSubtitle) heroSubtitle.textContent = data.wording.heroSubtitle;

                // About heading and text (on About page)
                const aboutHeading = document.getElementById('about-heading');
                const aboutText = document.getElementById('about-text');

                if (aboutHeading && data.wording.aboutHeading) aboutHeading.textContent = data.wording.aboutHeading;
                if (aboutText && data.wording.aboutText) aboutText.textContent = data.wording.aboutText;
            }
        })
        .catch(err => console.error('Error loading content:', err));
});
