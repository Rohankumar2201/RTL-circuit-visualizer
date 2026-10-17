import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../../src/analysis/analyze';
import { parseSource } from '../../src/parser/module-parser';

const fixture = (n: string): string => readFileSync(join(__dirname, '../fixtures/rtl-examples', n), 'utf8');
const msgs = (src: string): string[] => analyzeSource(src).diagnostics.map((d) => d.message);

describe('module parsing', () => {
  it('parses ANSI ports with inherited direction, type and range', () => {
    const { modules, diagnostics } = parseSource('module m(input [7:0] a, b, input c, output reg [3:0] y, z); endmodule');
    expect(diagnostics).toEqual([]);
    const ports = modules[0].ports;
    expect(ports.map((p) => [p.name, p.dir, p.kind, !!p.range])).toEqual([
      ['a', 'input', 'wire', true], ['b', 'input', 'wire', true], ['c', 'input', 'wire', false],
      ['y', 'output', 'reg', true], ['z', 'output', 'reg', true],
    ]);
  });

  it('parses header parameters and resolves widths from them', () => {
    const p = analyzeSource(fixture('param-register.v'));
    expect(p.status).toBe('complete');
    const m = p.modules.get('param_reg')!;
    expect(m.signals.find((s) => s.name === 'q')!.width).toBe(8);
    expect(m.nodes.find((n) => n.kind === 'dff')!.width).toBe(8);
  });

  it('parses named and positional connections and parameter overrides', () => {
    const { modules } = parseSource('module t; sub #(.W(4)) u0 (.a(x), .b()); sub #(8) u1 (p, q); endmodule');
    const [u0, u1] = modules[0].instances;
    expect(u0.params[0].name).toBe('W');
    expect(u0.conns.map((c) => [c.port, c.expr === null])).toEqual([['a', false], ['b', true]]);
    expect(u1.conns.map((c) => c.port)).toEqual([null, null]);
  });

  it('reports non-ANSI port lists as unsupported with a suggestion', () => {
    const p = analyzeSource(fixture('non-ansi.v'));
    expect(p.modules.size).toBe(0);
    expect(p.status).toBe('failed');
    expect(p.diagnostics.some((d) => /Non-ANSI port lists are not supported/.test(d.message) && !!d.suggestion && d.line === 1)).toBe(true);
  });

  it('recovers after an unsupported item and keeps analyzing the rest', () => {
    const src = 'module m(input a, output y, output z);\ninitial begin y = 0; end\nassign z = a;\nendmodule';
    const p = analyzeSource(src);
    const d = p.diagnostics.find((x) => /initial block/.test(x.message))!;
    expect(d).toMatchObject({ severity: 'warning', category: 'unsupported', line: 2 });
    expect(p.modules.get('m')!.nodes.some((n) => n.id === 'out:z')).toBe(true);
    expect(p.status).toBe('partial');
    expect(p.diagnostics.some((x) => /'y' is never driven/.test(x.message))).toBe(false);
  });

  it('reports a malformed expression with its location and keeps going', () => {
    const p = analyzeSource('module m(input a, input b, output y, output z);\nassign y = (a & b;\nassign z = a | b;\nendmodule');
    const d = p.diagnostics.find((x) => x.severity === 'error' && /Expected '\)'/.test(x.message))!;
    expect(d.line).toBe(2);
    expect(p.modules.get('m')!.nodes.some((n) => n.kind === 'gate' && n.op === 'OR')).toBe(true);
    expect(p.status).toBe('partial');
  });

  it('never silently ignores leftover tokens in an assign', () => {
    expect(msgs('module m(input a, input b, output y); assign y = a b; endmodule').join('|')).toMatch(/Expected ';'/);
  });

  it('reports a missing endmodule', () => {
    expect(msgs('module m(input a, output y); assign y = a;').join('|')).toMatch(/Missing 'endmodule' for module 'm'/);
  });

  it('reports gate primitives and ignores directives', () => {
    const p = analyzeSource('`timescale 1ns/1ps\nmodule m(input a, input b, output y); and g1 (y, a, b); endmodule');
    expect(p.diagnostics.some((d) => /Gate primitive 'and' is not supported/.test(d.message))).toBe(true);
    expect(p.diagnostics.some((d) => d.severity === 'info' && /timescale/.test(d.message))).toBe(true);
  });

  it('reports text outside any module', () => {
    expect(msgs('wire stray; module m; endmodule').join('|')).toMatch(/outside a module/);
  });

  it('handles empty and oversized input', () => {
    expect(analyzeSource('   \n').empty).toBe(true);
    const big = analyzeSource('x'.repeat(250_000));
    expect(big.status).toBe('failed');
    expect(big.diagnostics[0].category).toBe('limits');
  });

  it('survives garbage input without throwing', () => {
    for (const junk of ['module', 'module m(', 'module m(input', ')))', 'always @(', 'module m; case endmodule', '{{{{', 'module m(input a); assign = ; endmodule']) {
      expect(() => analyzeSource(junk)).not.toThrow();
      expect(analyzeSource(junk).status === 'failed' || analyzeSource(junk).diagnostics.length > 0).toBe(true);
    }
  });
});

