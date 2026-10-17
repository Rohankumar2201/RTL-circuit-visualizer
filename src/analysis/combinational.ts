import { exprToString, parseNumber } from '../parser/expression-parser';
import type { Category, Severity } from '../parser/diagnostics';
import type { AlwaysBlock, Expr, Loc, Stmt } from '../parser/types';
import {
  ModelBuilder, inPin, outPin, type NodeKind, type SigSource, type Source,
} from './hardware-model';
import { bitPos, evalConst, isContextual, rangeLabel, selfWidth, type Range } from './widths';
import { registerDriver } from './connectivity';

export class Unsupported extends Error {
  constructor(msg: string, readonly loc: Loc | null, readonly suggestion?: string, readonly category: Category = 'unsupported', readonly severity: Severity = 'warning') {
    super(msg);
  }
}

export type Val =
  | { t: 'src'; s: Source; expr: Expr | null }
  | { t: 'hold' }
  | { t: 'mux'; cond: Source; condExpr: Expr | null; hi: Val; lo: Val; loc: Loc; why: string; cache?: Source }
  | { t: 'muxn'; sel: Source; inputs: Val[]; loc: Loc; why: string; cache?: Source };
export type Env = Map<string, Val>;
export const HOLD: Val = { t: 'hold' };

const GATE: Record<string, string> = { '&': 'AND', '|': 'OR', '^': 'XOR', '~^': 'XNOR', '^~': 'XNOR' };
const NEGATED: Record<string, string> = { AND: 'NAND', OR: 'NOR', XOR: 'XNOR' };
const LOGIC: Record<string, string> = { '&&': 'AND', '||': 'OR' };
const CMP: Record<string, string> = { '==': 'EQ', '!=': 'NE', '===': 'EQ', '!==': 'NE', '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE' };
const CMP_SYM: Record<string, string> = { EQ: '==', NE: '!=', LT: '<', LE: '<=', GT: '>', GE: '>=' };
const ARITH: Record<string, string> = { '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD', '**': 'POW' };
const ARITH_SYM: Record<string, string> = { ADD: '+', SUB: '-', MUL: '*', DIV: '/', MOD: '%', POW: '**', NEG: '-' };
const SHIFT: Record<string, string> = { '<<': 'SHL', '>>': 'SHR', '<<<': 'SHL', '>>>': 'SAR' };
const SHIFT_SYM: Record<string, string> = { SHL: '<<', SHR: '>>', SAR: '>>>' };
const REDUCE: Record<string, string> = { '&': 'RAND', '|': 'ROR', '^': 'RXOR', '~&': 'RNAND', '~|': 'RNOR', '~^': 'RXNOR', '^~': 'RXNOR' };
const REDUCE_SYM: Record<string, string> = { RAND: '&', ROR: '|', RXOR: '^', RNAND: '~&', RNOR: '~|', RXNOR: '~^' };

const wctx = (b: ModelBuilder) => ({ widthOf: (n: string) => b.signals.get(n)?.width ?? null, env: b.params });
const max2 = (a: number | null, c: number | null): number | null => (a === null ? c : c === null ? a : Math.max(a, c));

function make(
  b: ModelBuilder, kind: NodeKind, op: string, label: string, args: Source[], names: string[],
  width: number | null, loc: Loc | null, props: Record<string, unknown> = {}, explain = '',
): Source {
  const node = b.addNode(kind, op, { label, width, loc, props, explain, pins: [...args.map((a, i) => inPin(names[i], a.width)), outPin('Y', width)] });
  args.forEach((a, i) => b.connect(a, { node: node.id, pin: names[i] }));
  return { type: 'pin', node: node.id, pin: 'Y', width };
}

export function sliceNode(b: ModelBuilder, base: Source, lo: number, hi: number, label: string, loc: Loc | null): Source {
  const w = hi - lo + 1;
  if (base.width !== null && lo === 0 && hi === base.width - 1) return base;
  return make(b, 'slice', 'SLICE', label, [base], ['A'], w, loc, { lo, hi }, `Selects ${label} of the input bus.`);
}

