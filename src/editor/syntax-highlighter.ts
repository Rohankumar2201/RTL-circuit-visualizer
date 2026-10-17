import { KEYWORDS } from '../parser/lexer';

export interface Segment { text: string; cls: string | null }

const RE = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*")|(\d*'[sS]?[bBdDhHoO][0-9a-fA-FxXzZ?_]+|\b\d[\d_]*\b)|(\$[A-Za-z_]\w*)|(\b[A-Za-z_]\w*\b)/g;

export function highlight(src: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  RE.lastIndex = 0;
  for (let m = RE.exec(src); m; m = RE.exec(src)) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), cls: null });
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : m[4] ? 'sys' : KEYWORDS.has(m[5]) ? 'k' : null;
    out.push({ text: m[0], cls });
    last = m.index + m[0].length;
    if (m[0].length === 0) RE.lastIndex++;
  }
  if (last < src.length) out.push({ text: src.slice(last), cls: null });
  return out;
}

export function renderHighlight(pre: HTMLElement, src: string): void {
  const frag = document.createDocumentFragment();
  for (const s of highlight(src)) {
    if (!s.cls) { frag.appendChild(document.createTextNode(s.text)); continue; }
    const span = document.createElement('span');
    span.className = `tk-${s.cls}`;
    span.textContent = s.text;
    frag.appendChild(span);
  }
  frag.appendChild(document.createTextNode('\n'));
  pre.replaceChildren(frag);
}
