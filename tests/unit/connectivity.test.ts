import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../../src/analysis/analyze';
import { checkIntegrity, traceCone } from '../../src/analysis/connectivity';
import { EXAMPLES } from '../../src/editor/examples';
import { diag, hasDiag, kinds, top } from './helpers';

describe('driver tracking', () => {
  it('reports multiple continuous drivers', () => {
    const m = top('module m(input a, input b, output y); assign y = a; assign y = b; endmodule');
    const d = diag(m, /'y' has multiple drivers/)!;
    expect(d.severity).toBe('error');
    expect(d.category).toBe('driver');
    expect(d.explanation).toMatch(/Also driven at line/);
    expect(kinds(m, 'contention')).toHaveLength(1);
    expect(m.status).toBe('partial');
  });

  it('reports a signal driven by both an assign and an always block', () => {
    const m = top('module m(input a, input b, output logic y); assign y = a; always_comb y = b; endmodule');
    expect(hasDiag(m, /'y' has multiple drivers/)).toBe(true);
  });

  it('reports two always blocks driving the same register', () => {
    const m = top('module m(input clk, input a, output reg q); always @(posedge clk) q <= a; always @(posedge clk) q <= ~a; endmodule');
    expect(hasDiag(m, /'q' has multiple drivers/)).toBe(true);
  });

  it('allows disjoint bit-range drivers and assembles them', () => {
    const m = top('module m(input a, input b, output [1:0] y); assign y[0] = a; assign y[1] = b; endmodule');
    expect(m.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(kinds(m, 'concat')).toHaveLength(1);
  });

  it('flags overlapping bit-range drivers', () => {
    const m = top('module m(input a, input b, output [1:0] y); assign y[0] = a; assign y[1:0] = {b, b}; endmodule');
    expect(diag(m, /multiple drivers \(bits \[0:0\]\)/)).toBeTruthy();
  });

  it('reports inputs that are driven inside the module', () => {
    const m = top('module m(input a, output y); assign a = 1\'b0; assign y = a; endmodule');
    expect(hasDiag(m, /Input port 'a' is driven inside the module/)).toBe(true);
  });
});

describe('undriven and unused signals', () => {
  it('warns about an undriven output', () => {
    const m = top('module m(input a, output y); endmodule');
    expect(diag(m, /'y' is never driven/)!.severity).toBe('warning');
    expect(kinds(m, 'undriven')).toHaveLength(1);
  });

  it('warns about an internal wire that is read but never driven', () => {
    const m = top('module m(input a, output y); wire t; assign y = a & t; endmodule');
    expect(hasDiag(m, /'t' is never driven/)).toBe(true);
  });

  it('reports which bits are undriven', () => {
    const m = top('module m(input a, output [3:0] y); assign y[1:0] = {a, a}; endmodule');
    expect(hasDiag(m, /\(bits \[3:2\]\)/)).toBe(true);
    expect(kinds(m, 'undriven')[0].label).toBe('y[3:2]');
  });

  it('notes unused inputs and unused internal signals', () => {
    const m = top('module m(input a, input unused_in, output y); wire dead; assign dead = a; assign y = a; endmodule');
    expect(diag(m, /Input 'unused_in' is never used/)!.severity).toBe('info');
    expect(diag(m, /'dead' is driven but never used/)!.severity).toBe('info');
  });
});

describe('model integrity', () => {
  it('has consistent pins and connections for every example', () => {
    for (const e of EXAMPLES) {
      for (const m of analyzeSource(e.source).modules.values()) expect(checkIntegrity(m), e.id).toEqual([]);
    }
  });

  it('uses stable node ids across runs and distinct ids within a model', () => {
    const src = EXAMPLES.find((e) => e.id === 'full-adder')!.source;
    const a = analyzeSource(src).modules.get('full_adder')!;
    const b = analyzeSource(src).modules.get('full_adder')!;
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
    expect(new Set(a.nodes.map((n) => n.id)).size).toBe(a.nodes.length);
  });

  it('keeps signal names, node ids and labels distinct', () => {
    const m = top('module m(input a, output y); assign y = ~a; endmodule');
    const not = kinds(m, 'gate')[0];
    expect(not.id).not.toBe(not.drives);
    expect(not.drives).toBe('y');
    expect(not.label).toBe('NOT');
  });
});

describe('signal tracing', () => {
  const fa = analyzeSource(EXAMPLES.find((e) => e.id === 'full-adder')!.source).modules.get('full_adder')!;
  it('finds the fan-in cone of an output', () => {
    const t = traceCone(fa.connections, 'out:cout', 'in');
    expect(['in:a', 'in:b', 'in:cin'].every((id) => t.nodes.has(id))).toBe(true);
  });
  it('finds the fan-out cone of an input', () => {
    const t = traceCone(fa.connections, 'in:a', 'out');
    expect(t.nodes.has('out:sum') && t.nodes.has('out:cout')).toBe(true);
    expect(t.nodes.has('in:b')).toBe(false);
  });
  it('terminates on feedback loops', () => {
    const m = top('module m(input clk, output reg [3:0] q); always @(posedge clk) q <= q + 1; endmodule');
    expect(traceCone(m.connections, 'reg:q', 'in').nodes.has('reg:q')).toBe(true);
  });
});