function constSource(b: ModelBuilder, text: string, width: number | null, value: bigint | null, loc: Loc | null, name?: string): Source {
  const node = b.addNode('const', 'CONST', {
    label: name ?? text, width, loc, pins: [outPin('Y', width)], props: { text, value: value === null ? null : value.toString(), name },
    explain: `Constant ${name ? `${name} = ` : ''}${text}.`,
  });
  return { type: 'pin', node: node.id, pin: 'Y', width };
}

export function boolSource(b: ModelBuilder, s: Source, loc: Loc | null): Source {
  if (s.width !== null && s.width > 1) return make(b, 'reduce', 'ROR', '|', [s], ['A'], 1, loc, { implicit: true }, 'Reduces a multi-bit condition to true/false (any bit set).');
  return s;
}

export function buildExpr(b: ModelBuilder, e: Expr, ctx: number | null, env: Env | null): Source {
  const ew = (x: Expr): number | null => selfWidth(x, wctx(b));
  const text = exprToString(e);
  switch (e.k) {
    case 'num': {
      const n = parseNumber(e.text);
      return constSource(b, e.text, n.width, n.value, e.loc);
    }
    case 'id': {
      const v = env?.get(e.name);
      if (v && definite(v)) return materialize(b, v, null, null);
      const pv = b.params.get(e.name);
      if (pv !== undefined) return constSource(b, pv.toString(), null, pv, e.loc, e.name);
      b.markUsed(e.name);
      return { type: 'sig', name: e.name, width: b.signals.get(e.name)?.width ?? null, loc: e.loc };
    }
    case 'index': return buildIndex(b, e, env);
    case 'unary': {
      if (e.op === '+') return buildExpr(b, e.arg, ctx, env);
      if (e.op === '~') {
        const a = buildExpr(b, e.arg, ctx, env);
        const last = b.nodes[b.nodes.length - 1];
        if (e.arg.k === 'binary' && a.type === 'pin' && last && last.id === a.node && last.kind === 'gate' && !last.props.logical && !last.props.negated && NEGATED[last.op]) {
          last.op = NEGATED[last.op]; last.label = last.op; last.props.negated = true; last.props.expr = text;
          last.explain = `${last.op} of ${exprToString(e.arg.l)} and ${exprToString(e.arg.r)}.`;
          return a;
        }
        return make(b, 'gate', 'NOT', 'NOT', [a], ['A'], max2(ew(e.arg), ctx), e.loc, { expr: text }, `Inverts ${exprToString(e.arg)}.`);
      }
      if (e.op === '!') {
        const a = buildExpr(b, e.arg, null, env);
        return make(b, 'gate', 'NOT', '!', [a], ['A'], 1, e.loc, { logical: true, expr: text }, `Logical NOT of ${exprToString(e.arg)}.`);
      }
      if (e.op === '-') {
        const a = buildExpr(b, e.arg, ctx, env);
        return make(b, 'arith', 'NEG', '-', [a], ['A'], max2(ew(e.arg), ctx), e.loc, { expr: text }, `Two's complement negation of ${exprToString(e.arg)}.`);
      }
      const rop = REDUCE[e.op];
      const a = buildExpr(b, e.arg, null, env);
      return make(b, 'reduce', rop, REDUCE_SYM[rop], [a], ['A'], 1, e.loc, { expr: text }, `Reduction ${rop.slice(1)} of all bits of ${exprToString(e.arg)}.`);
    }
    case 'binary': {
      const op = e.op;
      if (GATE[op]) {
        const w = max2(ew(e), ctx);
        const a = buildExpr(b, e.l, w, env), c = buildExpr(b, e.r, w, env);
        return make(b, 'gate', GATE[op], GATE[op], [a, c], ['A', 'B'], w, e.loc, { expr: text }, `Bitwise ${GATE[op]} of ${exprToString(e.l)} and ${exprToString(e.r)}.`);
      }
      if (LOGIC[op]) {
        const a = boolSource(b, buildExpr(b, e.l, null, env), e.loc), c = boolSource(b, buildExpr(b, e.r, null, env), e.loc);
        return make(b, 'gate', LOGIC[op], op, [a, c], ['A', 'B'], 1, e.loc, { logical: true, expr: text }, `Logical ${LOGIC[op]} of two conditions.`);
      }
      if (CMP[op]) {
        const cw = max2(ew(e.l), ew(e.r));
        const a = buildExpr(b, e.l, cw, env), c = buildExpr(b, e.r, cw, env);
        if (op === '===' || op === '!==') b.diags.warn('unsupported', `'${op}' is modeled as '${op.slice(0, 2)}' (X/Z matching is not modeled)`, e.loc);
        return make(b, 'cmp', CMP[op], CMP_SYM[CMP[op]], [a, c], ['A', 'B'], 1, e.loc, { expr: text }, `Compares ${exprToString(e.l)} ${op} ${exprToString(e.r)}.`);
      }
      if (ARITH[op]) {
        const w = max2(ew(e), ctx);
        const a = buildExpr(b, e.l, w, env), c = buildExpr(b, e.r, op === '**' ? null : w, env);
        return make(b, 'arith', ARITH[op], ARITH_SYM[ARITH[op]], [a, c], ['A', 'B'], w, e.loc, { expr: text }, `${ARITH[op]} of ${exprToString(e.l)} and ${exprToString(e.r)}.`);
      }
      if (SHIFT[op]) {
        const w = max2(ew(e.l), ctx);
        const a = buildExpr(b, e.l, w, env), c = buildExpr(b, e.r, null, env);
        return make(b, 'shift', SHIFT[op], SHIFT_SYM[SHIFT[op]], [a, c], ['A', 'SH'], w, e.loc, { expr: text }, `Shifts ${exprToString(e.l)} by ${exprToString(e.r)} (${SHIFT[op]}).`);
      }
      throw new Unsupported(`Operator '${op}' is not supported`, e.loc);
    }
    case 'ternary': {
      const w = max2(ew(e), ctx);
      const sel = boolSource(b, buildExpr(b, e.c, null, env), e.loc);
      const a = buildExpr(b, e.a, w, env), c = buildExpr(b, e.b, w, env);
      return make(b, 'mux', 'MUX', 'MUX', [c, a, sel], ['D0', 'D1', 'S'], w, e.loc, { expr: text, origin: 'ternary' },
        `2:1 mux inferred from the ?: operator: selects ${exprToString(e.a)} when ${exprToString(e.c)} is true, otherwise ${exprToString(e.b)}.`);
    }
    case 'concat': return buildConcat(b, e.parts, 1, e.loc, env, text);
    case 'repl': {
      const n = evalConst(e.count, b.params);
      if (n === null || n < 1n || n > 1024n) throw new Unsupported('Replication count must be a constant between 1 and 1024', e.loc);
      return buildConcat(b, e.parts, Number(n), e.loc, env, text);
    }
    case 'call': {
      const v = evalConst(e, b.params);
      if (v === null) throw new Unsupported(`System function '${e.name}' is only supported on constants ($clog2)`, e.loc);
      return constSource(b, v.toString(), null, v, e.loc);
    }
  }
}