describe('hierarchy', () => {
  const lib = `module leaf #(parameter W = 4)(input [W-1:0] a, output [W-1:0] y); assign y = ~a; endmodule\n`;

  it('draws instances as pin-accurate unexpanded boxes', () => {
    const p = analyzeSource(lib + 'module top(input [3:0] x, output [3:0] z); leaf u (.a(x), .y(z)); endmodule');
    const t = p.modules.get('top')!;
    const inst = t.nodes.find((n) => n.kind === 'instance')!;
    expect(inst.pins.map((q) => [q.name, q.dir, q.width])).toEqual([['a', 'in', 4], ['y', 'out', 4]]);
    expect(t.connections.some((c) => c.from.node === 'in:x' && c.to.node === inst.id && c.to.pin === 'a')).toBe(true);
    expect(t.connections.some((c) => c.from.node === inst.id && c.from.pin === 'y' && c.to.node === 'out:z')).toBe(true);
    expect(t.nodes.some((n) => n.kind === 'gate')).toBe(false);
    expect(p.hierarchy).toMatchObject({ module: 'top', children: [{ module: 'leaf', instance: 'u', known: true }] });
  });

  it('applies parameter overrides to child port widths and checks widths', () => {
    const p = analyzeSource(lib + 'module top(input [7:0] x, output [7:0] z); leaf #(.W(8)) u (.a(x), .y(z)); endmodule');
    const inst = p.modules.get('top')!.nodes.find((n) => n.kind === 'instance')!;
    expect(inst.pins[0].width).toBe(8);
    expect(p.diagnostics.filter((d) => d.category === 'width')).toEqual([]);
    const bad = analyzeSource(lib + 'module top(input [7:0] x, output [3:0] z); leaf u (.a(x), .y(z)); endmodule');
    expect(bad.diagnostics.some((d) => /Port 'a' of 'u' is 4 bits but is connected to 8 bits/.test(d.message))).toBe(true);
  });

  it('reports unknown modules without inventing wires', () => {
    const p = analyzeSource(fixture('unknown-module.v'));
    const t = p.modules.get('top')!;
    expect(p.diagnostics.find((d) => /Unknown module 'mystery_block'/.test(d.message))!.severity).toBe('error');
    expect(t.nodes.find((n) => n.kind === 'instance')!.props.known).toBe(false);
    expect(t.connections.some((c) => c.to.node === 'inst:u0' || c.from.node === 'inst:u0')).toBe(false);
    expect(p.diagnostics.some((d) => /never driven/.test(d.message))).toBe(false);
    expect(p.status).toBe('partial');
  });

  it('reports missing, unknown and duplicate port connections', () => {
    const p = analyzeSource(lib + 'module top(input [3:0] x, output [3:0] z); leaf u (.nope(x), .y(z)); endmodule');
    const text = p.diagnostics.map((d) => d.message).join('|');
    expect(text).toMatch(/has no port 'nope'/);
    expect(text).toMatch(/Input port 'a' of 'u' is not connected/);
  });

  it('detects recursive instantiation and does not expand it', () => {
    const p = analyzeSource('module a(input x, output y); b u (.x(x), .y(y)); endmodule\nmodule b(input x, output y); a u (.x(x), .y(y)); endmodule');
    expect(p.diagnostics.some((d) => /recursive instantiation \(a → b → a\)/.test(d.message))).toBe(true);
    const walk = (n: typeof p.hierarchy): number => (n ? 1 + n.children.reduce((s, c) => s + walk(c), 0) : 0);
    expect(walk(p.hierarchy)).toBeLessThan(10);
  });

  it('detects self-instantiation', () => {
    const p = analyzeSource('module a(input x, output y); a u (.x(x), .y(y)); endmodule');
    expect(p.diagnostics.some((d) => /recursive instantiation/.test(d.message))).toBe(true);
  });

  it('selects the module that is never instantiated as top', () => {
    const p = analyzeSource(lib + 'module top(input [3:0] x, output [3:0] z); leaf u (.a(x), .y(z)); endmodule');
    expect(p.top).toBe('top');
    expect(p.order).toEqual(['leaf', 'top']);
  });

  it('reports duplicate module names', () => {
    expect(msgs('module a; endmodule module a; endmodule').join('|')).toMatch(/'a' is defined more than once/);
  });
});

describe('fixtures', () => {
  it('flags multiple drivers', () => expect(msgs(fixture('multiple-drivers.v')).join('|')).toMatch(/'y' has multiple drivers/));
  it('flags unsupported loops', () => expect(msgs(fixture('unsupported-for-loop.v')).join('|')).toMatch(/'for' statements/));
  it('flags width mismatches', () => expect(msgs(fixture('width-mismatch.v')).join('|')).toMatch(/8-bit value assigned to 4-bit 'y'/));
  it('flags latches', () => expect(msgs(fixture('latch.v')).join('|')).toMatch(/Latch inferred for 'q'/));
});
