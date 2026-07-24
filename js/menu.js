const menuToggle = document.getElementById('menuToggle');
const menuClose = document.getElementById('menuClose');
const mobileMenu = document.getElementById('mobileMenu');
const mobileLinks = mobileMenu.querySelectorAll('.mobile-nav-links a');

const openMenu = () => {
    mobileMenu.classList.add('active');
    document.body.style.overflow = 'hidden';
};

const closeMenu = () => {
    mobileMenu.classList.remove('active');
    document.body.style.overflow = '';
};

menuToggle.addEventListener('click', openMenu);
menuClose.addEventListener('click', closeMenu);

// Close menu when clicking a link
mobileLinks.forEach(link => {
    link.addEventListener('click', closeMenu);
});

// Close menu when clicking outside of it
document.addEventListener('click', (event) => {
    if (mobileMenu.classList.contains('active') && !mobileMenu.contains(event.target) && !menuToggle.contains(event.target)) {
        closeMenu();
    }
});

// Scroll to top button functionality
const scrollToTopBtn = document.getElementById('scrollToTopBtn');
const heroSection = document.querySelector('.hero-section');
const specialSection = document.querySelector('.special-section');

if (scrollToTopBtn) {
    window.addEventListener('scroll', () => {
        const scrollY = window.scrollY;
        const threshold = heroSection ? heroSection.offsetHeight : 300;
        
        if (scrollY > threshold) {
            scrollToTopBtn.classList.add('show');
        } else {
            scrollToTopBtn.classList.remove('show');
        }

        if (specialSection) {
            // Determine bottom of the Special of the Day section
            const specialBottom = specialSection.offsetTop + specialSection.offsetHeight;
            if (scrollY > specialBottom) {
                scrollToTopBtn.classList.add('scrolled-past-special');
            } else {
                scrollToTopBtn.classList.remove('scrolled-past-special');
            }
        }
    });

    scrollToTopBtn.addEventListener('click', () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    });
}


