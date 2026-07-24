// El Sombrero Express — Customer Reviews Slider
(function () {
    const track = document.getElementById('reviewsTrack');
    const dotsContainer = document.getElementById('reviewsDots');
    if (!track || !dotsContainer) return;

    const cards = track.querySelectorAll('.review-card');
    const totalCards = cards.length;
    let cols = 4;
    let activePage = 0;
    let totalPages = 1;

    function getCols() {
        const width = window.innerWidth;
        if (width > 1024) return 4;
        if (width > 768) return 2;
        return 1;
    }

    function renderDots() {
        dotsContainer.innerHTML = '';
        for (let i = 0; i < totalPages; i++) {
            const dot = document.createElement('button');
            dot.className = 'reviews-dot' + (i === activePage ? ' active' : '');
            dot.setAttribute('aria-label', `Go to review slide page ${i + 1}`);
            dot.addEventListener('click', () => {
                goToPage(i);
            });
            dotsContainer.appendChild(dot);
        }
    }

    function updateSlider() {
        // Translate the track
        track.style.transform = `translateX(calc(-${activePage} * (100% + 1.75rem)))`;
        
        // Update dots
        const dots = dotsContainer.querySelectorAll('.reviews-dot');
        dots.forEach((dot, idx) => {
            if (idx === activePage) {
                dot.classList.add('active');
            } else {
                dot.classList.remove('active');
            }
        });
    }

    function goToPage(pageIndex) {
        if (pageIndex < 0) pageIndex = 0;
        if (pageIndex >= totalPages) pageIndex = totalPages - 1;
        activePage = pageIndex;
        updateSlider();
    }

    function initSlider() {
        const newCols = getCols();
        
        // Set CSS variable on the track element
        track.style.setProperty('--cols', newCols);
        
        // Recalculate pages
        cols = newCols;
        totalPages = Math.ceil(totalCards / cols);
        
        // Adjust active page if it's out of range
        if (activePage >= totalPages) {
            activePage = totalPages - 1;
        }
        if (activePage < 0) activePage = 0;

        renderDots();
        updateSlider();
    }

    // Window resize handler
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(initSlider, 100);
    });

    // Touch Swipe Support
    let startX = 0;
    let endX = 0;
    const threshold = 50; // min distance in px to count as swipe

    track.addEventListener('touchstart', (e) => {
        startX = e.changedTouches[0].screenX;
    }, { passive: true });

    track.addEventListener('touchend', (e) => {
        endX = e.changedTouches[0].screenX;
        handleSwipe();
    }, { passive: true });

    function handleSwipe() {
        const diff = startX - endX;
        if (Math.abs(diff) > threshold) {
            if (diff > 0) {
                // Swipe left -> Next page
                if (activePage < totalPages - 1) {
                    goToPage(activePage + 1);
                }
            } else {
                // Swipe right -> Prev page
                if (activePage > 0) {
                    goToPage(activePage - 1);
                }
            }
        }
    }

    // Initialize on load
    initSlider();
})();
