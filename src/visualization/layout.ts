import type { Connection, HwNode, ModuleModel } from '../analysis/hardware-model';

export interface Box { x: number; y: number; w: number; h: number }
export interface Layout {
  boxes: Map<string, Box>;
  backward: Set<string>;
  rank: Map<string, { k: number; K: number }>;
  lane: Map<string, number>;
  /** Forward wires that skip at least one column; routed in lanes above the nodes so they never cross node bodies. */
  top: Map<string, number>;
}

const PITCH = 20;
const COL_GAP = 96;
const ROW_GAP = 26;
const PAD = 40;

export function nodeSize(n: HwNode): { w: number; h: number } {
  const ins = n.pins.filter((p) => p.dir === 'in').length;
  const outs = n.pins.filter((p) => p.dir === 'out').length;
  const rows = Math.max(ins, outs);
  const textW = (s: string): number => 8 * s.length + 28;
  switch (n.kind) {
    case 'input': case 'output': return { w: Math.max(72, textW(n.label)), h: 30 };
    case 'undriven': case 'contention': return { w: Math.max(88, textW(n.label)), h: 34 };
    case 'const': return { w: Math.max(48, textW(n.label)), h: 26 };
    case 'instance': {
      const longest = Math.max(...n.pins.map((p) => p.name.length), 1);
      return { w: Math.max(150, 2 * (7 * longest + 14), textW(n.label)), h: 48 + rows * PITCH };
    }
    case 'dff': return { w: 96, h: Math.max(76, rows * PITCH + 24) };
    case 'mux': return { w: 72, h: Math.max(64, (ins + 1) * PITCH + 8) };
    default: return { w: Math.max(68, textW(n.label)), h: Math.max(46, rows * PITCH + 16) };
  }
}

export function pinPosition(box: Box, node: HwNode, pinName: string): { x: number; y: number } {
  const pin = node.pins.find((p) => p.name === pinName);
  const side = node.pins.filter((p) => p.dir === (pin?.dir ?? 'in'));
  const idx = Math.max(0, side.findIndex((p) => p.name === pinName));
  const dir = pin?.dir ?? 'in';
  const topPad = node.kind === 'instance' ? 38 : 0;
  const h = box.h - topPad;
  return { x: dir === 'in' ? box.x : box.x + box.w, y: box.y + topPad + ((idx + 1) * h) / (side.length + 1) };
}

