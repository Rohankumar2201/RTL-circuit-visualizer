import { describe, expect, it } from 'vitest';
import { exprToString, parseExpressionText, parseNumber } from '../../src/parser/expression-parser';
import type { Expr } from '../../src/parser/types';

function sx(e: Expr): string {
  switch (e.k) {
    case 'num': return e.text;
    case 'id': return e.name;
    case 'index': return `${e.base}[${sx(e.msb)}${e.lsb ? ':' + sx(e.lsb) : ''}]`;
    case 'unary': return `(${e.op}u ${sx(e.arg)})`;
    case 'binary': return `(${e.op} ${sx(e.l)} ${sx(e.r)})`;
    case 'ternary': return `(? ${sx(e.c)} ${sx(e.a)} ${sx(e.b)})`;
    case 'concat': return `{${e.parts.map(sx).join(' ')}}`;
    case 'repl': return `{${sx(e.count)} x ${e.parts.map(sx).join(' ')}}`;
    case 'call': return `${e.name}(${e.args.map(sx).join(' ')})`;
  }
}
const parse = (s: string): string => {
  const r = parseExpressionText(s);
  if (!r.expr) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return sx(r.expr);
};
const error = (s: string): string => {
  const r = parseExpressionText(s);
  expect(r.expr).toBeNull();
  return r.diagnostics.map((d) => d.message).join('; ');
};

describe('expression precedence and associativity', () => {
  it('binds & tighter than |', () => expect(parse('a | b & c')).toBe('(| a (& b c))'));
  it('binds * tighter than +', () => expect(parse('a + b * c')).toBe('(+ a (* b c))'));
  it('is left-associative for -', () => expect(parse('a - b - c')).toBe('(- (- a b) c)'));
  it('is right-associative for **', () => expect(parse('a ** b ** c')).toBe('(** a (** b c))'));
  it('is right-associative for ?:', () => expect(parse('a ? b : c ? d : e')).toBe('(? a b (? c d e))'));
  it('binds unary tighter than binary', () => expect(parse('~a & b')).toBe('(& (~u a) b)'));
  it('puts shifts below additive', () => expect(parse('a << 1 + 2')).toBe('(<< a (+ 1 2))'));
  it('puts relational above equality', () => expect(parse('a == b < c')).toBe('(== a (< b c))'));
  it('puts equality above bitwise and', () => expect(parse('a & b == c')).toBe('(& a (== b c))'));
  it('puts && below | and || below &&', () => expect(parse('a || b && c | d')).toBe('(|| a (&& b (| c d)))'));
  it('honors parentheses', () => expect(parse('(a | b) & c')).toBe('(& (| a b) c)'));
  it('parses reduction operators', () => expect(parse('&a ^ |b')).toBe('(^ (&u a) (|u b))'));
  it('parses selects, concatenation and replication', () => {
    expect(parse('a[3:0]')).toBe('a[3:0]');
    expect(parse('{a[7], b, 2\'b01}')).toBe("{a[7] b 2'b01}");
    expect(parse('{4{a}}')).toBe('{4 x a}');
  });
  it('parses system calls', () => expect(parse('$clog2(N)')).toBe('$clog2(N)'));
  it('round-trips through exprToString', () => {
    const r = parseExpressionText('(a & b) | ~c ? d : e');
    expect(exprToString(r.expr!)).toBe('(a & b) | ~c ? d : e');
  });
});

describe('malformed expressions are rejected', () => {
  it('reports a missing closing parenthesis', () => expect(error('(a & b')).toMatch(/Expected '\)'/));
  it('reports a dangling operator', () => expect(error('a +')).toMatch(/Expected an expression/));
  it('reports leftover tokens instead of ignoring them', () => expect(error('a b')).toMatch(/Unexpected 'b' after the end/));
  it('reports a ?: without a colon', () => expect(error('a ? b')).toMatch(/Expected ':'/));
  it('reports a stray closing parenthesis as leftover', () => expect(error('a & b)')).toMatch(/Unexpected '\)'/));
  it('rejects unsupported indexed part-selects', () => expect(error('a[i +: 2]')).toMatch(/not supported/));
  it('rejects string literals', () => expect(error('"abc"')).toMatch(/String literals/));
});

describe('numeric literals', () => {
  it('parses bases and widths', () => {
    expect(parseNumber("8'hFF")).toMatchObject({ width: 8, value: 255n, base: 'h' });
    expect(parseNumber("4'b1010")).toMatchObject({ width: 4, value: 10n });
    expect(parseNumber("6'o17")).toMatchObject({ width: 6, value: 15n });
    expect(parseNumber('1_000')).toMatchObject({ width: null, value: 1000n });
  });
  it('flags x/z digits and truncation', () => {
    expect(parseNumber("4'b10x1")).toMatchObject({ hasXZ: true, value: null });
    expect(parseNumber("2'd7")).toMatchObject({ truncated: true, value: 3n });
  });
  it('flags digits that are invalid for the base', () => {
    expect(parseNumber("4'b102").hasXZ).toBe(true);
  });
});
