// Optional: a Copy button on each command block. The page works the same without it.
document.querySelectorAll('pre[data-copy]').forEach((pre) => {
  if (!navigator.clipboard) return;
  const box = document.createElement('div');
  box.className = 'copyable';
  pre.replaceWith(box);
  box.append(pre);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', 'Copy the command');
  const status = document.createElement('span');
  status.className = 'visually-hidden';
  status.setAttribute('role', 'status');
  box.append(button, status);
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent.trim());
      button.textContent = 'Copied';
      status.textContent = 'Copied to the clipboard';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
      status.textContent = '';
    }, 2000);
  });
});

// Optional: on the front page, the top bar's name appears once the hero's logo has scrolled away. Without
// this, the name always shows, as it does on every other page.
const heroLogo = document.querySelector('.hero .logo');
if (heroLogo && 'IntersectionObserver' in window) {
  const root = document.documentElement;
  const box = heroLogo.getBoundingClientRect();
  root.classList.toggle('hero-in', box.bottom > 0 && box.top < window.innerHeight);
  new IntersectionObserver(([entry]) => root.classList.toggle('hero-in', entry.isIntersecting)).observe(heroLogo);
}

// Optional: the narrow screen's menu closes when a link in it is chosen, or a tap lands outside it.
document.querySelectorAll('details.menu').forEach((menu) => {
  menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => menu.removeAttribute('open')));
  document.addEventListener('click', (event) => {
    if (menu.open && !menu.contains(event.target)) menu.removeAttribute('open');
  });
});