function buildConcat(b: ModelBuilder, parts: Expr[], times: number, loc: Loc, env: Env | null, text: string): Source {
  const srcs: Source[] = [];
  for (let t = 0; t < times; t++) for (const p of parts) {
    const w = selfWidth(p, wctx(b));
    if (w === null) throw new Unsupported('Concatenation operands need a known width (use sized literals)', p.loc, "Write constants as sized literals, e.g. 4'd3.");
    srcs.push(buildExpr(b, p, w, env));
  }
  const names = srcs.map((_, i) => `P${srcs.length - 1 - i}`);
  const width = srcs.reduce((s, x) => s + (x.width ?? 0), 0);
  return make(b, 'concat', 'CONCAT', '{ }', srcs, names, width, loc, { expr: text }, `Concatenates ${srcs.length} part(s), most significant first.`);
}

function buildIndex(b: ModelBuilder, e: Extract<Expr, { k: 'index' }>, env: Env | null): Source {
  const sig = b.signals.get(e.base);
  if (!sig) return { type: 'sig', name: e.base, width: null, loc: e.loc };
  b.markUsed(e.base);
  const whole: SigSource = { type: 'sig', name: e.base, width: sig.width, loc: e.loc };
  const m = evalConst(e.msb, b.params);
  if (!e.lsb) {
    if (m === null) {
      const idx = buildExpr(b, e.msb, null, env);
      const node = b.addNode('slice', 'DYNSEL', {
        label: '[ ]', width: 1, loc: e.loc, pins: [inPin('A', sig.width), inPin('IDX', idx.width), outPin('Y', 1)],
        props: { expr: exprToString(e), dynamic: true }, explain: `Selects one bit of ${e.base} using a run-time index (a ${sig.width}:1 multiplexer).`,
      });
      b.connect(whole, { node: node.id, pin: 'A' });
      b.connect(idx, { node: node.id, pin: 'IDX' });
      return { type: 'pin', node: node.id, pin: 'Y', width: 1 };
    }
    const p = bitPos(sig.range, Number(m));
    if (p === null) throw new Unsupported(`Bit-select ${e.base}[${m}] is outside the declared range ${rangeLabel(sig.range)}`, e.loc, undefined, 'width', 'error');
    return sliceNode(b, whole, p, p, `[${m}]`, e.loc);
  }
  const l = evalConst(e.lsb, b.params);
  if (m === null || l === null) throw new Unsupported(`Part-select of ${e.base} needs constant bounds`, e.loc);
  const p1 = bitPos(sig.range, Number(m)), p2 = bitPos(sig.range, Number(l));
  if (p1 === null || p2 === null) throw new Unsupported(`Part-select ${e.base}[${m}:${l}] is outside the declared range ${rangeLabel(sig.range)}`, e.loc, undefined, 'width', 'error');
  if ((p1 >= p2) !== (Number(m) >= Number(l)) || (Number(m) >= Number(l)) !== (sig.range.msb >= sig.range.lsb)) {
    b.diags.warn('width', `Part-select ${e.base}[${m}:${l}] has the opposite direction of the declaration ${rangeLabel(sig.range)}`, e.loc);
  }
  return sliceNode(b, whole, Math.min(p1, p2), Math.max(p1, p2), `[${m}:${l}]`, e.loc);
}

