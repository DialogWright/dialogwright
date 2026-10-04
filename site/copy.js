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
