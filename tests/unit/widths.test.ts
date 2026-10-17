import { describe, expect, it } from 'vitest';
import { parseExpressionText } from '../../src/parser/expression-parser';
import { bitPos, evalConst, evalParams, rangeLabel, rangeWidth, selfWidth, type ConstEnv } from '../../src/analysis/widths';

const e = (s: string) => parseExpressionText(s).expr!;
const env: ConstEnv = new Map([['W', 8n]]);

describe('vector ranges', () => {
  it('computes widths of ascending and descending ranges', () => {
    expect(rangeWidth({ msb: 7, lsb: 0 })).toBe(8);
    expect(rangeWidth({ msb: 15, lsb: 8 })).toBe(8);
    expect(rangeWidth({ msb: 0, lsb: 7 })).toBe(8);
    expect(rangeLabel({ msb: 15, lsb: 8 })).toBe('[15:8]');
  });
  it('does not assume ranges start at bit zero', () => {
    expect(bitPos({ msb: 15, lsb: 8 }, 8)).toBe(0);
    expect(bitPos({ msb: 15, lsb: 8 }, 15)).toBe(7);
    expect(bitPos({ msb: 0, lsb: 7 }, 7)).toBe(0);
    expect(bitPos({ msb: 0, lsb: 7 }, 0)).toBe(7);
  });
  it('rejects indices outside the declared range', () => {
    expect(bitPos({ msb: 15, lsb: 8 }, 3)).toBeNull();
    expect(bitPos({ msb: 7, lsb: 0 }, 8)).toBeNull();
  });
});

describe('constant evaluation', () => {
  it('evaluates arithmetic with parameters', () => {
    expect(evalConst(e('W - 1'), env)).toBe(7n);
    expect(evalConst(e('(W * 2) + 1'), env)).toBe(17n);
    expect(evalConst(e('1 << 4'), env)).toBe(16n);
    expect(evalConst(e('W > 4 ? 10 : 20'), env)).toBe(10n);
  });
  it('evaluates replications and concatenations of sized literals', () => {
    expect(evalConst(e("{W{1'b0}}"), env)).toBe(0n);
    expect(evalConst(e("{2{2'b10}}"), env)).toBe(10n);
    expect(evalConst(e("{4'hA, 4'h5}"), env)).toBe(165n);
    expect(evalConst(e('{W{1}}'), env)).toBeNull();
  });
  it('supports $clog2', () => {
    expect(evalConst(e('$clog2(9)'), env)).toBe(4n);
    expect(evalConst(e('$clog2(8)'), env)).toBe(3n);
    expect(evalConst(e('$clog2(1)'), env)).toBe(0n);
  });
  it('returns null for unknown names, x digits and division by zero', () => {
    expect(evalConst(e('Q + 1'), env)).toBeNull();
    expect(evalConst(e("4'bx0"), env)).toBeNull();
    expect(evalConst(e('1 / 0'), env)).toBeNull();
  });
  it('evaluates parameter lists in order with overrides', () => {
    const params = [
      { name: 'A', value: e('4'), local: false, loc: { line: 1, col: 1 } },
      { name: 'B', value: e('A * 2'), local: false, loc: { line: 1, col: 1 } },
      { name: 'C', value: e('A + 1'), local: true, loc: { line: 1, col: 1 } },
    ];
    expect([...evalParams(params, new Map())]).toEqual([['A', 4n], ['B', 8n], ['C', 5n]]);
    expect(evalParams(params, new Map([['A', 10n], ['C', 99n]])).get('B')).toBe(20n);
    expect(evalParams(params, new Map([['C', 99n]])).get('C')).toBe(5n);
  });
});

describe('self-determined widths', () => {
  const widths: Record<string, number> = { a: 8, b: 4, s: 1 };
  const ctx = { widthOf: (n: string) => widths[n] ?? null, env };
  it('sizes operators', () => {
    expect(selfWidth(e('a + b'), ctx)).toBe(8);
    expect(selfWidth(e('a == b'), ctx)).toBe(1);
    expect(selfWidth(e('&a'), ctx)).toBe(1);
    expect(selfWidth(e('s ? a : b'), ctx)).toBe(8);
    expect(selfWidth(e('a << 2'), ctx)).toBe(8);
    expect(selfWidth(e('~b'), ctx)).toBe(4);
  });
  it('sizes selects and concatenations', () => {
    expect(selfWidth(e('a[3:0]'), ctx)).toBe(4);
    expect(selfWidth(e('a[7]'), ctx)).toBe(1);
    expect(selfWidth(e('{a, b, s}'), ctx)).toBe(13);
    expect(selfWidth(e('{3{b}}'), ctx)).toBe(12);
  });
  it('treats unsized constants as flexible and unknown names as unknown', () => {
    expect(selfWidth(e('b + 1'), ctx)).toBe(4);
    expect(selfWidth(e('{a, 1}'), ctx)).toBeNull();
    expect(selfWidth(e('zz'), ctx)).toBeNull();
  });
});
