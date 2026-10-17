import { analyzeSource } from '../../src/analysis/analyze';
import type { HwNode, ModuleModel } from '../../src/analysis/hardware-model';

export function top(src: string, name?: string): ModuleModel {
  const p = analyzeSource(src);
  const m = p.modules.get(name ?? p.top ?? '');
  if (!m) throw new Error('no module: ' + p.diagnostics.map((d) => d.message).join('; '));
  return m;
}
export const kinds = (m: ModuleModel, kind: string): HwNode[] => m.nodes.filter((n) => n.kind === kind);
export const diag = (m: ModuleModel, re: RegExp) => m.diagnostics.find((d) => re.test(d.message));
export const hasDiag = (m: ModuleModel, re: RegExp): boolean => !!diag(m, re);
/** Nodes feeding the given node. */
export const sources = (m: ModuleModel, id: string): HwNode[] =>
  m.connections.filter((c) => c.to.node === id).map((c) => m.nodes.find((n) => n.id === c.from.node)!);
export const srcOfPin = (m: ModuleModel, id: string, pin: string): HwNode | undefined => {
  const c = m.connections.find((x) => x.to.node === id && x.to.pin === pin);
  return c ? m.nodes.find((n) => n.id === c.from.node) : undefined;
};

/** Diagnostics for the whole project, including parse-time ones that are not attached to a module. */
export const projectHas = (src: string, re: RegExp): boolean => analyzeSource(src).diagnostics.some((d) => re.test(d.message));
