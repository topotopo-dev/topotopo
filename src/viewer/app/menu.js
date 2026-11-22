// Menus share the viewport with the strips, and only one is open at a time.
import { icon } from './icons.js';
import { menuStep } from './toolbar.js';

let open;

export function openMenu(anchor, items, { onPick, place }) {
  if (open?.anchor === anchor) {
    const { close } = open;
    close();
    return close;
  }
  open?.close();

  const viewport = anchor.closest('#viewport'), doc = viewport.ownerDocument, win = doc.defaultView;
  const menu = doc.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-labelledby', anchor.id);
  const rows = items.map((item) => {
    if (item.separator) {
      const line = doc.createElement('div');
      line.className = 'menu-separator';
      line.setAttribute('role', 'separator');
      return line;
    }
    const row = doc.createElement('button');
    row.type = 'button';
    row.className = 'menu-row';
    row.tabIndex = -1;
    row.setAttribute('role', item.radio ? 'menuitemradio' : item.check ? 'menuitemcheckbox' : 'menuitem');
    if (item.radio || item.check) row.setAttribute('aria-checked', String(item.checked));
    const picture = item.checked ? icon('check') : item.icon ? icon(item.icon) : '';
    row.innerHTML = `<span class="menu-icon${item.checked ? ' checked' : ''}">${picture}</span><span>${item.label}</span><span class="menu-key">${item.key ?? ''}</span>`;
    row.onclick = () => { try { onPick(item); } finally { close(); } };
    return row;
  });
  menu.append(...rows);

  function outside(e) {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close();
  }
  function keydown(e) {
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    rows[menuStep(items, rows.indexOf(doc.activeElement), e.key)]?.focus();
  }
  function position() {
    if (!menu.offsetWidth) return close();
    const v = viewport.getBoundingClientRect(), a = anchor.getBoundingClientRect();
    const x = a.right - v.left - (place === 'beside' ? 0 : menu.offsetWidth);
    const y = (place === 'beside' ? a.top : a.bottom) - v.top;
    menu.style.left = `${Math.max(0, Math.min(x, viewport.clientWidth - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, viewport.clientHeight - menu.offsetHeight))}px`;
  }
  const observer = new ResizeObserver(position);
  function close() {
    if (open?.close !== close) return;
    open = null;
    observer.disconnect();
    doc.removeEventListener('pointerdown', outside, true);
    doc.removeEventListener('keydown', keydown);
    win.removeEventListener('blur', close);
    anchor.setAttribute('aria-expanded', 'false');
    if (menu.contains(doc.activeElement)) doc.activeElement.blur();
    anchor.blur();
    menu.remove();
  }

  open = { anchor, close };
  anchor.setAttribute('aria-expanded', 'true');
  viewport.append(menu);
  doc.addEventListener('pointerdown', outside, true);
  doc.addEventListener('keydown', keydown);
  win.addEventListener('blur', close);
  observer.observe(viewport);
  observer.observe(menu);
  position();
  const checked = items.findIndex((item) => item.radio && item.checked);
  rows[checked >= 0 ? checked : menuStep(items, -1, 'Home')]?.focus();
  return close;
}