export function definite(v: Val): boolean {
  switch (v.t) {
    case 'src': return true;
    case 'hold': return false;
    case 'mux': return definite(v.hi) && definite(v.lo);
    case 'muxn': return v.inputs.every(definite);
  }
}
export function containsHold(v: Val): boolean { return !definite(v); }

export function valText(v: Val, self: string, depth = 0): string {
  if (depth > 4) return '…';
  switch (v.t) {
    case 'src': return v.expr ? exprToString(v.expr) : 'value';
    case 'hold': return self;
    case 'mux': return `${v.condExpr ? exprToString(v.condExpr) : 'cond'} ? ${valText(v.hi, self, depth + 1)} : ${valText(v.lo, self, depth + 1)}`;
    case 'muxn': return `case-select(${v.inputs.length} values)`;
  }
}

export function materialize(b: ModelBuilder, v: Val, hold: Source | null, width: number | null): Source {
  switch (v.t) {
    case 'src': return v.s;
    case 'hold':
      if (!hold) throw new Unsupported('Internal error: value holds without a feedback path', null);
      return hold;
    case 'mux': {
      if (v.cache) return v.cache;
      const lo = materialize(b, v.lo, hold, width), hi = materialize(b, v.hi, hold, width);
      const latch = containsHold(v);
      v.cache = make(b, 'mux', 'MUX', 'MUX', [lo, hi, v.cond], ['D0', 'D1', 'S'], width, v.loc,
        { origin: 'if', feedback: latch, expr: valText(v, 'hold') }, v.why);
      return v.cache;
    }
    case 'muxn': {
      if (v.cache) return v.cache;
      const ins = v.inputs.map((x) => materialize(b, x, hold, width));
      const names = ins.map((_, i) => `D${i}`);
      v.cache = make(b, 'mux', 'MUX', 'MUX', [...ins, v.sel], [...names, 'S'], width, v.loc,
        { origin: 'case', inputs: ins.length, feedback: containsHold(v) }, v.why);
      return v.cache;
    }
  }
}

