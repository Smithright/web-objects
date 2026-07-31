// Publication page behavior: theme, reading progress, section tracking,
// renderer tabs, and copying the manifesto. No dependencies, no build step.

const root = document.documentElement;
const stored = localStorage.getItem('latticeborn-theme');
if (stored) root.dataset.theme = stored;

document.getElementById('themeToggle')?.addEventListener('click', () => {
  const next = root.dataset.theme === 'light' ? 'dark' : 'light';
  root.dataset.theme = next;
  localStorage.setItem('latticeborn-theme', next);
});

// --- reading progress ------------------------------------------------------

const progress = document.getElementById('readingProgress');
if (progress) {
  const update = () => {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = scrollable > 0 ? window.scrollY / scrollable : 0;
    progress.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
  };
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update);
  update();
}

// --- nav highlighting ------------------------------------------------------

const navLinks = [...document.querySelectorAll('.top-nav a')];
const targets = navLinks
  .map((link) => document.querySelector(link.getAttribute('href')))
  .filter(Boolean);

if (targets.length && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const link of navLinks) {
          link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`);
        }
      }
    },
    { rootMargin: '-45% 0px -50% 0px' },
  );
  for (const target of targets) observer.observe(target);
}

// --- renderer tabs ---------------------------------------------------------

const tabs = [...document.querySelectorAll('.renderer-tab')];
for (const tab of tabs) {
  tab.setAttribute('aria-selected', String(tab.classList.contains('active')));
  tab.addEventListener('click', () => {
    for (const other of tabs) {
      const active = other === tab;
      other.classList.toggle('active', active);
      other.setAttribute('aria-selected', String(active));
      document.getElementById(`panel-${other.dataset.panel}`)?.classList.toggle('active', active);
    }
  });
}

// --- toast + copy ----------------------------------------------------------

const toast = document.getElementById('toast');
let toastTimer = null;

export function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 1800);
}

document.getElementById('copyManifesto')?.addEventListener('click', async () => {
  const text = document.getElementById('manifestoText')?.textContent?.trim() ?? '';
  try {
    await navigator.clipboard.writeText(text);
    showToast('Manifesto copied.');
  } catch {
    // Clipboard access can be refused; selecting the text still works.
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('manifestoText'));
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    showToast('Manifesto selected — press ⌘/Ctrl+C.');
  }
});
