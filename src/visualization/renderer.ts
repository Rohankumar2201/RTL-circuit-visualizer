import type { Connection, HwNode, ModuleModel } from '../analysis/hardware-model';
import { layoutBounds, pinPosition, topLaneY, type Box, type Layout } from './layout';
import { connectionPath } from './wire-routing';
import { sanitizeLabel } from '../utils/escaping';

const NS = 'http://www.w3.org/2000/svg';
export interface Selection { type: 'node' | 'conn'; id: string }
export interface Highlight { selection: Selection | null; up: Set<string> | null; down: Set<string> | null; upConns: Set<string> | null; downConns: Set<string> | null }
export interface View { k: number; tx: number; ty: number }

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

const NEG_OPS = new Set(['NAND', 'NOR', 'XNOR', 'NOT']);
const KIND_CLASS: Record<string, string> = {
  input: 'io', output: 'io', const: 'const', undriven: 'bad', contention: 'conflict', instance: 'inst', dff: 'seq', mux: 'comb',
};

export class CircuitRenderer {
  readonly viewport: SVGGElement;
  private wiresG: SVGGElement;
  private nodesG: SVGGElement;
  private nodeEls = new Map<string, SVGGElement>();
  private wireEls = new Map<string, { g: SVGGElement; line: SVGPathElement; hit: SVGPathElement; label: SVGTextElement | null }>();
  model: ModuleModel | null = null;
  layout: Layout | null = null;
  private nodeById = new Map<string, HwNode>();
  private extent: { x: number; y: number; w: number; h: number } | null = null;

  constructor(readonly svg: SVGSVGElement) {
    this.viewport = el('g', { class: 'viewport' }, svg);
    this.wiresG = el('g', { class: 'wires' }, this.viewport);
    this.nodesG = el('g', { class: 'nodes' }, this.viewport);
  }

  clear(): void {
    this.wiresG.replaceChildren();
    this.nodesG.replaceChildren();
    this.nodeEls.clear();
    this.wireEls.clear();
    this.model = null;
    this.layout = null;
    this.extent = null;
  }

  setView(v: View): void { this.viewport.setAttribute('transform', `translate(${v.tx} ${v.ty}) scale(${v.k})`); }

  render(model: ModuleModel, layout: Layout): void {
    this.clear();
    this.model = model;
    this.layout = layout;
    this.nodeById = new Map(model.nodes.map((n) => [n.id, n]));
    for (const c of model.connections) this.drawWire(c);
    for (const n of model.nodes) this.drawNode(n, layout.boxes.get(n.id)!);
    this.svg.setAttribute('aria-label', `Circuit diagram of module ${sanitizeLabel(model.name)}`);
  }

  bounds(): { x: number; y: number; w: number; h: number } {
    return this.layout ? layoutBounds(this.layout) : { x: 0, y: 0, w: 400, h: 300 };
  }

  private pinPt(nodeId: string, pin: string): { x: number; y: number } {
    return pinPosition(this.layout!.boxes.get(nodeId)!, this.nodeById.get(nodeId)!, pin);
  }

  private pathFor(c: Connection): string {
    const l = this.layout!;
    const bottom = this.extent ?? (this.extent = layoutBounds(l));
    const laneY = bottom.y + bottom.h - 8 - (l.lane.get(c.id) ?? 0) * 10;
    const overLane = l.top.get(c.id);
    return connectionPath(this.pinPt(c.from.node, c.from.pin), this.pinPt(c.to.node, c.to.pin), {
      backward: l.backward.has(c.id), rank: l.rank.get(c.from.node), laneY,
      overY: overLane === undefined ? undefined : topLaneY(l, overLane),
    });
  }

  private drawWire(c: Connection): void {
    const g = el('g', { class: 'wire', 'data-conn': c.id }, this.wiresG);
    const d = this.pathFor(c);
    const hit = el('path', { class: 'hit', d }, g);
    const bus = c.width !== null && c.width > 1;
    const line = el('path', { class: bus ? 'line bus' : 'line', d }, g);
    let label: SVGTextElement | null = null;
    const tip = `${c.signal ?? 'internal net'}${c.width ? ` [${c.width} bit${c.width > 1 ? 's' : ''}]` : ''}`;
    el('title', {}, g, sanitizeLabel(tip));
    if (bus) {
      const p = this.pinPt(c.from.node, c.from.pin);
      label = el('text', { class: 'buslabel', x: p.x + 5, y: p.y - 4 }, g, String(c.width));
    }
    this.wireEls.set(c.id, { g, line, hit, label });
  }

  private updateWire(c: Connection): void {
    const w = this.wireEls.get(c.id);
    if (!w) return;
    const d = this.pathFor(c);
    w.line.setAttribute('d', d);
    w.hit.setAttribute('d', d);
    if (w.label) { const p = this.pinPt(c.from.node, c.from.pin); w.label.setAttribute('x', String(p.x + 5)); w.label.setAttribute('y', String(p.y - 4)); }
  }

  moveNode(id: string, dx: number, dy: number): void {
    const box = this.layout?.boxes.get(id);
    const g = this.nodeEls.get(id);
    if (!box || !g || !this.model) return;
    box.x += dx; box.y += dy;
    g.setAttribute('transform', `translate(${box.x} ${box.y})`);
    for (const c of this.model.connections) if (c.from.node === id || c.to.node === id) this.updateWire(c);
  }