/** Creates the driver for `name` from `src`, inserting a buffer when the source is a plain signal alias. */
export function drive(b: ModelBuilder, name: string, src: Source, lo: number, hi: number, origin: 'assign' | 'comb' | 'seq' | 'instance', block: string, loc: Loc | null): void {
  let pin = src;
  if (pin.type === 'sig') {
    pin = make(b, 'buf', 'BUF', 'BUF', [pin], ['A'], hi - lo + 1, loc, {}, `Buffer: '${name}' is a direct copy of ${pin.name}.`);
  }
  if (pin.type === 'pin') registerDriver(b, name, pin, lo, hi, origin, block, loc);
}

export interface Target { name: string; lo: number; hi: number; width: number }

/** Resolves an lvalue (id, constant select, or concatenation of those) to signal bit ranges, MSB first. */
export function lvalueTargets(b: ModelBuilder, e: Expr, allowPartial: boolean): Target[] {
  if (e.k === 'concat') return e.parts.flatMap((p) => lvalueTargets(b, p, allowPartial));
  if (e.k === 'id') {
    const s = b.signals.get(e.name);
    if (!s) throw new Unsupported(`Assignment to undeclared signal '${e.name}'`, e.loc, 'Declare it with wire, reg or logic.', 'declaration', 'error');
    return [{ name: e.name, lo: 0, hi: s.width - 1, width: s.width }];
  }
  if (e.k === 'index') {
    if (!allowPartial) throw new Unsupported('Assigning to a bit or part of a vector inside a procedural block is not modeled yet', e.loc, 'Assign the whole vector, e.g. build the value with a concatenation.');
    const s = b.signals.get(e.base);
    if (!s) throw new Unsupported(`Assignment to undeclared signal '${e.base}'`, e.loc, undefined, 'declaration', 'error');
    const m = evalConst(e.msb, b.params), l = e.lsb ? evalConst(e.lsb, b.params) : m;
    if (m === null || l === null) throw new Unsupported('Assignment targets need constant bit indices', e.loc);
    const p1 = bitPos(s.range, Number(m)), p2 = bitPos(s.range, Number(l));
    if (p1 === null || p2 === null) throw new Unsupported(`Select on '${e.base}' is outside the declared range ${rangeLabel(s.range)}`, e.loc, undefined, 'width', 'error');
    const lo = Math.min(p1, p2), hi = Math.max(p1, p2);
    return [{ name: e.base, lo, hi, width: hi - lo + 1 }];
  }
  throw new Unsupported('Unsupported assignment target', e.loc);
}

const rangeText = (r: Range): string => rangeLabel(r);

export function checkTargetKind(b: ModelBuilder, name: string, procedural: boolean, loc: Loc | null): void {
  const s = b.signals.get(name);
  if (!s) return;
  const key = `kind:${name}:${procedural}`;
  if (b.reported.has(key)) return;
  if (procedural && s.kind === 'wire' && s.dir !== 'input') {
    b.reported.add(key);
    b.diags.error('declaration', `'${name}' is a wire but is assigned in a procedural block`, loc, { suggestion: `Declare '${name}' as reg or logic (for example: output reg ${name}).` });
  } else if (!procedural && s.kind === 'reg') {
    b.reported.add(key);
    b.diags.error('declaration', `'${name}' is a reg but is driven by a continuous assign`, loc, { suggestion: `Declare '${name}' as wire or logic, or drive it from an always block.` });
  }
}

