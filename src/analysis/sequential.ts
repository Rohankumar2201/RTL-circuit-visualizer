import { exprToString } from '../parser/expression-parser';
import type { AlwaysBlock, EdgeRef, Expr, Stmt } from '../parser/types';
import { inPin, outPin, type ModelBuilder, type Pin, type SigSource, type Source } from './hardware-model';
import {
  Unsupported, boolSource, checkTargetKind, collectAssigned, drive, execStmts, handleUnsupported, materialize,
  valText, type Env, type Val,
} from './combinational';
import { evalConst } from './widths';

const RESET_NAME = /rst|reset|clr|clear/i;

function matchResetCond(e: Expr | null): { signal: string; neg: boolean } | null {
  if (!e) return null;
  if (e.k === 'id') return { signal: e.name, neg: false };
  if (e.k === 'unary' && (e.op === '!' || e.op === '~') && e.arg.k === 'id') return { signal: e.arg.name, neg: true };
  return null;
}

function pickClock(edges: EdgeRef[], blk: AlwaysBlock): { clk: EdgeRef; other: EdgeRef | null } {
  if (edges.length === 1) return { clk: edges[0], other: null };
  if (edges.length === 2) {
    const byName = edges.find((e) => /clk|clock/i.test(e.signal));
    const byRst = edges.find((e) => RESET_NAME.test(e.signal) || /set/i.test(e.signal));
    const clk = byName ?? edges.find((e) => e !== byRst) ?? edges[0];
    return { clk, other: edges.find((e) => e !== clk) ?? null };
  }
  throw new Unsupported(`${edges.length} edge events in one sensitivity list; only a clock plus one asynchronous reset is modeled`, blk.loc);
}

export function lowerSeqBlock(b: ModelBuilder, blk: AlwaysBlock, index: number): void {
  if (blk.sens.type !== 'edges') return;
  const block = `always:${index}`;
  const m = b.mark();
  const env: Env = new Map();
  try {
    const { clk, other } = pickClock(blk.sens.edges, blk);
    if (blk.kind === 'always_comb' || blk.kind === 'always_latch') throw new Unsupported(`'${blk.kind}' cannot have an edge-triggered sensitivity list`, blk.loc);
    execStmts({ b, mode: 'seq' }, blk.body, env);
    if (JSON.stringify(blk.body).includes('"nonblocking":false')) {
      b.diags.info('sequential', 'Blocking assignments in a clocked block are modeled as nonblocking (every register captures the previous-cycle value)', blk.loc, {
        suggestion: "Use '<=' for registers in clocked blocks.",
      });
    }
    for (const [name, val] of env) buildRegister(b, name, val, clk, other, blk, block);
  } catch (err) {
    handleUnsupported(b, err, blk.loc);
    b.rollback(m);
    collectAssigned(blk.body).forEach((n) => b.unmodeled.add(n));
  }
}

interface ResetInfo { signal: string; activeLow: boolean; kind: 'async' | 'sync'; valueText: string }

