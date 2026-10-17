import { parseNumber } from '../parser/expression-parser';
import type { Expr, ParamDecl } from '../parser/types';
import type { DiagnosticBag } from '../parser/diagnostics';

export interface Range { msb: number; lsb: number }
export type ConstEnv = Map<string, bigint>;

export const rangeWidth = (r: Range): number => Math.abs(r.msb - r.lsb) + 1;
export const rangeLabel = (r: Range): string => `[${r.msb}:${r.lsb}]`;
/** Normalized bit position (0 = LSB) of a declared index, or null when outside the range. */
export function bitPos(r: Range, idx: number): number | null {
  const lo = Math.min(r.msb, r.lsb), hi = Math.max(r.msb, r.lsb);
  if (idx < lo || idx > hi) return null;
  return Math.abs(idx - r.lsb);
}

/** Value and width of a constant built only from sized literals, concatenations and replications. */
function constBits(e: Expr, env: ConstEnv): { v: bigint; w: number } | null {
  if (e.k === 'num') {
    const n = parseNumber(e.text);
    return n.width !== null && n.value !== null ? { v: n.value, w: n.width } : null;
  }
  if (e.k === 'concat' || e.k === 'repl') {
    let times = 1;
    if (e.k === 'repl') {
      const c = evalConst(e.count, env);
      if (c === null || c < 0n || c > 4096n) return null;
      times = Number(c);
    }
    let v = 0n, w = 0;
    for (let t = 0; t < times; t++) {
      for (const p of e.parts) {
        const b = constBits(p, env);
        if (!b) return null;
        v = (v << BigInt(b.w)) | b.v;
        w += b.w;
      }
    }
    return { v, w };
  }
  return null;
}

export function evalConst(e: Expr, env: ConstEnv): bigint | null {
  switch (e.k) {
    case 'concat': case 'repl': return constBits(e, env)?.v ?? null;
    case 'num': return parseNumber(e.text).value;
    case 'id': return env.get(e.name) ?? null;
    case 'unary': {
      const v = evalConst(e.arg, env);
      if (v === null) return null;
      if (e.op === '-') return -v;
      if (e.op === '+') return v;
      if (e.op === '!') return v === 0n ? 1n : 0n;
      return null;
    }
    case 'binary': {
      const a = evalConst(e.l, env), b = evalConst(e.r, env);
      if (a === null || b === null) return null;
      switch (e.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0n ? null : a / b;
        case '%': return b === 0n ? null : a % b;
        case '**': return b < 0n || b > 256n ? null : a ** b;
        case '<<': case '<<<': return b < 0n || b > 1024n ? null : a << b;
        case '>>': case '>>>': return b < 0n || b > 1024n ? null : a >> b;
        case '&': return a & b;
        case '|': return a | b;
        case '^': return a ^ b;
        case '==': return a === b ? 1n : 0n;
        case '!=': return a !== b ? 1n : 0n;
        case '<': return a < b ? 1n : 0n;
        case '<=': return a <= b ? 1n : 0n;
        case '>': return a > b ? 1n : 0n;
        case '>=': return a >= b ? 1n : 0n;
        case '&&': return a !== 0n && b !== 0n ? 1n : 0n;
        case '||': return a !== 0n || b !== 0n ? 1n : 0n;
        default: return null;
      }
    }
    case 'ternary': {
      const c = evalConst(e.c, env);
      return c === null ? null : evalConst(c !== 0n ? e.a : e.b, env);
    }
    case 'call': {
      if (e.name !== '$clog2' || e.args.length !== 1) return null;
      const v = evalConst(e.args[0], env);
      if (v === null) return null;
      let r = 0n, x = v - 1n;
      while (x > 0n) { x >>= 1n; r++; }
      return v <= 1n ? 0n : r;
    }
    default: return null;
  }
}

/** Evaluates parameters in declaration order; overrides replace non-local defaults. */
export function evalParams(params: ParamDecl[], overrides: ConstEnv, diags?: DiagnosticBag): ConstEnv {
  const env: ConstEnv = new Map();
  for (const p of params) {
    const ov = !p.local ? overrides.get(p.name) : undefined;
    const v = ov !== undefined ? ov : evalConst(p.value, env);
    if (v === null) diags?.error('declaration', `Parameter '${p.name}' is not a constant expression`, p.loc);
    else env.set(p.name, v);
  }
  return env;
}

export interface WidthCtx { widthOf: (name: string) => number | null; env: ConstEnv }
const BOOL_OPS = new Set(['==', '!=', '===', '!==', '<', '<=', '>', '>=', '&&', '||']);
const REDUCE = new Set(['!', '&', '|', '^', '~&', '~|', '~^', '^~']);

const maxKnown = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/** Self-determined width; null means unknown or flexible (unsized constants). */
export function selfWidth(e: Expr, c: WidthCtx): number | null {
  switch (e.k) {
    case 'num': return parseNumber(e.text).width;
    case 'id': return c.env.has(e.name) ? null : c.widthOf(e.name);
    case 'index': {
      if (!e.lsb) return 1;
      const m = evalConst(e.msb, c.env), l = evalConst(e.lsb, c.env);
      return m === null || l === null ? null : Math.abs(Number(m - l)) + 1;
    }
    case 'unary': return REDUCE.has(e.op) ? 1 : selfWidth(e.arg, c);
    case 'binary':
      if (BOOL_OPS.has(e.op)) return 1;
      if (e.op === '<<' || e.op === '>>' || e.op === '<<<' || e.op === '>>>' || e.op === '**') return selfWidth(e.l, c);
      return maxKnown(selfWidth(e.l, c), selfWidth(e.r, c));
    case 'ternary': return maxKnown(selfWidth(e.a, c), selfWidth(e.b, c));
    case 'concat': {
      let t = 0;
      for (const p of e.parts) { const w = selfWidth(p, c); if (w === null) return null; t += w; }
      return t;
    }
    case 'repl': {
      const n = evalConst(e.count, c.env);
      if (n === null) return null;
      let t = 0;
      for (const p of e.parts) { const w = selfWidth(p, c); if (w === null) return null; t += w; }
      return t * Number(n);
    }
    default: return null;
  }
}

/** True when Verilog sizes the expression from its assignment context (arithmetic, bitwise, ?:). */
export function isContextual(e: Expr): boolean {
  switch (e.k) {
    case 'binary': return !BOOL_OPS.has(e.op);
    case 'ternary': return true;
    case 'unary': return !REDUCE.has(e.op);
    default: return false;
  }
}
