// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeSource } from '../../src/analysis/analyze';
import { EXAMPLES } from '../../src/editor/examples';
import { sanitizeLabel } from '../../src/utils/escaping';
import { buildSvgString } from '../../src/visualization/export';
import { CanvasInteractions } from '../../src/visualization/interactions';
import { layoutModel } from '../../src/visualization/layout';
import { CircuitRenderer, type Selection } from '../../src/visualization/renderer';

const NS = 'http://www.w3.org/2000/svg';
const model = (id: string) => {
  const e = EXAMPLES.find((x) => x.id === id)!;
  return analyzeSource(e.source).modules.get(e.expect.top)!;
};
function setup(id: string) {
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  document.body.appendChild(svg);
  const r = new CircuitRenderer(svg);
  const m = model(id);
  r.render(m, layoutModel(m));
  return { svg, r, m };
}
const fire = (el: Element, type: string, x = 0, y = 0): void => {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
};

beforeEach(() => { document.body.replaceChildren(); });

describe('SVG rendering', () => {
  it('draws one element per node and per connection for every example', () => {
    for (const e of EXAMPLES) {
      const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
      const r = new CircuitRenderer(svg);
      for (const m of analyzeSource(e.source).modules.values()) {
        r.render(m, layoutModel(m));
        expect(svg.querySelectorAll('[data-node]').length, e.id).toBe(m.nodes.length);
        expect(svg.querySelectorAll('[data-conn]').length, e.id).toBe(m.connections.length);
      }
    }
  });

  it('distinguishes sequential and combinational nodes and labels buses', () => {
    const { svg } = setup('counter');
    expect(svg.querySelector('.node.k-dff.seq')).toBeTruthy();
    expect(svg.querySelector('.node.k-arith')).toBeTruthy();
    expect([...svg.querySelectorAll('.buslabel')].some((t) => t.textContent === '4')).toBe(true);
  });

  it('draws a clock marker and a bubble for falling-edge registers', () => {
    const e = analyzeSource('module m(input clk, input d, output reg q); always @(negedge clk) q <= d; endmodule');
    const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
    const r = new CircuitRenderer(svg);
    r.render(e.modules.get('m')!, layoutModel(e.modules.get('m')!));
    expect(svg.querySelector('.node.k-dff .clk')).toBeTruthy();
    expect(svg.querySelector('.node.k-dff .bubble')).toBeTruthy();
  });

  it('routes feedback wires backwards through a lane below the nodes', () => {
    const m = model('counter');
    const l = layoutModel(m);
    expect(l.backward.size).toBeGreaterThan(0);
  });

  it('routes wires that skip a column above the nodes instead of behind them', () => {
    const { svg, r, m } = setup('hierarchy');
    const l = r.layout!;
    expect(l.top.size).toBeGreaterThan(0);
    const minY = Math.min(...[...l.boxes.values()].map((b) => b.y));
    for (const id of l.top.keys()) {
      const d = svg.querySelector(`[data-conn="${id}"] .line`)!.getAttribute('d')!;
      const ys = [...d.matchAll(/V(-?[\d.]+)/g)].map((x) => parseFloat(x[1]));
      expect(Math.min(...ys)).toBeLessThan(minY);
    }
    expect(r.bounds().y).toBeLessThan(minY);
    expect(m.connections.length).toBeGreaterThan(l.top.size);
  });

  it('builds labels with text nodes, never markup', () => {
    const { svg } = setup('full-adder');
    expect(svg.innerHTML).not.toMatch(/<script|onload=|onerror=|javascript:/i);
    expect(sanitizeLabel('a\u0000b\u001fc<script>')).toBe('a b c<script>');
    const title = svg.querySelector('title')!;
    expect(title.children.length).toBe(0);
  });

  it('highlights selection and trace cones', () => {
    const { svg, r, m } = setup('full-adder');
    const sel: Selection = { type: 'node', id: 'out:cout' };
    r.setHighlight({ selection: sel, up: new Set(['out:cout', 'in:a']), down: new Set(['out:cout']), upConns: new Set(), downConns: new Set() });
    expect(svg.querySelector('[data-node="out:cout"]')!.classList.contains('sel')).toBe(true);
    expect(svg.querySelector('[data-node="in:a"]')!.classList.contains('tr-up')).toBe(true);
    expect(svg.querySelector('[data-node="in:b"]')!.classList.contains('dim')).toBe(true);
    r.setHighlight({ selection: null, up: null, down: null, upConns: null, downConns: null });
    expect(svg.querySelectorAll('.dim').length).toBe(0);
    expect(m.nodes.length).toBeGreaterThan(0);
  });
});