export function layoutModel(m: ModuleModel): Layout {
  const out = new Map<string, Connection[]>();
  const incoming = new Set<string>();
  for (const c of m.connections) {
    if (!out.has(c.from.node)) out.set(c.from.node, []);
    out.get(c.from.node)!.push(c);
    incoming.add(c.to.node);
  }
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const post: string[] = [];
  const dfs = (id: string): void => {
    state.set(id, 1);
    for (const c of out.get(id) ?? []) {
      const s = state.get(c.to.node);
      if (s === 1) back.add(c.id);
      else if (!s) dfs(c.to.node);
    }
    state.set(id, 2);
    post.push(id);
  };
  const order = [...m.nodes.filter((n) => !incoming.has(n.id)), ...m.nodes];
  for (const n of order) if (!state.has(n.id)) dfs(n.id);

  const level = new Map<string, number>(m.nodes.map((n) => [n.id, 0]));
  for (const id of [...post].reverse()) {
    for (const c of out.get(id) ?? []) {
      if (back.has(c.id)) continue;
      level.set(c.to.node, Math.max(level.get(c.to.node)!, level.get(id)! + 1));
    }
  }
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  for (const n of m.nodes) {
    if (n.kind !== 'const') continue;
    const succ = (out.get(n.id) ?? []).filter((c) => !back.has(c.id)).map((c) => level.get(c.to.node)!);
    if (succ.length) level.set(n.id, Math.max(0, Math.min(...succ) - 1));
  }
  const maxOther = Math.max(0, ...m.nodes.filter((n) => n.kind !== 'output').map((n) => level.get(n.id)!));
  for (const n of m.nodes) if (n.kind === 'output') level.set(n.id, maxOther + 1);

  const cols = new Map<number, HwNode[]>();
  for (const n of m.nodes) {
    const l = level.get(n.id)!;
    if (!cols.has(l)) cols.set(l, []);
    cols.get(l)!.push(n);
  }
  const levels = [...cols.keys()].sort((a, b) => a - b);
  const sizes = new Map(m.nodes.map((n) => [n.id, nodeSize(n)]));
  const colW = new Map(levels.map((l) => [l, Math.max(...cols.get(l)!.map((n) => sizes.get(n.id)!.w))]));
  const colX = new Map<number, number>();
  let x = PAD;
  for (const l of levels) { colX.set(l, x); x += colW.get(l)! + COL_GAP; }

  const preds = new Map<string, string[]>();
  for (const c of m.connections) {
    if (back.has(c.id)) continue;
    if (!preds.has(c.to.node)) preds.set(c.to.node, []);
    preds.get(c.to.node)!.push(c.from.node);
  }
  const yCenter = new Map<string, number>();
  const stack = (): void => {
    let tallest = 0;
    const heights = new Map<number, number>();
    for (const l of levels) {
      const h = cols.get(l)!.reduce((s, n) => s + sizes.get(n.id)!.h + ROW_GAP, -ROW_GAP);
      heights.set(l, h);
      tallest = Math.max(tallest, h);
    }
    for (const l of levels) {
      let y = PAD + (tallest - heights.get(l)!) / 2;
      for (const n of cols.get(l)!) { const s = sizes.get(n.id)!; yCenter.set(n.id, y + s.h / 2); y += s.h + ROW_GAP; }
    }
  };
  stack();
  const index = new Map(m.nodes.map((n, i) => [n.id, i]));
  for (let pass = 0; pass < 3; pass++) {
    for (const l of levels) {
      const key = (n: HwNode): number => {
        const p = preds.get(n.id);
        return p && p.length ? p.reduce((s, id) => s + (yCenter.get(id) ?? 0), 0) / p.length : yCenter.get(n.id)!;
      };
      cols.get(l)!.sort((a, b) => key(a) - key(b) || index.get(a.id)! - index.get(b.id)!);
      stack();
    }
  }

  const boxes = new Map<string, Box>();
  for (const n of m.nodes) {
    const s = sizes.get(n.id)!;
    boxes.set(n.id, { x: colX.get(level.get(n.id)!)!, y: yCenter.get(n.id)! - s.h / 2, w: s.w, h: s.h });
  }

  const rank = new Map<string, { k: number; K: number }>();
  const lane = new Map<string, number>();
  const laneBySource = new Map<string, number>();
  for (const l of levels) {
    const withFwd = cols.get(l)!.filter((n) => (out.get(n.id) ?? []).some((c) => !back.has(c.id)));
    withFwd.forEach((n, k) => rank.set(n.id, { k, K: withFwd.length }));
  }
  for (const c of m.connections) {
    if (!back.has(c.id)) continue;
    if (!laneBySource.has(c.from.node)) laneBySource.set(c.from.node, laneBySource.size);
    lane.set(c.id, laneBySource.get(c.from.node)!);
  }
  const colIndex = new Map(levels.map((l, i) => [l, i]));
  const top = new Map<string, number>();
  const topBySource = new Map<string, number>();
  for (const c of m.connections) {
    if (back.has(c.id)) continue;
    const span = colIndex.get(level.get(c.to.node)!)! - colIndex.get(level.get(c.from.node)!)!;
    if (span < 2) continue;
    if (!topBySource.has(c.from.node)) topBySource.set(c.from.node, topBySource.size);
    top.set(c.id, topBySource.get(c.from.node)!);
  }
  void byId;
  return { boxes, backward: back, rank, lane, top };
}

export function layoutBounds(l: Layout): { x: number; y: number; w: number; h: number } {
  if (!l.boxes.size) return { x: 0, y: 0, w: 400, h: 300 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of l.boxes.values()) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); }
  const lanes = l.lane.size ? new Set(l.lane.values()).size * 10 + 24 : 0;
  const topSpace = l.top.size ? new Set(l.top.values()).size * 8 + 16 : 0;
  return { x: x0 - 20, y: y0 - 20 - topSpace, w: x1 - x0 + 40, h: y1 - y0 + 40 + lanes + topSpace };
}

export const topLaneY = (l: Layout, lane: number): number => Math.min(...[...l.boxes.values()].map((b) => b.y)) - 14 - lane * 8;
