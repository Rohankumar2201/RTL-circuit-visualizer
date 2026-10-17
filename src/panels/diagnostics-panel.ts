import { sortDiagnostics, type Diagnostic } from '../parser/diagnostics';
import { clear, h } from '../utils/dom';

export function renderDiagnostics(el: HTMLElement, diags: Diagnostic[], onJump: (line: number, col: number) => void): void {
  clear(el);
  if (!diags.length) { el.appendChild(h('p', 'muted', 'No diagnostics.')); return; }
  const count = (s: string): number => diags.filter((d) => d.severity === s).length;
  el.appendChild(h('p', 'diag-summary', `${count('error')} error(s), ${count('warning')} warning(s), ${count('info')} note(s)`));
  const ul = h('ul', 'diag-list');
  for (const d of sortDiagnostics(diags)) {
    const li = h('li', `diag diag-${d.severity}`);
    const head = h('div', 'diag-head');
    head.append(h('span', 'badge', d.severity), h('span', 'cat', d.category));
    if (d.module) head.append(h('span', 'cat', d.module));
    li.append(head, h('div', 'diag-msg', d.message));
    if (d.line !== undefined) {
      const b = h('button', 'link', `line ${d.line}${d.col ? ':' + d.col : ''}`);
      b.type = 'button';
      b.addEventListener('click', () => onJump(d.line!, d.col ?? 1));
      li.appendChild(b);
    }
    if (d.explanation) li.appendChild(h('div', 'diag-extra', d.explanation));
    if (d.suggestion) li.appendChild(h('div', 'diag-extra', 'Suggestion: ' + d.suggestion));
    ul.appendChild(li);
  }
  el.appendChild(ul);
}
