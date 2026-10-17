import type { HierarchyNode } from '../analysis/hierarchy';
import { clear, h } from '../utils/dom';

export function renderHierarchy(el: HTMLElement, tree: HierarchyNode | null, current: string | null, onOpen: (module: string) => void): void {
  clear(el);
  if (!tree) { el.appendChild(h('p', 'muted', 'No modules.')); return; }
  const build = (n: HierarchyNode): HTMLElement => {
    const li = h('li');
    const row = h('div', 'tree-row');
    if (n.known) {
      const b = h('button', `link${n.module === current ? ' current' : ''}`, n.module);
      b.type = 'button';
      b.addEventListener('click', () => onOpen(n.module));
      row.appendChild(b);
    } else row.appendChild(h('span', 'unknown', `${n.module} (unknown module)`));
    if (n.instance) row.append(h('span', 'muted', ` ${n.instance}`));
    if (n.recursive) row.append(h('span', 'muted', ' (recursive, not expanded)'));
    li.appendChild(row);
    if (n.children.length) { const ul = h('ul', 'tree'); n.children.forEach((c) => ul.appendChild(build(c))); li.appendChild(ul); }
    return li;
  };
  const root = h('ul', 'tree');
  root.appendChild(build(tree));
  el.appendChild(root);
  if (!tree.children.length) el.appendChild(h('p', 'muted', 'No module instances.'));
}
