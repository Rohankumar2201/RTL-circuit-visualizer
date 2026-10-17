import { DiagnosticBag, type Diagnostic } from './diagnostics';
import { tokenize } from './lexer';
import type { Expr, Loc, Token } from './types';

export class ParseError extends Error {
  constructor(message: string, readonly tok: Token, readonly unsupported = false, readonly suggestion?: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export const locOf = (t: Loc): Loc => ({ line: t.line, col: t.col });
export const describeToken = (t: Token): string => (t.kind === 'eof' ? 'end of input' : `'${t.text}'`);

export class TokenStream {
  pos = 0;
  constructor(readonly tokens: Token[]) {}
  peek(o = 0): Token { return this.tokens[Math.min(this.pos + o, this.tokens.length - 1)]; }
  next(): Token { const t = this.peek(); if (t.kind !== 'eof') this.pos++; return t; }
  at(text: string, o = 0): boolean { const t = this.peek(o); return (t.kind === 'op' || t.kind === 'kw') && t.text === text; }
  atEof(): boolean { return this.peek().kind === 'eof'; }
  accept(text: string): boolean { if (this.at(text)) { this.next(); return true; } return false; }
  expect(text: string, what = ''): Token {
    if (!this.at(text)) throw new ParseError(`Expected '${text}'${what ? ' ' + what : ''} but found ${describeToken(this.peek())}`, this.peek());
    return this.next();
  }
  ident(what = 'an identifier'): Token {
    const t = this.peek();
    if (t.kind !== 'id') throw new ParseError(`Expected ${what} but found ${describeToken(t)}`, t);
    return this.next();
  }
}

const LEVELS: string[][] = [
  ['||'], ['&&'], ['|'], ['^', '~^', '^~'], ['&'], ['==', '!=', '===', '!=='],
  ['<', '<=', '>', '>='], ['<<', '>>', '<<<', '>>>'], ['+', '-'], ['*', '/', '%'],
];
const UNARY = new Set(['+', '-', '!', '~', '&', '|', '^', '~&', '~|', '~^', '^~']);

export class ExprParser extends TokenStream {
  expr(): Expr { return this.ternary(); }

  private ternary(): Expr {
    const c = this.binary(0);
    if (this.at('?')) {
      this.next();
      const a = this.ternary();
      this.expect(':', 'in ?: expression');
      const b = this.ternary();
      return { k: 'ternary', c, a, b, loc: c.loc };
    }
    return c;
  }

  private binary(level: number): Expr {
    if (level === LEVELS.length) return this.power();
    let l = this.binary(level + 1);
    while (this.peek().kind === 'op' && LEVELS[level].includes(this.peek().text)) {
      const op = this.next();
      const r = this.binary(level + 1);
      l = { k: 'binary', op: op.text, l, r, loc: locOf(op) };
    }
    return l;
  }

  private power(): Expr {
    const base = this.unary();
    if (this.at('**')) {
      const op = this.next();
      const r = this.power();
      return { k: 'binary', op: '**', l: base, r, loc: locOf(op) };
    }
    return base;
  }

  private unary(): Expr {
    const t = this.peek();
    if (t.kind === 'op' && UNARY.has(t.text)) {
      this.next();
      return { k: 'unary', op: t.text, arg: this.unary(), loc: locOf(t) };
    }
    return this.primary();
  }

  private primary(): Expr {
    const t = this.peek();
    if (t.kind === 'num') { this.next(); return { k: 'num', text: t.text, loc: locOf(t) }; }
    if (t.kind === 'id') {
      this.next();
      if (t.text.startsWith('$')) {
        const args: Expr[] = [];
        if (this.accept('(')) {
          if (!this.at(')')) do args.push(this.expr()); while (this.accept(','));
          this.expect(')', 'to close the call');
        }
        return { k: 'call', name: t.text, args, loc: locOf(t) };
      }
      if (this.at('[')) {
        this.next();
        const msb = this.expr();
        let lsb: Expr | null = null;
        if (this.at('+:') || this.at('-:')) throw new ParseError('Indexed part-selects (+: / -:) are not supported', this.peek(), true, 'Use a constant [msb:lsb] part-select');
        if (this.accept(':')) lsb = this.expr();
        this.expect(']', 'to close the bit-select');
        if (this.at('[')) throw new ParseError('Multi-dimensional selects and memories are not supported', this.peek(), true);
        return { k: 'index', base: t.text, msb, lsb, loc: locOf(t) };
      }
      return { k: 'id', name: t.text, loc: locOf(t) };
    }
    if (this.at('(')) {
      this.next();
      const e = this.expr();
      this.expect(')', 'to close the parenthesized expression');
      return e;
    }
    if (this.at('{')) {
      const open = this.next();
      const first = this.expr();
      if (this.at('{')) {
        this.next();
        const parts: Expr[] = [];
        do parts.push(this.expr()); while (this.accept(','));
        this.expect('}', 'to close the replication');
        this.expect('}', 'to close the replication');
        return { k: 'repl', count: first, parts, loc: locOf(open) };
      }
      const parts = [first];
      while (this.accept(',')) parts.push(this.expr());
      this.expect('}', 'to close the concatenation');
      return { k: 'concat', parts, loc: locOf(open) };
    }
    if (t.kind === 'str') throw new ParseError('String literals are not supported in RTL expressions', t, true);
    throw new ParseError(`Expected an expression but found ${describeToken(t)}`, t);
  }
}

/** Parses a complete expression; every token must be consumed. */
export function parseExpressionText(text: string): { expr: Expr | null; diagnostics: Diagnostic[] } {
  const lexed = tokenize(text);
  const diags = new DiagnosticBag();
  diags.items.push(...lexed.diagnostics);
  if (lexed.diagnostics.some((d) => d.severity === 'error')) return { expr: null, diagnostics: diags.items };
  const p = new ExprParser(lexed.tokens);
  try {
    const expr = p.expr();
    if (!p.atEof()) throw new ParseError(`Unexpected ${describeToken(p.peek())} after the end of the expression`, p.peek());
    return { expr, diagnostics: diags.items };
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    diags.error(e.unsupported ? 'unsupported' : 'syntax', e.message, e.tok, { suggestion: e.suggestion });
    return { expr: null, diagnostics: diags.items };
  }
}

export interface NumberLit {
  width: number | null; base: 'b' | 'o' | 'd' | 'h'; signed: boolean; value: bigint | null;
  hasXZ: boolean; truncated: boolean;
}

export function parseNumber(text: string): NumberLit {
  const m = /^(\d[\d_]*)?'([sS])?([bBoOdDhH])([0-9a-fA-FxXzZ?_]+)$/.exec(text);
  if (!m) {
    return { width: null, base: 'd', signed: true, value: BigInt(text.replace(/_/g, '')), hasXZ: false, truncated: false };
  }
  const width = m[1] ? parseInt(m[1].replace(/_/g, ''), 10) : null;
  const base = m[3].toLowerCase() as NumberLit['base'];
  const digits = m[4].replace(/_/g, '');
  const hasXZ = /[xXzZ?]/.test(digits);
  const valid = { b: /^[01]+$/, o: /^[0-7]+$/, d: /^\d+$/, h: /^[0-9a-fA-F]+$/ }[base].test(digits);
  let value: bigint | null = null;
  let truncated = false;
  if (!hasXZ && valid) {
    value = BigInt((base === 'b' ? '0b' : base === 'o' ? '0o' : base === 'h' ? '0x' : '') + digits);
    if (width !== null && width > 0) {
      const mask = (1n << BigInt(width)) - 1n;
      if (value > mask) { truncated = true; value &= mask; }
    }
  }
  return { width, base, signed: !!m[2], value, hasXZ: hasXZ || !valid, truncated };
}

export function exprToString(e: Expr): string {
  const wrap = (c: Expr): string => (c.k === 'binary' || c.k === 'ternary' ? `(${exprToString(c)})` : exprToString(c));
  switch (e.k) {
    case 'num': return e.text;
    case 'id': return e.name;
    case 'index': return `${e.base}[${exprToString(e.msb)}${e.lsb ? ':' + exprToString(e.lsb) : ''}]`;
    case 'unary': return `${e.op}${wrap(e.arg)}`;
    case 'binary': return `${wrap(e.l)} ${e.op} ${wrap(e.r)}`;
    case 'ternary': return `${e.c.k === 'ternary' ? `(${exprToString(e.c)})` : exprToString(e.c)} ? ${exprToString(e.a)} : ${exprToString(e.b)}`;
    case 'concat': return `{${e.parts.map(exprToString).join(', ')}}`;
    case 'repl': return `{${exprToString(e.count)}{${e.parts.map(exprToString).join(', ')}}}`;
    case 'call': return `${e.name}(${e.args.map(exprToString).join(', ')})`;
  }
}

export function collectIdentifiers(e: Expr, out: Set<string> = new Set()): Set<string> {
  switch (e.k) {
    case 'id': out.add(e.name); break;
    case 'index': out.add(e.base); collectIdentifiers(e.msb, out); if (e.lsb) collectIdentifiers(e.lsb, out); break;
    case 'unary': collectIdentifiers(e.arg, out); break;
    case 'binary': collectIdentifiers(e.l, out); collectIdentifiers(e.r, out); break;
    case 'ternary': collectIdentifiers(e.c, out); collectIdentifiers(e.a, out); collectIdentifiers(e.b, out); break;
    case 'concat': e.parts.forEach((p) => collectIdentifiers(p, out)); break;
    case 'repl': collectIdentifiers(e.count, out); e.parts.forEach((p) => collectIdentifiers(p, out)); break;
    case 'call': e.args.forEach((p) => collectIdentifiers(p, out)); break;
    default: break;
  }
  return out;
}
