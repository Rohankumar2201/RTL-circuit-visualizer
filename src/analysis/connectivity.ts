import type { DiagnosticBag } from '../parser/diagnostics';
import type { Loc, ModuleAst } from '../parser/types';
import { evalConst, rangeLabel, rangeWidth, type Range } from './widths';
import {
  ModelBuilder, inPin, outPin, type Connection, type DriverOrigin, type ModuleModel, type Source,
} from './hardware-model';

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Declares every port and net, evaluating declared ranges. */
export function declareSignals(b: ModelBuilder): void {
  const ast: ModuleAst = b.ast;
  const rangeOf = (r: { msb: import('../parser/types').Expr; lsb: import('../parser/types').Expr } | null, name: string, loc: Loc): Range => {
    if (!r) return { msb: 0, lsb: 0 };
    const m = evalConst(r.msb, b.params), l = evalConst(r.lsb, b.params);
    if (m === null || l === null) {
      b.diags.error('declaration', `Range of '${name}' is not a constant expression`, loc, { suggestion: 'Use literals or parameters in vector ranges.' });
      b.partial = true;
      return { msb: 0, lsb: 0 };
    }
    return { msb: Number(m), lsb: Number(l) };
  };
  const add = (name: string, kind: 'wire' | 'reg' | 'logic', dir: 'input' | 'output' | 'inout' | null, r: Range, signed: boolean, loc: Loc): void => {
    if (!IDENT.test(name)) { b.diags.error('declaration', `Invalid identifier '${name}'`, loc); return; }
    if (b.signals.has(name)) { b.diags.error('declaration', `'${name}' is declared more than once`, loc); return; }
    if (b.params.has(name)) b.diags.warn('declaration', `'${name}' is also a parameter name`, loc);
    if (rangeWidth(r) > 4096) { b.diags.error('limits', `'${name}' is ${rangeWidth(r)} bits wide; vectors above 4096 bits are not supported`, loc); b.partial = true; r = { msb: 0, lsb: 0 }; }
    b.signals.set(name, { name, kind, dir, range: r, width: rangeWidth(r), signed, loc, drivers: [], readers: 0, unmodeled: false });
  };
  for (const p of ast.ports) add(p.name, p.kind, p.dir, rangeOf(p.range, p.name, p.loc), p.signed, p.loc);
  for (const n of ast.nets) add(n.name, n.kind, null, rangeOf(n.range, n.name, n.loc), n.signed, n.loc);
}

export function createPortNodes(b: ModelBuilder): void {
  for (const p of b.ast.ports) {
    const sig = b.signals.get(p.name);
    if (!sig || p.dir === 'output') continue;
    if (p.dir === 'inout') b.diags.warn('unsupported', `Inout port '${p.name}' is modeled as an input`, p.loc, { explanation: 'Bidirectional drivers and tri-state buses are not modeled.' });
    const node = b.addNode('input', 'INPUT', {
      id: `in:${p.name}`, label: p.name, width: sig.width, pins: [outPin('Y', sig.width)], loc: p.loc,
      props: { signal: p.name, range: rangeLabel(sig.range) }, explain: `Input port '${p.name}' (${sig.width} bit${sig.width > 1 ? 's' : ''}).`,
    });
    node.drives = p.name;
    b.drivers.push({ signal: p.name, node: node.id, pin: 'Y', lo: 0, hi: sig.width - 1, origin: 'input', block: 'port', loc: p.loc });
  }
}

export function createOutputNodes(b: ModelBuilder): void {
  for (const p of b.ast.ports) {
    const sig = b.signals.get(p.name);
    if (!sig || p.dir !== 'output') continue;
    const node = b.addNode('output', 'OUTPUT', {
      id: `out:${p.name}`, label: p.name, width: sig.width, pins: [inPin('A', sig.width)], loc: p.loc,
      props: { signal: p.name, range: rangeLabel(sig.range) }, explain: `Output port '${p.name}' (${sig.width} bit${sig.width > 1 ? 's' : ''}).`,
    });
    b.connect({ type: 'sig', name: p.name, width: sig.width, loc: p.loc }, { node: node.id, pin: 'A' });
  }
}

export function registerDriver(
  b: ModelBuilder, signal: string, src: Extract<Source, { type: 'pin' }>, lo: number, hi: number,
  origin: DriverOrigin, block: string, loc: Loc | null,
): void {
  b.drivers.push({ signal, node: src.node, pin: src.pin, lo, hi, origin, block, loc });
  const n = b.node(src.node);
  if (n && !n.drives) n.drives = signal;
}

function undrivenNode(b: ModelBuilder, name: string, hi: number, lo: number, whole: boolean): Source {
  const w = hi - lo + 1;
  const label = whole ? name : `${name}[${hi}:${lo}]`;
  const unmodeled = b.unmodeled.has(name);
  const node = b.addNode('undriven', 'UNDRIVEN', {
    id: `undriven:${label}`, label, width: w, pins: [outPin('Y', w)],
    props: { signal: name, unmodeled },
    explain: unmodeled ? `'${label}' is assigned by a construct that could not be analyzed.` : `'${label}' has no driver.`,
  });
  return { type: 'pin', node: node.id, pin: 'Y', width: w };
}

