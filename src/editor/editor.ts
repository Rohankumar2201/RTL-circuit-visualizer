import type { Severity } from '../parser/diagnostics';
import { renderHighlight } from './syntax-highlighter';

const LINE_HEIGHT = 20;
const HIGHLIGHT_LIMIT = 60_000;

export interface EditorOptions { onChange: () => void; onRun: () => void }

export class Editor {
  readonly textarea: HTMLTextAreaElement;
  private gutter: HTMLDivElement;
  private pre: HTMLPreElement;
  private lineCount = 0;
  private markers = new Map<number, Severity>();

  constructor(mount: HTMLElement, private opts: EditorOptions) {
    mount.classList.add('ed');
    this.gutter = document.createElement('div');
    this.gutter.className = 'ed-gutter';
    this.gutter.setAttribute('aria-hidden', 'true');
    const code = document.createElement('div');
    code.className = 'ed-code';
    this.pre = document.createElement('pre');
    this.pre.className = 'ed-hl';
    this.pre.setAttribute('aria-hidden', 'true');
    this.textarea = document.createElement('textarea');
    this.textarea.className = 'ed-src';
    this.textarea.spellcheck = false;
    this.textarea.wrap = 'off';
    this.textarea.setAttribute('aria-label', 'RTL source');
    this.textarea.setAttribute('autocapitalize', 'off');
    this.textarea.setAttribute('autocorrect', 'off');
    code.append(this.pre, this.textarea);
    mount.append(this.gutter, code);

    this.textarea.addEventListener('input', () => { this.refresh(); opts.onChange(); });
    this.textarea.addEventListener('scroll', () => this.syncScroll());
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: en, value } = this.textarea;
        this.textarea.value = value.slice(0, s) + '    ' + value.slice(en);
        this.textarea.selectionStart = this.textarea.selectionEnd = s + 4;
        this.refresh();
        opts.onChange();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); opts.onRun(); }
    });
    this.refresh();
  }

  getValue(): string { return this.textarea.value; }
  setValue(v: string): void { this.textarea.value = v; this.refresh(); }
  focus(): void { this.textarea.focus(); }

  setMarkers(m: Map<number, Severity>): void { this.markers = m; this.paintMarkers(); }

  reveal(line: number, col = 1): void {
    const lines = this.textarea.value.split('\n');
    let start = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) start += lines[i].length + 1;
    const end = start + (lines[line - 1]?.length ?? 0);
    this.textarea.focus();
    this.textarea.setSelectionRange(start + Math.max(0, col - 1), end);
    this.textarea.scrollTop = Math.max(0, (line - 1) * LINE_HEIGHT - this.textarea.clientHeight / 3);
    this.syncScroll();
  }

  private refresh(): void {
    const v = this.textarea.value;
    if (v.length <= HIGHLIGHT_LIMIT) renderHighlight(this.pre, v);
    else this.pre.replaceChildren(document.createTextNode(v + '\n'));
    const n = v.split('\n').length;
    if (n !== this.lineCount) {
      this.lineCount = n;
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= n; i++) {
        const d = document.createElement('div');
        d.textContent = String(i);
        frag.appendChild(d);
      }
      this.gutter.replaceChildren(frag);
      this.paintMarkers();
    }
    this.syncScroll();
  }

  private paintMarkers(): void {
    Array.from(this.gutter.children).forEach((c, i) => {
      const sev = this.markers.get(i + 1);
      c.className = sev ? `mk-${sev}` : '';
    });
  }

  private syncScroll(): void {
    this.pre.scrollTop = this.textarea.scrollTop;
    this.pre.scrollLeft = this.textarea.scrollLeft;
    this.gutter.scrollTop = this.textarea.scrollTop;
  }
}
