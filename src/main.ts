import './styles/main.css';
import './styles/editor.css';
import './styles/circuit.css';
import { analyzeSource, type ProjectModel } from './analysis/analyze';
import { traceCone } from './analysis/connectivity';
import type { ModuleModel } from './analysis/hardware-model';
import { DEFAULT_EXAMPLE, EXAMPLES } from './editor/examples';
import { Editor } from './editor/editor';
import { STATUS_LABEL, type Severity } from './parser/diagnostics';
import { renderDiagnostics } from './panels/diagnostics-panel';
import { renderHierarchy } from './panels/hierarchy-panel';
import { renderExplanation, renderInspector } from './panels/inspector';
import { renderStatistics } from './panels/statistics';
import { clear, h } from './utils/dom';
import { exportPngFile, exportSvgFile } from './visualization/export';
import { CanvasInteractions } from './visualization/interactions';
import { layoutModel } from './visualization/layout';
import { CircuitRenderer, type Selection } from './visualization/renderer';

const THEME_KEY = 'rtl-theme';

function must<T extends Element>(root: ParentNode, sel: string): T {
  const e = root.querySelector<T>(sel);
  if (!e) throw new Error(`Missing element ${sel}`);
  return e;
}

export function mountApp(doc: Document = document) {
  const root = doc.documentElement;
  const $ = <T extends Element>(s: string): T => must<T>(doc, s);
  const svg = $<SVGSVGElement>('#cv');
  const overlay = $<HTMLElement>('#canvas-overlay');
  const statusEl = $<HTMLElement>('#status');
  const moduleSelect = $<HTMLSelectElement>('#module-select');
  const exampleSelect = $<HTMLSelectElement>('#example-select');
  const traceToggle = $<HTMLInputElement>('#trace-toggle');

  let project: ProjectModel | null = null;
  let current: string | null = null;
  let selection: Selection | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const renderer = new CircuitRenderer(svg);
  const editor = new Editor($<HTMLElement>('#editor'), { onChange: () => schedule(), onRun: () => analyze(true) });
  const interactions = new CanvasInteractions(svg, renderer, { onSelect: (s) => select(s) });
  const model = (): ModuleModel | null => (project && current ? project.modules.get(current) ?? null : null);

  const jump = (line: number, col: number): void => editor.reveal(line, col);
  const handlers = {
    onOpenModule: (n: string) => openModule(n),
    onJump: jump,
    onSelectNode: (id: string) => select({ type: 'node', id }),
  };

  function setStatus(text: string, cls: string): void {
    statusEl.textContent = text;
    statusEl.className = `status status-${cls}`;
  }

  function showOverlay(title: string | null, body = ''): void {
    overlay.hidden = title === null;
    clear(overlay);
    if (title !== null) overlay.append(h('strong', '', title), h('span', '', body));
  }

  function updateHighlight(): void {
    const m = model();
    if (!m || !selection || !traceToggle.checked) { renderer.setHighlight({ selection, up: null, down: null, upConns: null, downConns: null }); return; }
    let startUp: string, startDown: string;
    if (selection.type === 'node') { startUp = selection.id; startDown = selection.id; }
    else {
      const c = m.connections.find((x) => x.id === selection!.id);
      if (!c) { renderer.setHighlight({ selection, up: null, down: null, upConns: null, downConns: null }); return; }
      startUp = c.from.node; startDown = c.to.node;
    }
    const up = traceCone(m.connections, startUp, 'in'), down = traceCone(m.connections, startDown, 'out');
    renderer.setHighlight({ selection, up: up.nodes, down: down.nodes, upConns: up.conns, downConns: down.conns });
  }

  function select(s: Selection | null): void {
    selection = s;
    renderInspector($<HTMLElement>('#inspector'), model(), s, handlers);
    updateHighlight();
  }

  function showModule(name: string, fit: boolean): void {
    current = name;
    const m = model();
    moduleSelect.value = name;
    $<HTMLElement>('#module-name').textContent = m ? `module ${m.name}` : '';
    $<HTMLButtonElement>('#export-svg').disabled = !m;
    $<HTMLButtonElement>('#export-png').disabled = !m;
    selection = null;
    if (m) {
      renderer.render(m, layoutModel(m));
      if (fit) interactions.fit(); else renderer.setView(interactions.view);
      showOverlay(m.nodes.length ? null : 'Nothing to draw', 'This module has no ports or logic.');
    }
    renderStatistics($<HTMLElement>('#stats'), m);
    renderExplanation($<HTMLElement>('#explanation'), m);
    renderHierarchy($<HTMLElement>('#hierarchy'), project?.hierarchy ?? null, current, openModule);
    select(null);
  }

  function openModule(name: string): void { if (project?.modules.has(name)) showModule(name, true); }

  function applyProject(p: ProjectModel, fit: boolean): void {
    project = p;
    const markers = new Map<number, Severity>();
    const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
    for (const d of p.diagnostics) if (d.line) { const prev = markers.get(d.line); if (!prev || rank[d.severity] < rank[prev]) markers.set(d.line, d.severity); }
    editor.setMarkers(markers);
    renderDiagnostics($<HTMLElement>('#diagnostics'), p.diagnostics, jump);
    $<HTMLElement>('#diag-count').textContent = p.diagnostics.length ? `(${p.diagnostics.length})` : '';
    setStatus(STATUS_LABEL[p.status], p.status);
    moduleSelect.replaceChildren(...p.order.map((n) => { const o = h('option', '', n); o.value = n; return o; }));
    moduleSelect.hidden = p.order.length < 2;
    if (!p.order.length) {
      current = null;
      renderer.clear();
      showModule_empty(p);
      return;
    }
    const keep = current && p.modules.has(current) ? current : p.top ?? p.order[0];
    showModule(keep, fit);
  }

  function showModule_empty(p: ProjectModel): void {
    $<HTMLElement>('#module-name').textContent = '';
    $<HTMLButtonElement>('#export-svg').disabled = true;
    $<HTMLButtonElement>('#export-png').disabled = true;
    renderStatistics($<HTMLElement>('#stats'), null);
    renderExplanation($<HTMLElement>('#explanation'), null);
    renderHierarchy($<HTMLElement>('#hierarchy'), null, null, openModule);
    select(null);
    if (p.empty) { setStatus('Ready', 'busy'); showOverlay('No RTL yet', 'Write or paste Verilog / SystemVerilog, or load an example, then press Visualize.'); }
    else showOverlay('Analysis failed', p.diagnostics.find((d) => d.severity === 'error')?.message ?? 'No module could be analyzed. See diagnostics.');
  }

  function analyze(fit: boolean): ProjectModel | null {
    clearTimeout(timer);
    try {
      const p = analyzeSource(editor.getValue());
      applyProject(p, fit);
      return p;
    } catch (e) {
      setStatus(STATUS_LABEL.failed, 'failed');
      showOverlay('Internal error', e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  function schedule(): void {
    setStatus('Analyzing…', 'busy');
    clearTimeout(timer);
    timer = setTimeout(() => analyze(false), 400);
  }

  function loadExample(id: string): void {
    const ex = EXAMPLES.find((e) => e.id === id) ?? DEFAULT_EXAMPLE;
    exampleSelect.value = ex.id;
    $<HTMLElement>('#example-note').textContent = ex.description;
    editor.setValue(ex.source);
    current = null;
    analyze(true);
  }

  exampleSelect.replaceChildren(...EXAMPLES.map((e) => { const o = h('option', '', e.title); o.value = e.id; return o; }));
  $('#load-btn').addEventListener('click', () => loadExample(exampleSelect.value));
  $('#viz-btn').addEventListener('click', () => analyze(true));
  $('#clear-btn').addEventListener('click', () => { editor.setValue(''); $<HTMLElement>('#example-note').textContent = ''; current = null; analyze(true); });
  $('#copy-btn').addEventListener('click', async () => {
    const b = $<HTMLButtonElement>('#copy-btn');
    try { await navigator.clipboard.writeText(editor.getValue()); } catch { editor.textarea.select(); doc.execCommand('copy'); }
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 900);
  });
  moduleSelect.addEventListener('change', () => openModule(moduleSelect.value));
  $('#zoom-in').addEventListener('click', () => interactions.zoomBy(1.25));
  $('#zoom-out').addEventListener('click', () => interactions.zoomBy(0.8));
  $('#fit-btn').addEventListener('click', () => interactions.fit());
  $('#reset-btn').addEventListener('click', () => { const m = model(); if (m) { renderer.render(m, layoutModel(m)); interactions.fit(); select(null); } });
  traceToggle.addEventListener('change', updateHighlight);

  const bg = (): string => getComputedStyle(root).getPropertyValue('--bg').trim() || '#ffffff';
  $('#export-svg').addEventListener('click', () => { const m = model(); if (m) exportSvgFile(svg, renderer.bounds(), m.name, bg()); });
  $('#export-png').addEventListener('click', async () => {
    const m = model();
    if (!m) return;
    try { await exportPngFile(svg, renderer.bounds(), m.name, bg()); } catch (e) { setStatus(`PNG export failed: ${e instanceof Error ? e.message : e}`, 'failed'); }
  });

  const themeBtn = $<HTMLButtonElement>('#theme-toggle');
  const setTheme = (t: string): void => {
    root.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch { /* storage unavailable */ }
    themeBtn.textContent = t === 'dark' ? 'Light mode' : 'Dark mode';
  };
  let saved: string | null = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* storage unavailable */ }
  setTheme(saved === 'light' ? 'light' : 'dark');
  themeBtn.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

  loadExample(DEFAULT_EXAMPLE.id);

  return {
    editor, renderer, interactions, analyze, loadExample, select, openModule,
    get project() { return project; },
    get current() { return current; },
    get selection() { return selection; },
    destroy: () => { clearTimeout(timer); interactions.destroy(); },
  };
}

if (!(globalThis as { __RTLV_NO_AUTOMOUNT__?: boolean }).__RTLV_NO_AUTOMOUNT__ && typeof document !== 'undefined' && document.getElementById('app')) {
  mountApp();
}