function buildRegister(b: ModelBuilder, name: string, val: Val, clk: EdgeRef, other: EdgeRef | null, blk: AlwaysBlock, block: string): void {
  const sig = b.signals.get(name)!;
  const w = sig.width;
  checkTargetKind(b, name, true, blk.loc);
  let rest: Val = val;
  let reset: ResetInfo | null = null;

  if (val.t === 'mux') {
    const mc = matchResetCond(val.condExpr);
    if (mc && other && mc.signal === other.signal) {
      const wantLow = other.edge === 'negedge';
      let rstBranch: Val | null = null;
      if (!mc.neg && !wantLow) { rstBranch = val.hi; rest = val.lo; }
      else if (mc.neg && wantLow) { rstBranch = val.hi; rest = val.lo; }
      else if (!mc.neg && wantLow) { rstBranch = val.lo; rest = val.hi; }
      if (rstBranch) reset = reset ?? toReset(b, rstBranch, mc.signal, wantLow, 'async', blk);
      else b.diags.warn('sequential', `Condition on '${mc.signal}' does not match its ${other.edge}; not treated as a reset`, blk.loc);
    } else if (mc && !other && RESET_NAME.test(mc.signal)) {
      const first = val.hi;
      if (first.t === 'src' && first.expr && evalConst(first.expr, b.params) !== null) {
        reset = toReset(b, first, mc.signal, mc.neg, 'sync', blk);
        rest = val.lo;
        b.diags.info('sequential', `'${mc.signal}' is treated as a synchronous reset of '${name}' (recognized by its name)`, blk.loc, {
          explanation: 'A synchronous reset takes effect only on a clock edge. The reset is recognized from the signal name and a constant reset value.',
        });
      }
    }
  }
  if (other && !reset) {
    b.diags.warn('sequential', `'${other.signal}' is in the sensitivity list but is not used as a reset for '${name}'`, blk.loc, {
      explanation: 'Only the clock should normally be an edge event unless it is an asynchronous reset or set.',
    });
  }

  const enables: { cond: Source; low: boolean; expr: Expr | null }[] = [];
  const holds = (v: Val): boolean => v.t === 'hold' || (v.t === 'src' && v.s.type === 'sig' && v.s.name === name);
  while (rest.t === 'mux' && holds(rest.hi) !== holds(rest.lo)) {
    if (holds(rest.lo)) { enables.push({ cond: rest.cond, low: false, expr: rest.condExpr }); rest = rest.hi; }
    else { enables.push({ cond: rest.cond, low: true, expr: rest.condExpr }); rest = rest.lo; }
  }

  const q: SigSource = { type: 'sig', name, width: w, loc: blk.loc, feedback: true };
  const d = materialize(b, rest, q, w);
  let en: Source | null = null;
  for (const e of enables) {
    let c = e.cond;
    if (e.low) {
      const n = b.addNode('gate', 'NOT', { label: 'NOT', width: 1, loc: blk.loc, pins: [inPin('A', c.width), outPin('Y', 1)], props: { implicit: true }, explain: 'Inverts the hold condition to form an enable.' });
      b.connect(c, { node: n.id, pin: 'A' });
      c = { type: 'pin', node: n.id, pin: 'Y', width: 1 };
    }
    if (!en) en = c;
    else {
      const n = b.addNode('gate', 'AND', { label: 'AND', width: 1, loc: blk.loc, pins: [inPin('A', 1), inPin('B', 1), outPin('Y', 1)], props: { implicit: true }, explain: 'Combines nested enable conditions.' });
      b.connect(en, { node: n.id, pin: 'A' });
      b.connect(c, { node: n.id, pin: 'B' });
      en = { type: 'pin', node: n.id, pin: 'Y', width: 1 };
    }
  }
  if (en) en = boolSource(b, en, blk.loc);

  const rstPinName = reset ? (reset.activeLow ? 'RSTn' : 'RST') : '';
  const pins: Pin[] = [inPin('D', w), inPin('CLK', 1)];
  if (reset) pins.push(inPin(rstPinName, 1));
  if (en) pins.push(inPin('EN', 1));
  pins.push(outPin('Q', w));
  const enText = enables.length ? enables.map((e) => (e.low ? `!(${exprToString(e.expr!)})` : exprToString(e.expr!))).join(' && ') : '';
  const edgeText = clk.edge === 'posedge' ? 'rising' : 'falling';
  const explain = `Register '${name}' captures ${valText(rest, name)} on the ${edgeText} edge of ${clk.signal}.` +
    (reset ? ` ${reset.kind === 'async' ? 'Asynchronous' : 'Synchronous'} active-${reset.activeLow ? 'low' : 'high'} reset ${reset.signal} forces it to ${reset.valueText}.` : '') +
    (enText ? ` It only updates while ${enText}.` : '');
  const node = b.addNode('dff', 'DFF', {
    id: `reg:${name}`, label: w > 1 ? 'REG' : 'DFF', width: w, loc: blk.loc, pins, sequential: true, explain,
    props: {
      signal: name, clock: clk.signal, edge: clk.edge,
      reset: reset ? { signal: reset.signal, kind: reset.kind, activeLow: reset.activeLow, value: reset.valueText } : null,
      enable: enText || null,
    },
  });
  b.connect(d, { node: node.id, pin: 'D' });
  b.connect({ type: 'sig', name: clk.signal, width: b.signals.get(clk.signal)?.width ?? null, loc: clk.loc }, { node: node.id, pin: 'CLK' });
  if (reset) b.connect({ type: 'sig', name: reset.signal, width: b.signals.get(reset.signal)?.width ?? null, loc: blk.loc }, { node: node.id, pin: rstPinName });
  if (en) b.connect(en, { node: node.id, pin: 'EN' });
  b.markUsed(clk.signal);
  drive(b, name, { type: 'pin', node: node.id, pin: 'Q', width: w }, 0, w - 1, 'seq', block, blk.loc);
}

function toReset(b: ModelBuilder, branch: Val, signal: string, activeLow: boolean, kind: 'async' | 'sync', blk: AlwaysBlock): ResetInfo {
  if (branch.t !== 'src' || !branch.expr || evalConst(branch.expr, b.params) === null) {
    throw new Unsupported(`Reset value of a register is not a constant (${valText(branch, '?')})`, blk.loc, 'Reset registers to a constant value.', 'sequential');
  }
  return { signal, activeLow, kind, valueText: exprToString(branch.expr) };
}