export function checkAssignWidth(b: ModelBuilder, name: string, lhsW: number | null, rhs: Expr, loc: Loc): void {
  if (lhsW === null) return;
  if (rhs.k === 'num') {
    const n = parseNumber(rhs.text);
    if (n.truncated) b.diags.warn('width', `Literal ${rhs.text} does not fit in its declared size`, rhs.loc);
    if (n.width === null && n.value !== null && n.value >= (1n << BigInt(lhsW))) b.diags.warn('width', `Constant ${rhs.text} does not fit in ${lhsW}-bit '${name}'`, loc);
  }
  const sw = selfWidth(rhs, wctx(b));
  if (sw === null) return;
  if (sw > lhsW) b.diags.warn('width', `Width mismatch: ${sw}-bit value assigned to ${lhsW}-bit '${name}' (upper ${sw - lhsW} bit(s) are dropped)`, loc, { suggestion: 'Select the intended bits explicitly or widen the target.' });
  else if (sw < lhsW && !isContextual(rhs)) b.diags.info('width', `${sw}-bit value is zero-extended to ${lhsW}-bit '${name}'`, loc);
}

export function handleUnsupported(b: ModelBuilder, err: unknown, fallback: Loc | null): void {
  if (!(err instanceof Unsupported)) throw err;
  b.diags.add(err.severity, err.category, err.message, err.loc ?? fallback, { suggestion: err.suggestion });
  b.partial = true;
}

export function collectAssigned(stmts: Stmt[], out: Set<string> = new Set()): Set<string> {
  const lhs = (e: Expr): void => {
    if (e.k === 'id') out.add(e.name);
    else if (e.k === 'index') out.add(e.base);
    else if (e.k === 'concat') e.parts.forEach(lhs);
  };
  for (const s of stmts) {
    if (s.k === 'assign') lhs(s.lhs);
    else if (s.k === 'if') { collectAssigned(s.then, out); if (s.else) collectAssigned(s.else, out); }
    else s.items.forEach((it) => collectAssigned(it.body, out));
  }
  return out;
}

export interface ExecCtx { b: ModelBuilder; mode: 'comb' | 'seq' }

export function execStmts(x: ExecCtx, stmts: Stmt[], env: Env): void {
  for (const s of stmts) execStmt(x, s, env);
}

function execStmt(x: ExecCtx, s: Stmt, env: Env): void {
  const b = x.b;
  const readEnv = x.mode === 'comb' ? env : null;
  if (s.k === 'assign') {
    const targets = lvalueTargets(b, s.lhs, false);
    const total = targets.reduce((a, t) => a + t.width, 0);
    targets.forEach((t) => checkTargetKind(b, t.name, true, s.loc));
    const rhs = buildExpr(b, s.rhs, total, readEnv);
    checkAssignWidth(b, targets.map((t) => t.name).join(','), total, s.rhs, s.loc);
    if (targets.length === 1) { env.set(targets[0].name, { t: 'src', s: rhs, expr: s.rhs }); return; }
    let hi = total - 1;
    for (const t of targets) {
      const lo = hi - t.width + 1;
      env.set(t.name, { t: 'src', s: sliceNode(b, rhs, lo, hi, `[${hi}:${lo}]`, s.loc), expr: null });
      hi = lo - 1;
    }
    return;
  }
  if (s.k === 'if') {
    const cond = boolSource(b, buildExpr(b, s.cond, null, readEnv), s.loc);
    const tEnv: Env = new Map(env), eEnv: Env = new Map(env);
    execStmts(x, s.then, tEnv);
    if (s.else) execStmts(x, s.else, eEnv);
    const names = new Set([...tEnv.keys(), ...eEnv.keys()]);
    for (const name of names) {
      const tv = tEnv.get(name), ev = eEnv.get(name);
      if (tv === ev) { if (tv) env.set(name, tv); continue; }
      env.set(name, {
        t: 'mux', cond, condExpr: s.cond, hi: tv ?? HOLD, lo: ev ?? HOLD, loc: s.loc,
        why: `2:1 mux inferred from if/else at line ${s.loc.line}: '${name}' takes the 'if' value when ${exprToString(s.cond)} is true, otherwise the 'else' value${s.else ? '' : ' (or keeps its previous value)'}.`,
      });
    }
    return;
  }
  execCase(x, s, env, readEnv);
}