describe('canvas interactions', () => {
  it('selects nodes, wires and clears on background click', () => {
    const { svg, r } = setup('and');
    const picks: (Selection | null)[] = [];
    new CanvasInteractions(svg, r, { onSelect: (s) => picks.push(s) });
    const node = svg.querySelector('[data-node="in:a"] .shape')!;
    fire(node, 'pointerdown'); fire(node, 'pointerup');
    expect(picks.at(-1)).toEqual({ type: 'node', id: 'in:a' });
    const wire = svg.querySelector('.wire .hit')!;
    fire(wire, 'pointerdown'); fire(wire, 'pointerup');
    expect(picks.at(-1)!.type).toBe('conn');
    fire(svg, 'pointerdown'); fire(svg, 'pointerup');
    expect(picks.at(-1)).toBeNull();
  });

  it('drags nodes and keeps attached wires connected', () => {
    const { svg, r } = setup('and');
    new CanvasInteractions(svg, r, { onSelect: () => {} });
    const box = r.layout!.boxes.get('in:a')!;
    const before = { x: box.x, y: box.y };
    const wire = [...svg.querySelectorAll('.wire .line')].find((p) => (p.parentElement as Element).getAttribute('data-conn')!.includes('in:a'))!;
    const d0 = wire.getAttribute('d');
    const node = svg.querySelector('[data-node="in:a"] .shape')!;
    fire(node, 'pointerdown', 10, 10); fire(svg, 'pointermove', 40, 70); fire(svg, 'pointerup', 40, 70);
    expect(box.x).toBeCloseTo(before.x + 30);
    expect(box.y).toBeCloseTo(before.y + 60);
    expect(wire.getAttribute('d')).not.toBe(d0);
    expect(svg.querySelector('[data-node="in:a"]')!.getAttribute('transform')).toBe(`translate(${box.x} ${box.y})`);
  });

  it('pans on background drag and zooms within limits', () => {
    const { svg, r } = setup('and');
    const ia = new CanvasInteractions(svg, r, { onSelect: () => {} });
    fire(svg, 'pointerdown', 0, 0); fire(svg, 'pointermove', 25, 15); fire(svg, 'pointerup', 25, 15);
    expect([ia.view.tx, ia.view.ty]).toEqual([25, 15]);
    ia.zoomBy(1.25);
    expect(ia.view.k).toBeCloseTo(1.25);
    for (let i = 0; i < 40; i++) ia.zoomBy(1.5);
    expect(ia.view.k).toBeLessThanOrEqual(4);
    for (let i = 0; i < 80; i++) ia.zoomBy(0.5);
    expect(ia.view.k).toBeGreaterThanOrEqual(0.15);
    expect(svg.querySelector('.viewport')!.getAttribute('transform')).toMatch(/scale\(/);
  });

  it('fits the diagram into the viewport', () => {
    const { svg, r } = setup('full-adder');
    const ia = new CanvasInteractions(svg, r, { onSelect: () => {} });
    ia.fit();
    const b = r.bounds();
    expect(Number.isFinite(ia.view.k) && ia.view.k > 0).toBe(true);
    expect(b.x * ia.view.k + ia.view.tx).toBeGreaterThanOrEqual(0);
    expect((b.x + b.w) * ia.view.k + ia.view.tx).toBeLessThanOrEqual(800);
  });
});

describe('SVG export', () => {
  it('produces a standalone SVG without interaction helpers', () => {
    const { svg, r } = setup('half-adder');
    const out = buildSvgString(svg, r.bounds(), '#000000');
    expect(out.startsWith('<svg')).toBe(true);
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).toMatch(/viewBox="[-\d. ]+"/);
    expect(out).not.toContain('class="hit"');
    expect(out).not.toMatch(/<script|tabindex/);
    expect(new DOMParser().parseFromString(out, 'image/svg+xml').querySelector('parsererror')).toBeNull();
    expect(out).toContain('sum');
  });
});

