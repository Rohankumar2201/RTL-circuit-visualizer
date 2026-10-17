import type { ModuleModel } from '../analysis/hardware-model';
import { clear, h } from '../utils/dom';

const COMB = new Set(['gate', 'buf', 'mux', 'cmp', 'arith', 'shift', 'reduce', 'concat', 'slice']);

export interface Stats {
  inputs: number; outputs: number; registers: number; registerBits: number;
  combinational: number; instances: number; connections: number;
}

export function computeStats(m: ModuleModel): Stats {
  const count = (k: string): number => m.nodes.filter((n) => n.kind === k).length;
  const regs = m.nodes.filter((n) => n.kind === 'dff');
  return {
    inputs: count('input'), outputs: count('output'), registers: regs.length,
    registerBits: regs.reduce((s, n) => s + (n.width ?? 1), 0),
    combinational: m.nodes.filter((n) => COMB.has(n.kind)).length,
    instances: count('instance'), connections: m.connections.length,
  };
}

export function renderStatistics(el: HTMLElement, m: ModuleModel | null): void {
  clear(el);
  if (!m) { el.appendChild(h('p', 'muted', 'No module analyzed.')); return; }
  const s = computeStats(m);
  const rows: [string, string][] = [
    ['Inputs', String(s.inputs)], ['Outputs', String(s.outputs)],
    ['Registers', `${s.registers}${s.registers ? ` (${s.registerBits} bits)` : ''}`],
    ['Combinational nodes', String(s.combinational)], ['Module instances', String(s.instances)], ['Connections', String(s.connections)],
  ];
  const dl = h('dl', 'kv');
  for (const [k, v] of rows) { dl.append(h('dt', '', k), h('dd', '', v)); }
  el.appendChild(dl);
}