function execCase(x: ExecCtx, s: Extract<Stmt, { k: 'case' }>, env: Env, readEnv: Env | null): void {
  const b = x.b;
  const defaults = s.items.filter((i) => i.labels === null);
  if (defaults.length > 1) throw new Unsupported('Multiple default branches in one case statement', s.loc);
  const sel = buildExpr(b, s.sel, null, readEnv);
  const selW = selfWidth(s.sel, wctx(b));
  const bodies = s.items.map((it) => { const m: Env = new Map(env); execStmts(x, it.body, m); return m; });
  const names = new Set<string>();
  bodies.forEach((m) => m.forEach((v, k) => { if (v !== env.get(k)) names.add(k); }));
  const labels = s.items.map((it) => it.labels?.map((l) => {
    if (l.k === 'num' && parseNumber(l.text).hasXZ) throw new Unsupported(`${s.kind} labels with x/z/? wildcards are not modeled`, l.loc, 'Use a plain case with fully specified labels.');
    return evalConst(l, b.params);
  }));
  const defIdx = s.items.findIndex((i) => i.labels === null);
  const allConst = labels.every((l) => !l || l.every((v) => v !== null));
  const why = (n: string): string => `Case select inferred from case at line ${s.loc.line}: '${n}' is chosen by ${exprToString(s.sel)}.`;
  const baseOf = (n: string): Val => env.get(n) ?? HOLD;

  if (allConst && selW !== null && selW >= 1 && selW <= 4) {
    const size = 1 << selW;
    const byValue = new Map<number, number>();
    s.items.forEach((it, i) => it.labels?.forEach((_, j) => {
      const v = Number(labels[i]![j]);
      if (v < 0 || v >= size) { b.diags.warn('width', `Case label ${v} does not fit the ${selW}-bit selector`, it.loc); return; }
      if (byValue.has(v)) b.diags.warn('width', `Case label ${v} appears more than once; the first match wins`, it.loc);
      else byValue.set(v, i);
    }));
    for (const n of names) {
      const inputs: Val[] = [];
      for (let v = 0; v < size; v++) {
        const idx = byValue.get(v) ?? defIdx;
        inputs.push(idx >= 0 ? (bodies[idx].get(n) ?? HOLD) : baseOf(n));
      }
      env.set(n, inputs.every((i) => i === inputs[0]) ? inputs[0] : { t: 'muxn', sel, inputs, loc: s.loc, why: why(n) });
    }
    return;
  }

  const matchCache = new Map<number, Source>();
  const match = (i: number): Source => {
    let m = matchCache.get(i);
    if (m) return m;
    const eqs = s.items[i].labels!.map((l) => make(b, 'cmp', 'EQ', '==', [sel, buildExpr(b, l, selW, null)], ['A', 'B'], 1, l.loc, { expr: `${exprToString(s.sel)} == ${exprToString(l)}` }, `Matches case label ${exprToString(l)}.`));
    m = eqs.reduce((acc, e) => make(b, 'gate', 'OR', '||', [acc, e], ['A', 'B'], 1, s.loc, { logical: true }, 'Any of the case labels matches.'));
    matchCache.set(i, m);
    return m;
  };
  for (const n of names) {
    let result: Val = defIdx >= 0 ? (bodies[defIdx].get(n) ?? HOLD) : baseOf(n);
    for (let i = s.items.length - 1; i >= 0; i--) {
      if (i === defIdx) continue;
      const v = bodies[i].get(n) ?? HOLD;
      if (v === result) continue;
      result = { t: 'mux', cond: match(i), condExpr: { k: 'binary', op: '==', l: s.sel, r: s.items[i].labels![0], loc: s.loc }, hi: v, lo: result, loc: s.items[i].loc, why: why(n) + ' Evaluated as a priority chain of comparators because the labels are not a dense constant range.' };
    }
    env.set(n, result);
  }
}

