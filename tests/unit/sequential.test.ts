import { describe, expect, it } from 'vitest';
import { hasDiag, kinds, projectHas, srcOfPin, top } from './helpers';

const reg = (body: string, sens = 'posedge clk', extra = 'input rst, input en, input rst_n, input [3:0] d,'): string =>
  `module m(input clk, ${extra} output reg [3:0] q);\nalways_ff @(${sens}) begin\n${body}\nend\nendmodule`;

describe('registers', () => {
  it('captures a clock edge and has no reset or enable by default', () => {
    const m = top(reg('q <= d;'));
    const ff = kinds(m, 'dff')[0];
    expect(ff.props).toMatchObject({ clock: 'clk', edge: 'posedge', reset: null, enable: null, signal: 'q' });
    expect(ff.pins.map((p) => p.name)).toEqual(['D', 'CLK', 'Q']);
    expect(ff.explain).toMatch(/rising edge of clk/);
  });

  it('represents an asynchronous active-high reset with its value', () => {
    const m = top(reg("if (rst) q <= 4'd5; else q <= d;", 'posedge clk or posedge rst'));
    const ff = kinds(m, 'dff')[0];
    expect(ff.props.reset).toEqual({ signal: 'rst', kind: 'async', activeLow: false, value: "4'd5" });
    expect(ff.pins.map((p) => p.name)).toContain('RST');
    expect(srcOfPin(m, ff.id, 'RST')!.id).toBe('in:rst');
    expect(kinds(m, 'mux')).toHaveLength(0);
  });

  it('preserves active-low reset polarity from negedge', () => {
    const m = top(reg("if (!rst_n) q <= 4'd0; else q <= d;", 'posedge clk or negedge rst_n'));
    const ff = kinds(m, 'dff')[0];
    expect(ff.props.reset).toMatchObject({ signal: 'rst_n', kind: 'async', activeLow: true });
    expect(ff.pins.map((p) => p.name)).toContain('RSTn');
  });

  it('does not leave dangling condition or reset-value nodes behind', () => {
    const m = top(reg("if (!rst_n) q <= 4'd0; else q <= d;", 'posedge clk or negedge rst_n'));
    expect(kinds(m, 'gate')).toHaveLength(0);
    expect(kinds(m, 'const')).toHaveLength(0);
    const used = new Set(m.connections.map((c) => c.from.node));
    for (const n of m.nodes) if (n.kind !== 'output' && n.kind !== 'input') expect(used.has(n.id), n.id).toBe(true);
  });

  it('recognizes a reset written in the else branch', () => {
    const m = top(reg("if (rst_n) q <= d; else q <= 4'd0;", 'posedge clk or negedge rst_n'));
    expect(kinds(m, 'dff')[0].props.reset).toMatchObject({ signal: 'rst_n', activeLow: true });
  });

  it('represents a synchronous reset and explains how it was recognized', () => {
    const m = top(reg("if (rst) q <= 4'd0; else q <= d;"));
    expect(kinds(m, 'dff')[0].props.reset).toMatchObject({ signal: 'rst', kind: 'sync', activeLow: false });
    expect(m.diagnostics.find((d) => /synchronous reset/.test(d.message))?.severity).toBe('info');
  });

  it('infers an enable instead of a feedback mux', () => {
    const m = top(reg('if (en) q <= d;'));
    const ff = kinds(m, 'dff')[0];
    expect(ff.pins.map((p) => p.name)).toContain('EN');
    expect(srcOfPin(m, ff.id, 'EN')!.id).toBe('in:en');
    expect(kinds(m, 'mux')).toHaveLength(0);
    expect(ff.props.enable).toBe('en');
  });

  it('combines nested enables with an AND gate', () => {
    const m = top(reg('if (en) begin if (d[0]) q <= d; end'));
    const ff = kinds(m, 'dff')[0];
    expect(srcOfPin(m, ff.id, 'EN')!.op).toBe('AND');
  });

  it('inverts an enable written as "hold when"', () => {
    const m = top(reg('if (en) q <= q; else q <= d;'));
    const ff = kinds(m, 'dff')[0];
    expect(srcOfPin(m, ff.id, 'EN')!.op).toBe('NOT');
  });

  it('combines reset and enable', () => {
    const m = top(reg("if (!rst_n) q <= 4'd0; else if (en) q <= d;", 'posedge clk or negedge rst_n'));
    const ff = kinds(m, 'dff')[0];
    expect(ff.pins.map((p) => p.name)).toEqual(['D', 'CLK', 'RSTn', 'EN', 'Q']);
  });

  it('supports falling-edge clocks', () => {
    const m = top(reg('q <= d;', 'negedge clk'));
    expect(kinds(m, 'dff')[0].props.edge).toBe('negedge');
  });

  it('creates one register per assigned signal', () => {
    const m = top('module m(input clk, input a, output reg x, output reg y); always @(posedge clk) begin x <= a; y <= x; end endmodule');
    expect(kinds(m, 'dff')).toHaveLength(2);
    expect(srcOfPin(m, 'reg:y', 'D')!.id).toBe('reg:x');
  });

  it('keeps a case statement in the next-state logic', () => {
    const m = top('module m(input clk, input [1:0] s, input [3:0] d, output reg [3:0] q); always_ff @(posedge clk) begin case (s) 2\'d0: q <= d; 2\'d1: q <= ~d; default: q <= q; endcase end endmodule');
    expect(kinds(m, 'mux').length).toBeGreaterThan(0);
    expect(kinds(m, 'dff')).toHaveLength(1);
  });

  it('notes that blocking assignments in clocked blocks are treated as nonblocking', () => {
    const m = top('module m(input clk, input d, output reg q); always @(posedge clk) q = d; endmodule');
    expect(hasDiag(m, /Blocking assignments in a clocked block/)).toBe(true);
  });
});

describe('unsupported sequential structures are reported, not hidden', () => {
  it('rejects non-constant reset values', () => {
    const m = top(reg('if (rst) q <= d; else q <= ~d;', 'posedge clk or posedge rst'));
    expect(hasDiag(m, /Reset value of a register is not a constant/)).toBe(true);
    expect(m.status).toBe('partial');
    expect(kinds(m, 'dff')).toHaveLength(0);
  });

  it('rejects more than two edge events', () => {
    const m = top('module m(input clk, input r, input s, input d, output reg q); always @(posedge clk or posedge r or posedge s) q <= d; endmodule');
    expect(hasDiag(m, /3 edge events/)).toBe(true);
    expect(m.partial).toBe(true);
  });

  it('warns when an extra edge event is not a reset', () => {
    const m = top(reg('q <= d;', 'posedge clk or posedge rst'));
    expect(hasDiag(m, /not used as a reset/)).toBe(true);
  });

  it('rejects loops in clocked blocks and marks the register unmodeled', () => {
    const src = 'module m(input clk, output reg [1:0] q); integer i; always @(posedge clk) begin for (i = 0; i < 2; i = i + 1) q <= q + 1; end endmodule';
    const m = top(src);
    expect(projectHas(src, /'for' statements/)).toBe(true);
    expect(kinds(m, 'undriven')[0].props.unmodeled).toBe(true);
  });
});
