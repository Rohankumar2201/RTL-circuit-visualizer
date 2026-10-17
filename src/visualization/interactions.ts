import { CircuitRenderer, type Selection, type View } from './renderer';

export interface InteractionOptions { onSelect: (s: Selection | null) => void; onView?: (v: View) => void }

const MIN_K = 0.15, MAX_K = 4;

export class CanvasInteractions {
  view: View = { k: 1, tx: 0, ty: 0 };
  private drag: { kind: 'node' | 'pan' | 'bg' | 'conn'; id?: string; x: number; y: number; moved: boolean } | null = null;
  private cleanup: Array<() => void> = [];

  constructor(private svg: SVGSVGElement, private renderer: CircuitRenderer, private opts: InteractionOptions) {
    const on = <T extends Event>(t: EventTarget, type: string, fn: (e: T) => void, o?: AddEventListenerOptions): void => {
      t.addEventListener(type, fn as EventListener, o);
      this.cleanup.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on<PointerEvent>(svg, 'pointerdown', (e) => this.down(e));
    on<PointerEvent>(svg, 'pointermove', (e) => this.move(e));
    on<PointerEvent>(svg, 'pointerup', () => this.up());
    on<PointerEvent>(svg, 'pointercancel', () => { this.drag = null; });
    on<WheelEvent>(svg, 'wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    on<KeyboardEvent>(svg, 'keydown', (e) => {
      const t = e.target as Element;
      const node = t.closest?.('[data-node]');
      if ((e.key === 'Enter' || e.key === ' ') && node) { e.preventDefault(); this.opts.onSelect({ type: 'node', id: node.getAttribute('data-node')! }); }
      if (e.key === 'Escape') this.opts.onSelect(null);
    });
  }

  destroy(): void { this.cleanup.forEach((f) => f()); this.cleanup = []; }

  private size(): { w: number; h: number } {
    return { w: this.svg.clientWidth || 800, h: this.svg.clientHeight || 600 };
  }

  private apply(): void { this.renderer.setView(this.view); this.opts.onView?.(this.view); }

  setView(v: View): void { this.view = v; this.apply(); }

  zoomBy(f: number, cx?: number, cy?: number): void {
    const { w, h } = this.size();
    const x = cx ?? w / 2, y = cy ?? h / 2;
    const k = Math.min(MAX_K, Math.max(MIN_K, this.view.k * f));
    const r = k / this.view.k;
    this.view = { k, tx: x - (x - this.view.tx) * r, ty: y - (y - this.view.ty) * r };
    this.apply();
  }

  fit(): void {
    const b = this.renderer.bounds();
    const { w, h } = this.size();
    const k = Math.min(MAX_K, Math.max(MIN_K, Math.min((w - 24) / b.w, (h - 24) / b.h, 1.5)));
    this.view = { k, tx: (w - b.w * k) / 2 - b.x * k, ty: (h - b.h * k) / 2 - b.y * k };
    this.apply();
  }

  private down(e: PointerEvent): void {
    const t = e.target as Element;
    const nodeEl = t.closest?.('[data-node]');
    const wireEl = t.closest?.('[data-conn]');
    try { this.svg.setPointerCapture?.(e.pointerId); } catch { /* pointer may already be released */ }
    if (nodeEl) {
      const id = nodeEl.getAttribute('data-node')!;
      this.drag = { kind: 'node', id, x: e.clientX, y: e.clientY, moved: false };
      this.opts.onSelect({ type: 'node', id });
    } else if (wireEl) this.drag = { kind: 'conn', id: wireEl.getAttribute('data-conn')!, x: e.clientX, y: e.clientY, moved: false };
    else this.drag = { kind: 'bg', x: e.clientX, y: e.clientY, moved: false };
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    d.moved = true; d.x = e.clientX; d.y = e.clientY;
    if (d.kind === 'node') this.renderer.moveNode(d.id!, dx / this.view.k, dy / this.view.k);
    else { this.view = { ...this.view, tx: this.view.tx + dx, ty: this.view.ty + dy }; this.apply(); }
  }

  private up(): void {
    const d = this.drag;
    this.drag = null;
    if (!d || d.moved) return;
    if (d.kind === 'conn') this.opts.onSelect({ type: 'conn', id: d.id! });
    else if (d.kind === 'bg') this.opts.onSelect(null);
  }
}