let blockCounter = 0;
export const nextBlockId = (prefix: string): string => `${prefix}#${++blockCounter}`;

export function lowerContinuous(b: ModelBuilder): void {
  const items = [
    ...b.ast.nets.filter((n) => n.init).map((n) => ({ lhs: { k: 'id', name: n.name, loc: n.loc } as Expr, rhs: n.init!, loc: n.loc })),
    ...b.ast.assigns,
  ];
  items.forEach((a, i) => {
    const m = b.mark();
    const block = `assign:${i}`;
    try {
      const targets = lvalueTargets(b, a.lhs, true);
      const total = targets.reduce((s, t) => s + t.width, 0);
      targets.forEach((t) => checkTargetKind(b, t.name, false, a.loc));
      const rhs = buildExpr(b, a.rhs, total, null);
      checkAssignWidth(b, targets.map((t) => t.name).join(','), total, a.rhs, a.loc);
      let hi = total - 1;
      for (const t of targets) {
        const lo = hi - t.width + 1;
        const part = targets.length === 1 ? rhs : sliceNode(b, rhs, lo, hi, `[${hi}:${lo}]`, a.loc);
        drive(b, t.name, part, t.lo, t.hi, 'assign', block, a.loc);
        hi = lo - 1;
      }
    } catch (err) {
      handleUnsupported(b, err, a.loc);
      b.rollback(m);
      collectLhsNames(a.lhs).forEach((n) => b.unmodeled.add(n));
    }
  });
}

function collectLhsNames(e: Expr): string[] {
  if (e.k === 'id') return [e.name];
  if (e.k === 'index') return [e.base];
  if (e.k === 'concat') return e.parts.flatMap(collectLhsNames);
  return [];
}

export function lowerCombBlock(b: ModelBuilder, blk: AlwaysBlock, index: number): void {
  const block = `always:${index}`;
  const m = b.mark();
  const env: Env = new Map();
  try {
    if (blk.kind === 'always_ff') throw new Unsupported("'always_ff' needs an edge-triggered sensitivity list", blk.loc);
    execStmts({ b, mode: 'comb' }, blk.body, env);
    const nb = JSON.stringify(blk.body).includes('"nonblocking":true');
    if (nb) b.diags.info('sequential', 'Nonblocking assignments in a combinational block are treated like blocking assignments', blk.loc);
    for (const [name, val] of env) {
      const sig = b.signals.get(name)!;
      const holdSrc: SigSource = { type: 'sig', name, width: sig.width, loc: blk.loc, feedback: true };
      if (containsHold(val)) {
        b.diags.add(blk.kind === 'always_latch' ? 'info' : 'warning', 'latch',
          `Latch inferred for '${name}': it is not assigned on every path through the block`, blk.loc, {
            explanation: `When no branch assigns '${name}', combinational logic must keep its old value, which requires storage. The diagram shows this as a mux whose output feeds back into itself.`,
            suggestion: `Assign '${name}' a default value at the top of the block, or add an else/default branch.`,
          });
      }
      const src = materialize(b, val, holdSrc, sig.width);
      drive(b, name, src, 0, sig.width - 1, 'comb', block, blk.loc);
    }
  } catch (err) {
    handleUnsupported(b, err, blk.loc);
    b.rollback(m);
    collectAssigned(blk.body).forEach((n) => b.unmodeled.add(n));
  }
}