describe('application shell', () => {
  async function mount() {
    const html = readFileSync(join(__dirname, '../../index.html'), 'utf8');
    document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1];
    (globalThis as { __RTLV_NO_AUTOMOUNT__?: boolean }).__RTLV_NO_AUTOMOUNT__ = true;
    const { mountApp } = await import('../../src/main');
    return mountApp();
  }
  const q = (s: string): HTMLElement => document.querySelector(s) as HTMLElement;

  it('loads the default example and fills every panel', async () => {
    const app = await mount();
    expect(q('#status').textContent).toBe('Analysis complete for supported constructs');
    expect(q('#editor textarea').getAttribute('aria-label')).toBe('RTL source');
    expect(q('#stats').textContent).toContain('Inputs2');
    expect(q('#cv').querySelectorAll('[data-node]').length).toBe(4);
    expect(q('#example-select').children.length).toBe(EXAMPLES.length);
    expect(q('#export-svg')).toHaveProperty('disabled', false);
    app.destroy();
  });

  it('highlights syntax and numbers lines', async () => {
    const app = await mount();
    expect(q('.ed-hl .tk-k')).toBeTruthy();
    expect(q('.ed-gutter').children.length).toBe(app.editor.getValue().split('\n').length);
    app.destroy();
  });

  it('loads examples, inspects nodes and opens modules from the hierarchy', async () => {
    const app = await mount();
    app.loadExample('hierarchy');
    expect(app.current).toBe('full_adder_top');
    expect(q('#module-select').hidden).toBe(false);
    expect(q('#hierarchy').textContent).toContain('half_adder');
    app.select({ type: 'node', id: 'inst:u_ha0' });
    expect(q('#inspector').textContent).toContain('Open module half_adder');
    (q('#inspector button.pri') as HTMLButtonElement).click();
    expect(app.current).toBe('half_adder');
    expect(q('#module-name').textContent).toBe('module half_adder');
    app.loadExample('counter');
    app.select({ type: 'node', id: 'reg:count' });
    expect(q('#inspector').textContent).toMatch(/Register \(D flip-flop\)/);
    expect(q('#inspector').textContent).toMatch(/asynchronous|async/);
    app.destroy();
  });

  it('shows traces for the selection and toggles them off', async () => {
    const app = await mount();
    app.loadExample('full-adder');
    app.select({ type: 'node', id: 'out:cout' });
    expect(q('#cv').querySelector('[data-node="in:cin"]')!.classList.contains('tr-up')).toBe(true);
    (q('#trace-toggle') as HTMLInputElement).click();
    expect(q('#cv').querySelectorAll('.dim').length).toBe(0);
    app.destroy();
  });

  it('shows empty, error and partial states honestly', async () => {
    const app = await mount();
    app.editor.setValue('');
    app.analyze(true);
    expect(q('#canvas-overlay').hidden).toBe(false);
    expect(q('#canvas-overlay').textContent).toContain('No RTL yet');
    expect(q('#export-svg')).toHaveProperty('disabled', true);

    app.editor.setValue('module m(input a, output y); assign y = a &; endmodule');
    app.analyze(true);
    expect(q('#status').textContent).toBe('Partial visualization');
    expect(q('#diagnostics').textContent).toContain('Expected an expression');
    expect(q('.ed-gutter .mk-error')).toBeTruthy();

    app.editor.setValue('module (');
    app.analyze(true);
    expect(q('#status').textContent).toBe('Analysis failed');
    expect(q('#canvas-overlay').textContent).toContain('Analysis failed');
    app.destroy();
  });

  it('reports warnings in the status without hiding the diagram', async () => {
    const app = await mount();
    app.editor.setValue('module m(input [7:0] a, output [3:0] y); assign y = a; endmodule');
    app.analyze(true);
    expect(q('#status').textContent).toBe('Analysis complete with warnings');
    expect(q('#cv').querySelectorAll('[data-node]').length).toBeGreaterThan(0);
    app.destroy();
  });

  it('toggles and persists the theme', async () => {
    const app = await mount();
    expect(document.documentElement.dataset.theme).toBe('dark');
    q('#theme-toggle').click();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('rtl-theme')).toBe('light');
    app.destroy();
  });

  it('resets the layout after dragging', async () => {
    const app = await mount();
    const id = 'in:a';
    const box = app.renderer.layout!.boxes.get(id)!;
    const x0 = box.x;
    app.renderer.moveNode(id, 100, 0);
    q('#reset-btn').click();
    expect(app.renderer.layout!.boxes.get(id)!.x).toBe(x0);
    app.destroy();
  });
});
