import { DiagnosticBag, type Diagnostic } from './diagnostics';
import type { Token } from './types';

export const KEYWORDS = new Set([
  'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic', 'parameter', 'localparam',
  'assign', 'always', 'always_comb', 'always_ff', 'always_latch', 'initial', 'begin', 'end', 'if', 'else',
  'case', 'casez', 'casex', 'endcase', 'default', 'posedge', 'negedge', 'or', 'function', 'endfunction',
  'task', 'endtask', 'generate', 'endgenerate', 'for', 'while', 'repeat', 'forever', 'integer', 'genvar',
  'signed', 'unsigned', 'specify', 'endspecify', 'defparam', 'real', 'time', 'wait', 'fork', 'join', 'disable',
]);

const OPS3 = ['<<<', '>>>', '===', '!=='];
const OPS2 = ['~&', '~|', '~^', '^~', '&&', '||', '==', '!=', '<=', '>=', '<<', '>>', '**', '+:', '-:'];
const OPS1 = new Set('+-*/%&|^~!<>=?:;,.()[]{}@#'.split(''));
const BASED = /(?:\d[\d_]*)?'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ?_]+/y;
const DEC = /\d[\d_]*/y;
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/y;

export function tokenize(src: string): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const diags = new DiagnosticBag();
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const col = (): number => i - lineStart + 1;
  const push = (kind: Token['kind'], text: string, offset: number, c: number, l = line): void => {
    tokens.push({ kind, text, offset, line: l, col: c });
  };

  while (i < n) {
    const ch = src[i];
    if (ch === '\n') { i++; line++; lineStart = i; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f') { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      const sl = line, sc = col();
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let j = i; j < stop; j++) if (src[j] === '\n') { line++; lineStart = j + 1; }
      if (end < 0) diags.error('syntax', 'Unterminated block comment', { line: sl, col: sc });
      i = stop;
      continue;
    }
    if (ch === '`') {
      const start = i, c = col();
      while (i < n && src[i] !== '\n') i++;
      diags.info('unsupported', `Compiler directive '${src.slice(start, i).trim().split(/\s+/)[0]}' is ignored`, { line, col: c });
      continue;
    }
    if (ch === '"') {
      const start = i, c = col();
      i++;
      while (i < n && src[i] !== '"' && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      if (src[i] === '"') i++; else diags.error('syntax', 'Unterminated string literal', { line, col: c });
      push('str', src.slice(start, i), start, c);
      continue;
    }
    const start = i, c = col();
    if ((ch >= '0' && ch <= '9') || ch === "'") {
      BASED.lastIndex = i;
      const m = BASED.exec(src);
      if (m) { i += m[0].length; push('num', m[0], start, c); continue; }
      if (ch !== "'") {
        DEC.lastIndex = i;
        const d = DEC.exec(src);
        if (d) { i += d[0].length; push('num', d[0], start, c); continue; }
      }
    }
    IDENT.lastIndex = i;
    const id = IDENT.exec(src);
    if (id) {
      i += id[0].length;
      push(KEYWORDS.has(id[0]) ? 'kw' : 'id', id[0], start, c);
      continue;
    }
    const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
    if (OPS3.includes(three)) { i += 3; push('op', three, start, c); continue; }
    if (OPS2.includes(two)) { i += 2; push('op', two, start, c); continue; }
    if (OPS1.has(ch)) { i++; push('op', ch, start, c); continue; }
    diags.error('syntax', `Unexpected character '${ch}'`, { line, col: c });
    i++;
  }
  push('eof', '', n, col());
  return { tokens, diagnostics: diags.items };
}
