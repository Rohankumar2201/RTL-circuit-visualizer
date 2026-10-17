/** Safe element construction: text is always assigned through textContent. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function clear(el: Element): void { while (el.firstChild) el.removeChild(el.firstChild); }

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
