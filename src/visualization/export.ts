import { fileSafeName } from '../utils/escaping';

const STYLE_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'opacity'];

/** Builds a standalone SVG string with computed styles inlined so it renders without the app stylesheet. */
export function buildSvgString(svg: SVGSVGElement, bounds: { x: number; y: number; w: number; h: number }, background?: string): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const origAll = svg.querySelectorAll('*');
  const cloneAll = clone.querySelectorAll('*');
  origAll.forEach((o, i) => {
    const c = cloneAll[i];
    if (!c) return;
    const cs = getComputedStyle(o);
    c.setAttribute('style', STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).filter((s) => !s.endsWith(':')).join(';'));
    c.removeAttribute('tabindex');
  });
  clone.querySelectorAll('.hit').forEach((n) => n.remove());
  const vp = clone.querySelector('.viewport');
  vp?.removeAttribute('transform');
  clone.removeAttribute('class');
  clone.removeAttribute('style');
  clone.removeAttribute('tabindex');
  clone.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`);
  clone.setAttribute('width', String(Math.ceil(bounds.w)));
  clone.setAttribute('height', String(Math.ceil(bounds.h)));
  if (background) {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', String(bounds.x)); r.setAttribute('y', String(bounds.y));
    r.setAttribute('width', String(bounds.w)); r.setAttribute('height', String(bounds.h));
    r.setAttribute('fill', background);
    clone.insertBefore(r, clone.firstChild);
  }
  return new XMLSerializer().serializeToString(clone);
}

export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportSvgFile(svg: SVGSVGElement, bounds: { x: number; y: number; w: number; h: number }, moduleName: string, background?: string): void {
  downloadBlob(`${fileSafeName(moduleName)}.svg`, new Blob([buildSvgString(svg, bounds, background)], { type: 'image/svg+xml' }));
}

export async function svgStringToPng(svgText: string, w: number, h: number, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function exportPngFile(svg: SVGSVGElement, bounds: { x: number; y: number; w: number; h: number }, moduleName: string, background?: string): Promise<void> {
  const blob = await svgStringToPng(buildSvgString(svg, bounds, background), bounds.w, bounds.h);
  downloadBlob(`${fileSafeName(moduleName)}.png`, blob);
}
