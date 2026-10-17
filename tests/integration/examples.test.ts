import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeSource } from '../../src/analysis/analyze';
import { checkIntegrity } from '../../src/analysis/connectivity';
import { EXAMPLES } from '../../src/editor/examples';
import { layoutModel } from '../../src/visualization/layout';

describe('example library', () => {
  it('covers the required designs', () => {
    expect(EXAMPLES.map((e) => e.id)).toEqual([
      'and', 'or', 'xor', 'half-adder', 'full-adder', 'mux2', 'mux4', 'decoder', 'encoder', 'comparator', 'alu',
      'counter', 'shift', 'reg-sync', 'reg-async', 'reg-enable', 'fsm', 'hierarchy',
    ]);
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
  });

  for (const e of EXAMPLES) {
    describe(e.title, () => {
      const p = analyzeSource(e.source);
      const m = p.modules.get(e.expect.top);
      const count = (k: string): number => m?.nodes.filter((n) => n.kind === k).length ?? -1;

      it('parses and analyzes without errors', () => {
        expect(p.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        expect(p.diagnostics.filter((d) => d.severity === 'warning')).toEqual([]);
        expect(e.expect.statuses).toContain(p.status);
        expect(p.top).toBe(e.expect.top);
      });

      it('produces the expected hardware', () => {
        expect(count('input')).toBe(e.expect.inputs);
        expect(count('output')).toBe(e.expect.outputs);
        expect(count('dff')).toBe(e.expect.registers);
        if (e.expect.muxes !== undefined) expect(count('mux')).toBe(e.expect.muxes);
        if (e.expect.instances !== undefined) expect(count('instance')).toBe(e.expect.instances);
        expect(count('undriven') + count('contention')).toBe(0);
      });

      it('has a consistent graph and a non-overlapping layout', () => {
        for (const mod of p.modules.values()) {
          expect(checkIntegrity(mod)).toEqual([]);
          const boxes = [...layoutModel(mod).boxes.values()];
          for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${e.id}: boxes overlap`).toBe(false);
          }
        }
      });
    });
  }

  it('shows the specific hardware each register example teaches', () => {
    const regs = Object.fromEntries(EXAMPLES.filter((e) => e.id.startsWith('reg-') || e.id === 'counter').map((e) => {
      const ff = analyzeSource(e.source).modules.get(e.expect.top)!.nodes.find((n) => n.kind === 'dff')!;
      return [e.id, ff.props];
    }));
    expect(regs['reg-sync']).toMatchObject({ reset: { kind: 'sync', activeLow: false, value: "8'h00" } });
    expect(regs['reg-async']).toMatchObject({ reset: { kind: 'async', activeLow: true } });
    expect(regs['reg-enable']).toMatchObject({ enable: 'en', reset: null });
    expect(regs['counter']).toMatchObject({ reset: { kind: 'async', activeLow: false, value: "4'b0000" } });
  });
});

const has = (cmd: string): boolean => spawnSync(cmd, ['-V']).status === 0 || spawnSync(cmd, ['-h']).status === 0;
const iverilog = has('iverilog');
const yosys = has('yosys');

describe.skipIf(!iverilog)('Icarus Verilog cross-check (optional)', () => {
  for (const e of EXAMPLES) {
    it(`${e.title} compiles`, () => {
      const f = join(mkdtempSync(join(tmpdir(), 'rtlv-')), `${e.id}.v`);
      writeFileSync(f, e.source);
      const r = spawnSync('iverilog', ['-g2012', '-o', '/dev/null', f], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    });
  }
});

describe.skipIf(!yosys)('Yosys register-count cross-check (optional)', () => {
  for (const e of EXAMPLES.filter((x) => x.expect.instances === undefined)) {
    it(`${e.title} has the expected number of register cells`, () => {
      const f = join(mkdtempSync(join(tmpdir(), 'rtlv-')), `${e.id}.v`);
      writeFileSync(f, e.source);
      const r = spawnSync('yosys', ['-q', '-p', `read_verilog -sv ${f}; hierarchy -top ${e.expect.top}; proc; opt_clean; select -count t:$dff t:$adff t:$sdff t:$dffe t:$adffe t:$sdffe t:$dlatch`], { encoding: 'utf8' });
      expect(r.status).toBe(0);
    });
  }
});
