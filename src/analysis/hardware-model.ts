import { DiagnosticBag, type AnalysisStatus, type Diagnostic } from '../parser/diagnostics';
import type { Dir, Loc, ModuleAst } from '../parser/types';
import type { ConstEnv, Range } from './widths';

export const MAX_NODES = 4000;
export class LimitError extends Error {}

export type NodeKind =
  | 'input' | 'output' | 'const' | 'gate' | 'buf' | 'mux' | 'cmp' | 'arith' | 'shift' | 'reduce'
  | 'concat' | 'slice' | 'dff' | 'instance' | 'undriven' | 'contention';

export interface Pin { name: string; dir: 'in' | 'out'; width: number | null }
export interface PinRef { node: string; pin: string }

/** A hardware node. Ids are stable for a given source; labels are display-only. */
export interface HwNode {
  id: string;
  kind: NodeKind;
  op: string;
  label: string;
  width: number | null;
  pins: Pin[];
  sequential: boolean;
  drives?: string;
  loc?: Loc;
  props: Record<string, unknown>;
  explain: string;
}

export interface Connection {
  id: string;
  from: PinRef;
  to: PinRef;
  signal: string | null;
  width: number | null;
}

export type DriverOrigin = 'input' | 'assign' | 'comb' | 'seq' | 'instance';
export interface DriverRec {
  signal: string; node: string; pin: string; lo: number; hi: number;
  origin: DriverOrigin; block: string; loc: Loc | null;
}

export interface SignalInfo {
  name: string;
  kind: 'wire' | 'reg' | 'logic';
  dir: Dir | null;
  range: Range;
  width: number;
  signed: boolean;
  loc: Loc;
  drivers: DriverRec[];
  readers: number;
  unmodeled: boolean;
}

export type Source =
  | { type: 'pin'; node: string; pin: string; width: number | null }
  | { type: 'sig'; name: string; width: number | null; loc: Loc | null; feedback?: boolean };
export type SigSource = Extract<Source, { type: 'sig' }>;

export interface InstanceRef { name: string; module: string; known: boolean; nodeId: string }

export interface ModuleModel {
  name: string;
  ast: ModuleAst;
  signals: SignalInfo[];
  nodes: HwNode[];
  connections: Connection[];
  instances: InstanceRef[];
  diagnostics: Diagnostic[];
  partial: boolean;
  status: AnalysisStatus;
}

export const inPin = (name: string, width: number | null): Pin => ({ name, dir: 'in', width });
export const outPin = (name: string, width: number | null): Pin => ({ name, dir: 'out', width });

export interface NodeInit {
  id?: string; label?: string; width?: number | null; pins: Pin[]; loc?: Loc | null;
  props?: Record<string, unknown>; sequential?: boolean; explain?: string;
}

export class ModelBuilder {
  nodes: HwNode[] = [];
  conns: Connection[] = [];
  pending: { src: SigSource; to: PinRef }[] = [];
  drivers: DriverRec[] = [];
  signals = new Map<string, SignalInfo>();
  diags = new DiagnosticBag();
  params: ConstEnv = new Map();
  partial = false;
  unmodeled = new Set<string>();
  used = new Set<string>();
  instances: InstanceRef[] = [];
  baseCache = new Map<string, Source>();
  reported = new Set<string>();
  private counter = 0;
  private ids = new Set<string>();

  constructor(readonly ast: ModuleAst, readonly lib: Map<string, ModuleAst>) {}

  addNode(kind: NodeKind, op: string, o: NodeInit): HwNode {
    if (this.nodes.length >= MAX_NODES) throw new LimitError(`More than ${MAX_NODES} hardware nodes; the design is too large to visualize`);
    let id = o.id ?? `n${++this.counter}`;
    if (this.ids.has(id)) { let k = 2; while (this.ids.has(`${id}#${k}`)) k++; id = `${id}#${k}`; }
    this.ids.add(id);
    const node: HwNode = {
      id, kind, op, label: o.label ?? op, width: o.width ?? null, pins: o.pins,
      sequential: o.sequential ?? kind === 'dff', loc: o.loc ?? undefined, props: o.props ?? {}, explain: o.explain ?? '',
    };
    this.nodes.push(node);
    return node;
  }

  node(id: string): HwNode | undefined { return this.nodes.find((n) => n.id === id); }

  link(from: PinRef, to: PinRef, signal: string | null, width: number | null): void {
    this.conns.push({ id: `c${this.conns.length + 1}_${from.node}>${to.node}`, from, to, signal, width });
  }

  /** Connect a source to a sink pin. Signal references are resolved after all drivers are known. */
  connect(src: Source, to: PinRef): void {
    if (src.type === 'pin') this.link({ node: src.node, pin: src.pin }, to, null, src.width);
    else this.pending.push({ src, to });
  }

  pinSrc(node: HwNode, pin: string): Source {
    const p = node.pins.find((x) => x.name === pin);
    return { type: 'pin', node: node.id, pin, width: p ? p.width : null };
  }

  markUsed(name: string): void { this.used.add(name); }

  mark(): { n: number; c: number; p: number; d: number } {
    return { n: this.nodes.length, c: this.conns.length, p: this.pending.length, d: this.drivers.length };
  }
  rollback(m: { n: number; c: number; p: number; d: number }): void {
    this.nodes.length = m.n; this.conns.length = m.c; this.pending.length = m.p; this.drivers.length = m.d;
    this.ids = new Set(this.nodes.map((x) => x.id));
    this.baseCache.clear();
  }
}
