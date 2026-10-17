import { describe, expect, it } from 'vitest';
import { hasDiag, kinds, projectHas, srcOfPin, top } from './helpers';

const hdr = 'module m(input a, input b, input c, input [3:0] v, input [7:0] w, input [1:0] s2, input sel, output y, output [3:0] y4);\n';

describe('continuous assigns', () => {
  it('builds a gate graph that honors precedence (a | b & c)', () => {
    const m = top('module m(input a, input b, input c, output y); assign y = a | b & c; endmodule');
    const or = kinds(m, 'gate').find((n) => n.op === 'OR')!;
    const and = kinds(m, 'gate').find((n) => n.op === 'AND')!;
    expect(srcOfPin(m, or.id, 'A')!.id).toBe('in:a');
    expect(srcOfPin(m, or.id, 'B')!.id).toBe(and.id);
    expect(srcOfPin(m, and.id, 'A')!.id).toBe('in:b');
    expect(srcOfPin(m, and.id, 'B')!.id).toBe('in:c');
    expect(or.drives).toBe('y');
  });

  it('folds ~(a & b) into one NAND gate', () => {
    const m = top('module m(input a, input b, output y); assign y = ~(a & b); endmodule');
    expect(kinds(m, 'gate').map((g) => g.op)).toEqual(['NAND']);
  });

  it('keeps ~a & b as NOT feeding AND', () => {
    const m = top('module m(input a, input b, output y); assign y = ~a & b; endmodule');
    expect(kinds(m, 'gate').map((g) => g.op).sort()).toEqual(['AND', 'NOT']);
  });

  it('infers a 2:1 mux from ?: with data and select pins', () => {
    const m = top('module m(input sel, input a, input b, output y); assign y = sel ? a : b; endmodule');
    const mux = kinds(m, 'mux')[0];
    expect(mux.pins.map((p) => p.name)).toEqual(['D0', 'D1', 'S', 'Y']);
    expect(srcOfPin(m, mux.id, 'S')!.id).toBe('in:sel');
    expect(srcOfPin(m, mux.id, 'D1')!.id).toBe('in:a');
    expect(srcOfPin(m, mux.id, 'D0')!.id).toBe('in:b');
    expect(mux.explain).toMatch(/2:1 mux inferred/);
  });

  it('models comparators, arithmetic, shifts and reductions', () => {
    const m = top('module m(input [3:0] a, input [3:0] b, output eq, output [3:0] s, output [3:0] sh, output r); assign eq = a == b; assign s = a + b; assign sh = a << 1; assign r = ^a; endmodule');
    expect(kinds(m, 'cmp')[0].op).toBe('EQ');
    expect(kinds(m, 'arith')[0].op).toBe('ADD');
    expect(kinds(m, 'shift')[0].op).toBe('SHL');
    expect(kinds(m, 'reduce')[0].op).toBe('RXOR');
  });

  it('splits a concatenated target into slices without width warnings', () => {
    const m = top('module m(input a, input b, output co, output s); assign {co, s} = a + b; endmodule');
    expect(m.diagnostics.filter((d) => d.category === 'width')).toEqual([]);
    expect(kinds(m, 'arith')[0].width).toBe(2);
    expect(kinds(m, 'slice')).toHaveLength(2);
  });

  it('supports concatenation, replication and part-selects', () => {
    const m = top('module m(input [3:0] a, input b, output [7:0] y); assign y = {{3{b}}, a[2:0], b, 1\'b0}; endmodule');
    expect(m.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(kinds(m, 'concat').map((n) => n.width).sort()).toEqual([3, 8]);
  });

  it('uses a dynamic select node for variable bit-selects', () => {
    const m = top('module m(input [7:0] a, input [2:0] i, output y); assign y = a[i]; endmodule');
    expect(kinds(m, 'slice')[0].op).toBe('DYNSEL');
  });

  it('uses declared ranges that do not start at zero', () => {
    const m = top('module m(input [15:8] a, output y); assign y = a[15]; endmodule');
    expect(kinds(m, 'slice')[0].props).toMatchObject({ lo: 7, hi: 7 });
    const bad = top('module m(input [15:8] a, output y); assign y = a[3]; endmodule');
    expect(hasDiag(bad, /outside the declared range \[15:8\]/)).toBe(true);
  });
});

describe('width diagnostics', () => {
  it('warns when a wider value is truncated', () => {
    const m = top('module m(input [7:0] a, output [3:0] y); assign y = a; endmodule');
    expect(hasDiag(m, /8-bit value assigned to 4-bit 'y'/)).toBe(true);
  });
  it('notes zero-extension of narrower non-arithmetic values', () => {
    const m = top('module m(input [1:0] a, output [3:0] y); assign y = a; endmodule');
    expect(m.diagnostics.find((d) => /zero-extended/.test(d.message))?.severity).toBe('info');
  });
  it('does not complain about carry bits in arithmetic', () => {
    const m = top('module m(input [3:0] a, input [3:0] b, output [4:0] y); assign y = a + b; endmodule');
    expect(m.diagnostics).toEqual([]);
    expect(kinds(m, 'arith')[0].width).toBe(5);
  });
  it('warns about constants that do not fit', () => {
    const m = top("module m(output [1:0] y); assign y = 9; endmodule");
    expect(hasDiag(m, /does not fit/)).toBe(true);
  });
});

describe('declarations', () => {
  it('reports undeclared signals', () => {
    const m = top('module m(input a, output y); assign y = a & ghost; endmodule');
    expect(m.diagnostics.find((d) => /'ghost' is used but not declared/.test(d.message))?.severity).toBe('error');
  });
  it('reports wires assigned procedurally and regs assigned continuously', () => {
    const m1 = top('module m(input a, output y); always_comb y = a; endmodule');
    expect(hasDiag(m1, /'y' is a wire but is assigned in a procedural block/)).toBe(true);
    const m2 = top('module m(input a, output reg y); assign y = a; endmodule');
    expect(hasDiag(m2, /'y' is a reg but is driven by a continuous assign/)).toBe(true);
  });
  it('reports duplicate declarations', () => {
    const m = top('module m(input a, output y); wire a; assign y = a; endmodule');
    expect(hasDiag(m, /'a' is declared more than once/)).toBe(true);
  });
});

describe('procedural combinational logic', () => {
  it('infers a mux from if/else with no latch', () => {
    const m = top('module m(input sel, input a, input b, output reg y); always_comb begin if (sel) y = a; else y = b; end endmodule');
    expect(kinds(m, 'mux')).toHaveLength(1);
    expect(m.diagnostics.some((d) => d.category === 'latch')).toBe(false);
  });

  it('detects a latch when a branch does not assign', () => {
    const m = top('module m(input en, input d, output reg q); always_comb begin if (en) q = d; end endmodule');
    const d = m.diagnostics.find((x) => x.category === 'latch')!;
    expect(d.severity).toBe('warning');
    expect(d.suggestion).toMatch(/default value/);
    expect(kinds(m, 'mux')[0].props.feedback).toBe(true);
  });

  it('does not warn when a default assignment precedes the if', () => {
    const m = top('module m(input en, input d, output reg q); always_comb begin q = 1\'b0; if (en) q = d; end endmodule');
    expect(m.diagnostics.some((x) => x.category === 'latch')).toBe(false);
  });

  it('infers one N:1 mux from a complete case', () => {
    const m = top(hdr + 'reg [3:0] t; always_comb begin case (s2) 2\'d0: t = v; 2\'d1: t = ~v; 2\'d2: t = v; default: t = 4\'d0; endcase end assign y4 = t; assign y = a; endmodule'.replace('reg [3:0] t;', 'reg [3:0] t;'));
    const mux = kinds(m, 'mux')[0];
    expect(mux.pins.filter((p) => p.name.startsWith('D'))).toHaveLength(4);
    expect(m.diagnostics.some((d) => d.category === 'latch')).toBe(false);
  });

  it('warns about a latch for an incomplete case without default', () => {
    const m = top('module m(input [1:0] s, input a, output reg y); always_comb begin case (s) 2\'d0: y = a; 2\'d1: y = ~a; endcase end endmodule');
    expect(m.diagnostics.some((d) => d.category === 'latch')).toBe(true);
  });

  it('falls back to a comparator chain for wide selectors', () => {
    const m = top('module m(input [7:0] s, input a, output reg y); always_comb begin case (s) 8\'d1: y = a; 8\'d200: y = ~a; default: y = 1\'b0; endcase end endmodule');
    expect(kinds(m, 'cmp')).toHaveLength(2);
    expect(kinds(m, 'mux')).toHaveLength(2);
  });

  it('lets later blocking assignments see earlier ones', () => {
    const m = top('module m(input a, input b, output reg y); reg t; always_comb begin t = a & b; y = ~t; end endmodule');
    const not = kinds(m, 'gate').find((g) => g.op === 'NOT')!;
    expect(srcOfPin(m, not.id, 'A')!.op).toBe('AND');
  });

  it('reports unsupported loops and marks their targets unmodeled, not undriven', () => {
    const src = 'module m(input [3:0] a, output reg [3:0] y); integer i; always_comb begin for (i = 0; i < 4; i = i + 1) y[i] = a[i]; end endmodule';
    const m = top(src);
    expect(projectHas(src, /'for' statements/)).toBe(true);
    expect(m.partial).toBe(true);
    expect(m.status).toBe('partial');
    expect(hasDiag(m, /never driven/)).toBe(false);
    expect(kinds(m, 'undriven')[0].props.unmodeled).toBe(true);
  });

  it('rejects casez wildcards honestly', () => {
    const m = top('module m(input [1:0] s, input a, output reg y); always_comb begin casez (s) 2\'b1?: y = a; default: y = 1\'b0; endcase end endmodule');
    expect(hasDiag(m, /wildcards are not modeled/)).toBe(true);
    expect(m.status).toBe('partial');
  });

  it('rejects partial assignments in procedural blocks', () => {
    const m = top('module m(input a, output reg [1:0] y); always_comb begin y[0] = a; y[1] = a; end endmodule');
    expect(hasDiag(m, /bit or part of a vector inside a procedural block/)).toBe(true);
  });
});