function overlaps(a: { lo: number; hi: number }, c: { lo: number; hi: number }): boolean { return a.lo <= c.hi && c.lo <= a.hi; }

/** Source representing the complete value of a signal given all of its drivers. */
function baseSource(b: ModelBuilder, name: string): Source {
  const cached = b.baseCache.get(name);
  if (cached) return cached;
  const sig = b.signals.get(name)!;
  const w = sig.width;
  const ds = b.drivers.filter((d) => d.signal === name);
  let out: Source;
  const asPin = (d: (typeof ds)[number]): Source => ({ type: 'pin', node: d.node, pin: d.pin, width: d.hi - d.lo + 1 });
  if (ds.length === 0) out = undrivenNode(b, name, w - 1, 0, true);
  else if (ds.some((d, i) => ds.some((o, j) => j > i && d.block !== o.block && overlaps(d, o)))) {
    const node = b.addNode('contention', 'CONFLICT', {
      id: `conflict:${name}`, label: `${name}: ${ds.length} drivers`, width: w,
      pins: [...ds.map((_, i) => inPin(`D${i}`, null)), outPin('Y', w)], props: { signal: name },
      explain: `'${name}' is driven from ${ds.length} places. No resolution is modeled; this node only marks the conflict.`,
    });
    ds.forEach((d, i) => b.connect(asPin(d), { node: node.id, pin: `D${i}` }));
    out = { type: 'pin', node: node.id, pin: 'Y', width: w };
  } else if (ds.length === 1 && ds[0].lo === 0 && ds[0].hi === w - 1) out = asPin(ds[0]);
  else {
    const sorted = [...ds].sort((x, y) => y.hi - x.hi);
    const pieces: Source[] = [];
    let cursor = w - 1;
    for (const d of sorted) {
      if (d.hi < cursor) pieces.push(undrivenNode(b, name, cursor, d.hi + 1, false));
      pieces.push(asPin(d));
      cursor = d.lo - 1;
    }
    if (cursor >= 0) pieces.push(undrivenNode(b, name, cursor, 0, false));
    const node = b.addNode('concat', 'CONCAT', {
      label: '{ }', width: w, pins: [...pieces.map((p, i) => inPin(`P${pieces.length - 1 - i}`, p.width)), outPin('Y', w)],
      props: { signal: name, assembledFromDrivers: true },
      explain: `Assembles '${name}' from separately driven bit ranges.`,
    });
    node.drives = name;
    pieces.forEach((p, i) => b.connect(p, { node: node.id, pin: `P${pieces.length - 1 - i}` }));
    out = { type: 'pin', node: node.id, pin: 'Y', width: w };
  }
  b.baseCache.set(name, out);
  return out;
}

export function resolvePending(b: ModelBuilder): void {
  for (let i = 0; i < b.pending.length; i++) {
    const { src, to } = b.pending[i];
    const sig = b.signals.get(src.name);
    if (!sig) {
      if (!b.reported.has(src.name)) {
        b.reported.add(src.name);
        b.diags.error('declaration', `Signal '${src.name}' is used but not declared`, src.loc, { suggestion: `Declare it with wire, reg or logic.` });
      }
      let u = b.baseCache.get(`?${src.name}`);
      if (!u) {
        const node = b.addNode('undriven', 'UNDRIVEN', { id: `undeclared:${src.name}`, label: src.name, pins: [outPin('Y', null)], props: { signal: src.name, undeclared: true }, explain: `'${src.name}' is not declared.` });
        u = { type: 'pin', node: node.id, pin: 'Y', width: null };
        b.baseCache.set(`?${src.name}`, u);
      }
      if (u.type === 'pin') b.link({ node: u.node, pin: u.pin }, to, src.name, null);
      continue;
    }
    if (!src.feedback) sig.readers++;
    const base = baseSource(b, src.name);
    if (base.type === 'pin') b.link({ node: base.node, pin: base.pin }, to, src.name, base.width);
  }
  b.pending.length = 0;
}

