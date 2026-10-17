import type { Connection, HwNode, ModuleModel } from '../analysis/hardware-model';
import type { Selection } from '../visualization/renderer';
import { clear, h } from '../utils/dom';
import { sanitizeLabel } from '../utils/escaping';

export interface InspectorHandlers {
  onOpenModule: (name: string) => void;
  onJump: (line: number, col: number) => void;
  onSelectNode: (id: string) => void;
}

const KIND_NAME: Record<string, string> = {
  input: 'Input port', output: 'Output port', const: 'Constant', gate: 'Logic gate', buf: 'Buffer', mux: 'Multiplexer', cmp: 'Comparator',
  arith: 'Arithmetic', shift: 'Shifter', reduce: 'Reduction', concat: 'Concatenation', slice: 'Bit/part select', dff: 'Register (D flip-flop)',
  instance: 'Module instance', undriven: 'Undriven signal', contention: 'Multiple drivers',
};

export const nodeTitle = (n: HwNode): string => `${KIND_NAME[n.kind] ?? n.kind}: ${sanitizeLabel(n.label)}`;

function row(dl: HTMLElement, k: string, v: string): void {
  if (!v) return;
  dl.append(h('dt', '', k), h('dd', '', v));
}

const widthText = (w: number | null): string => (w === null ? 'unknown' : `${w} bit${w > 1 ? 's' : ''}`);

export function renderInspector(el: HTMLElement, model: ModuleModel | null, sel: Selection | null, hd: InspectorHandlers): void {
  clear(el);
  if (!model || !sel) { el.appendChild(h('p', 'muted', 'Click a node or wire in the diagram to inspect it.')); return; }
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  if (sel.type === 'conn') {
    const c = model.connections.find((x) => x.id === sel.id);
    if (!c) { el.appendChild(h('p', 'muted', 'Selection no longer exists.')); return; }
    el.appendChild(h('h5', '', c.signal ? `Wire: ${sanitizeLabel(c.signal)}` : 'Internal wire'));
    const dl = h('dl', 'kv');
    row(dl, 'Width', widthText(c.width));
    row(dl, 'From', endpoint(byId, c.from.node, c.from.pin));
    row(dl, 'To', endpoint(byId, c.to.node, c.to.pin));
    el.appendChild(dl);
    return;
  }
  const n = byId.get(sel.id);
  if (!n) { el.appendChild(h('p', 'muted', 'Selection no longer exists.')); return; }
  el.appendChild(h('h5', '', nodeTitle(n)));
  const dl = h('dl', 'kv');
  row(dl, 'Width', n.kind === 'instance' ? '' : widthText(n.width));
  if (n.props.range) row(dl, 'Range', String(n.props.range));
  row(dl, 'Drives signal', n.drives ?? '');
  if (n.props.expr) row(dl, 'Expression', String(n.props.expr));
  if (n.kind === 'dff') {
    row(dl, 'Clock', `${n.props.clock} (${n.props.edge})`);
    const r = n.props.reset as { signal: string; kind: string; activeLow: boolean; value: string } | null;
    row(dl, 'Reset', r ? `${r.signal}, ${r.kind}, active ${r.activeLow ? 'low' : 'high'}, value ${r.value}` : 'none');
    row(dl, 'Enable', String(n.props.enable ?? 'none'));
  }
  if (n.kind === 'instance') {
    row(dl, 'Module', String(n.props.module));
    row(dl, 'Instance', String(n.props.instName));
    row(dl, 'Definition', n.props.known ? 'found in source' : 'not found');
  }
  el.appendChild(dl);
  if (n.explain) el.appendChild(h('p', 'explain', n.explain));

  const ins = n.pins.filter((p) => p.dir === 'in');
  if (ins.length) {
    el.appendChild(h('h6', '', 'Inputs'));
    const ul = h('ul', 'pins');
    for (const p of ins) {
      const c = model.connections.find((x) => x.to.node === n.id && x.to.pin === p.name);
      const li = h('li');
      li.append(h('span', 'pinlabel', p.name + ': '));
      li.append(c ? srcLink(byId, c, hd) : h('span', 'muted', 'unconnected'));
      ul.appendChild(li);
    }
    el.appendChild(ul);
  }
  const outs = model.connections.filter((x) => x.from.node === n.id);
  if (outs.length) {
    el.appendChild(h('h6', '', `Drives (${outs.length})`));
    const ul = h('ul', 'pins');
    for (const c of outs) ul.appendChild(h('li', '', `${endpoint(byId, c.to.node, c.to.pin)}${c.signal ? ' via ' + c.signal : ''}`));
    el.appendChild(ul);
  }
  const actions = h('div', 'actions');
  if (n.kind === 'instance' && n.props.known) {
    const b = h('button', 'pri', `Open module ${n.props.module}`);
    b.type = 'button';
    b.addEventListener('click', () => hd.onOpenModule(String(n.props.module)));
    actions.appendChild(b);
  }
  if (n.loc) {
    const b = h('button', '', `Go to line ${n.loc.line}`);
    b.type = 'button';
    b.addEventListener('click', () => hd.onJump(n.loc!.line, n.loc!.col));
    actions.appendChild(b);
  }
  if (actions.childNodes.length) el.appendChild(actions);
}

function endpoint(byId: Map<string, HwNode>, id: string, pin: string): string {
  const n = byId.get(id);
  return n ? `${sanitizeLabel(n.label)} (${n.kind}) pin ${pin}` : id;
}

function srcLink(byId: Map<string, HwNode>, c: Connection, hd: InspectorHandlers): HTMLElement {
  const n = byId.get(c.from.node);
  const b = h('button', 'link', `${n ? sanitizeLabel(n.label) : c.from.node}${c.signal ? ' (' + c.signal + ')' : ''}`);
  b.type = 'button';
  b.addEventListener('click', () => hd.onSelectNode(c.from.node));
  return b;
}

const EXPLAIN_KINDS = new Set(['gate', 'mux', 'cmp', 'arith', 'shift', 'reduce', 'dff', 'instance', 'undriven', 'contention']);

export function renderExplanation(el: HTMLElement, model: ModuleModel | null): void {
  clear(el);
  if (!model) { el.appendChild(h('p', 'muted', 'No RTL explained yet.')); return; }
  const list = model.nodes.filter((n) => EXPLAIN_KINDS.has(n.kind) && n.explain && !n.props.implicit);
  if (!list.length) { el.appendChild(h('p', 'muted', 'No logic to explain.')); return; }
  const ul = h('ul', 'explain-list');
  for (const n of list.slice(0, 200)) {
    const li = h('li');
    li.append(h('strong', '', nodeTitle(n)), h('div', '', n.explain + (n.drives && n.kind !== 'dff' ? ` Drives '${n.drives}'.` : '')));
    ul.appendChild(li);
  }
  el.appendChild(ul);
}