  private drawNode(n: HwNode, box: Box): void {
    const cls = `node k-${n.kind} ${KIND_CLASS[n.kind] ?? 'comb'}${n.sequential ? ' seq' : ''}`;
    const g = el('g', { class: cls, 'data-node': n.id, transform: `translate(${box.x} ${box.y})`, tabindex: 0 }, this.nodesG);
    const { w, h } = box;
    el('title', {}, g, sanitizeLabel(`${n.label}${n.drives ? ' → ' + n.drives : ''}: ${n.explain}`, 300));
    const shape = { class: 'shape' };
    switch (n.kind) {
      case 'input': el('path', { ...shape, d: `M0 0H${w - 12}L${w} ${h / 2}L${w - 12} ${h}H0Z` }, g); break;
      case 'output': el('path', { ...shape, d: `M12 0H${w}V${h}H12L0 ${h / 2}Z` }, g); break;
      case 'mux': el('path', { ...shape, d: `M0 0L${w} 14V${h - 14}L0 ${h}Z` }, g); break;
      case 'const': el('rect', { ...shape, width: w, height: h, rx: 13 }, g); break;
      default: el('rect', { ...shape, width: w, height: h, rx: n.kind === 'instance' ? 3 : 6 }, g);
    }
    if (NEG_OPS.has(n.op) && n.kind === 'gate') el('circle', { class: 'bubble', cx: w, cy: h / 2, r: 4 }, g);

    const labelText = sanitizeLabel(n.label, 28);
    if (n.kind === 'instance') {
      el('text', { class: 'title', x: w / 2, y: 16 }, g, labelText);
      el('text', { class: 'sub', x: w / 2, y: 31 }, g, sanitizeLabel(String(n.props.instName ?? ''), 24) + (n.props.known ? '' : ' (unknown module)'));
    } else if (n.kind === 'input') el('text', { class: 'title', x: (w - 6) / 2, y: h / 2 + 4 }, g, labelText);
    else if (n.kind === 'output') el('text', { class: 'title', x: (w + 6) / 2, y: h / 2 + 4 }, g, labelText);
    else if (n.kind === 'dff') {
      el('text', { class: 'title', x: w / 2 + 6, y: h / 2 - 2 }, g, labelText);
      el('text', { class: 'sub', x: w / 2 + 6, y: h / 2 + 12 }, g, sanitizeLabel(String(n.props.signal ?? ''), 14));
    } else if (n.kind === 'undriven' || n.kind === 'contention') {
      el('text', { class: 'title', x: w / 2, y: h / 2 - 2 }, g, labelText);
      el('text', { class: 'sub', x: w / 2, y: h / 2 + 11 }, g, n.kind === 'contention' ? 'unresolved' : n.props.unmodeled ? 'unmodeled' : n.props.undeclared ? 'undeclared' : 'undriven');
    } else {
      const hasSub = !!n.drives && n.kind !== 'const';
      el('text', { class: 'title', x: n.kind === 'mux' ? w / 2 - 4 : w / 2, y: h / 2 + (hasSub ? -1 : 4) }, g, labelText);
      if (hasSub) el('text', { class: 'sub', x: w / 2, y: h - 6 }, g, sanitizeLabel(n.drives!, 12));
    }

    const named = n.kind === 'dff' || n.kind === 'mux' || n.kind === 'instance';
    for (const p of n.pins) {
      const pt = pinPosition(box, n, p.name);
      const lx = pt.x - box.x, ly = pt.y - box.y;
      el('circle', { class: 'pin', cx: lx, cy: ly, r: 2.5 }, g);
      if (named) el('text', { class: 'pinname', x: lx + (p.dir === 'in' ? 6 : -6), y: ly + 3, 'text-anchor': p.dir === 'in' ? 'start' : 'end' }, g, p.name);
      if (n.kind === 'dff' && p.name === 'CLK') {
        el('path', { class: 'clk', d: `M0 ${ly - 6}L9 ${ly}L0 ${ly + 6}` }, g);
        if (n.props.edge === 'negedge') el('circle', { class: 'bubble', cx: -4, cy: ly, r: 3.5 }, g);
      }
    }
    this.nodeEls.set(n.id, g);
  }

  setHighlight(hl: Highlight): void {
    const active = !!(hl.up || hl.down);
    const sel = hl.selection;
    for (const [id, g] of this.nodeEls) {
      g.classList.toggle('sel', sel?.type === 'node' && sel.id === id);
      g.classList.toggle('tr-up', !!hl.up?.has(id) && !(sel?.type === 'node' && sel.id === id));
      g.classList.toggle('tr-down', !!hl.down?.has(id) && !hl.up?.has(id));
      g.classList.toggle('dim', active && !hl.up?.has(id) && !hl.down?.has(id));
    }
    for (const [id, w] of this.wireEls) {
      w.g.classList.toggle('sel', sel?.type === 'conn' && sel.id === id);
      w.g.classList.toggle('tr-up', !!hl.upConns?.has(id));
      w.g.classList.toggle('tr-down', !!hl.downConns?.has(id) && !hl.upConns?.has(id));
      w.g.classList.toggle('dim', active && !hl.upConns?.has(id) && !hl.downConns?.has(id));
    }
  }
}