export function checkDrivers(b: ModelBuilder): void {
  const d: DiagnosticBag = b.diags;
  for (const sig of b.signals.values()) {
    const ds = b.drivers.filter((x) => x.signal === sig.name);
    const internal = ds.filter((x) => x.origin !== 'input');
    if (sig.dir === 'input' && internal.length) {
      d.error('driver', `Input port '${sig.name}' is driven inside the module`, internal[0].loc, { suggestion: 'Inputs are driven from outside; assign to a separate internal signal.' });
    }
    let reportedMulti = false;
    for (let i = 0; i < ds.length && !reportedMulti; i++) {
      for (let j = i + 1; j < ds.length; j++) {
        if (ds[i].block !== ds[j].block && overlaps(ds[i], ds[j]) && !(sig.dir === 'input')) {
          const lo = Math.max(ds[i].lo, ds[j].lo), hi = Math.min(ds[i].hi, ds[j].hi);
          const bits = sig.width > 1 ? ` (bits [${hi}:${lo}])` : '';
          d.error('driver', `'${sig.name}' has multiple drivers${bits}`, ds[j].loc, {
            explanation: `Also driven at line ${ds[i].loc?.line ?? '?'}. Conflicting drivers produce contention or X in hardware; no resolution is modeled.`,
            suggestion: 'Drive each signal bit from exactly one assign, always block, or instance output.',
          });
          reportedMulti = true;
          break;
        }
      }
    }
    let covered = 0n;
    for (const x of ds) covered |= ((1n << BigInt(x.hi - x.lo + 1)) - 1n) << BigInt(x.lo);
    const full = (1n << BigInt(sig.width)) - 1n;
    const missing = full & ~covered;
    const read = sig.readers > 0 || b.used.has(sig.name);
    if (missing !== 0n && !b.unmodeled.has(sig.name)) {
      let hi = -1, lo = -1;
      for (let i = 0; i < sig.width; i++) if ((missing >> BigInt(i)) & 1n) { if (lo < 0) lo = i; hi = i; }
      const part = missing === full ? '' : ` (bits [${hi}:${lo}])`;
      if (read || sig.dir === 'output') {
        d.warn('connectivity', `Signal '${sig.name}' is never driven${part}`, sig.loc, {
          explanation: 'An undriven signal is floating (high-impedance or unknown) in hardware.',
          suggestion: `Add an assign, always block, or instance output that drives '${sig.name}'.`,
        });
      } else if (sig.dir === null) d.info('connectivity', `Signal '${sig.name}' is declared but never driven or used`, sig.loc);
    }
    if (sig.dir === 'input' && !read) d.info('connectivity', `Input '${sig.name}' is never used`, sig.loc);
    else if (sig.dir === null && missing === 0n && !read) d.info('connectivity', `Signal '${sig.name}' is driven but never used`, sig.loc);
  }
}

/** Structural invariants of a finished model. Returns human-readable problems (empty = consistent). */
export function checkIntegrity(m: ModuleModel): string[] {
  const issues: string[] = [];
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  if (byId.size !== m.nodes.length) issues.push('duplicate node ids');
  const incoming = new Map<string, number>();
  for (const c of m.connections) {
    const f = byId.get(c.from.node), t = byId.get(c.to.node);
    if (!f || !t) { issues.push(`connection ${c.id} references a missing node`); continue; }
    if (f.pins.find((p) => p.name === c.from.pin)?.dir !== 'out') issues.push(`connection ${c.id}: ${f.id}.${c.from.pin} is not an output pin`);
    if (t.pins.find((p) => p.name === c.to.pin)?.dir !== 'in') issues.push(`connection ${c.id}: ${t.id}.${c.to.pin} is not an input pin`);
    const k = `${c.to.node}.${c.to.pin}`;
    incoming.set(k, (incoming.get(k) ?? 0) + 1);
  }
  for (const n of m.nodes) {
    for (const p of n.pins) {
      if (p.dir !== 'in') continue;
      const cnt = incoming.get(`${n.id}.${p.name}`) ?? 0;
      if (cnt > 1) issues.push(`${n.id}.${p.name} has ${cnt} drivers`);
      if (cnt === 0 && n.kind !== 'instance') issues.push(`${n.id}.${p.name} is unconnected`);
    }
  }
  return issues;
}

export interface Trace { nodes: Set<string>; conns: Set<string> }

export function traceCone(conns: Connection[], start: string, dir: 'in' | 'out'): Trace {
  const nodes = new Set<string>([start]);
  const cs = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const c of conns) {
      const next = dir === 'in' ? (c.to.node === cur ? c.from.node : null) : (c.from.node === cur ? c.to.node : null);
      if (next === null) continue;
      cs.add(c.id);
      if (!nodes.has(next)) { nodes.add(next); queue.push(next); }
    }
  }
  return { nodes, conns: cs };
}

const KEEP = new Set(['input', 'output', 'dff', 'instance', 'undriven', 'contention']);

/**
 * Removes anonymous helper nodes that nothing consumes, for example the condition logic or reset value that was
 * absorbed into a flip-flop's reset pin. Nodes that drive a declared signal are always kept.
 */
export function pruneUnusedNodes(b: ModelBuilder): void {
  for (;;) {
    const used = new Set(b.conns.map((c) => c.from.node));
    const dead = new Set(b.nodes.filter((n) => !KEEP.has(n.kind) && !n.drives && !used.has(n.id)).map((n) => n.id));
    if (!dead.size) return;
    b.nodes = b.nodes.filter((n) => !dead.has(n.id));
    b.conns = b.conns.filter((c) => !dead.has(c.to.node));
    b.pending = b.pending.filter((p) => !dead.has(p.to.node));
  }
}
