import { collectIdentifiers } from '../parser/expression-parser';
import type { Expr, Instance, ModuleAst } from '../parser/types';
import { buildExpr, drive, handleUnsupported, lvalueTargets, sliceNode } from './combinational';
import { inPin, outPin, type ModelBuilder, type ModuleModel, type Pin } from './hardware-model';
import { evalConst, evalParams, rangeWidth, selfWidth, type ConstEnv } from './widths';

export interface ChildPort { name: string; dir: 'input' | 'output' | 'inout'; width: number | null }

export function childPorts(child: ModuleAst, overrides: ConstEnv): ChildPort[] {
  const env = evalParams(child.params, overrides);
  return child.ports.map((p) => {
    if (!p.range) return { name: p.name, dir: p.dir, width: 1 };
    const m = evalConst(p.range.msb, env), l = evalConst(p.range.lsb, env);
    return { name: p.name, dir: p.dir, width: m === null || l === null ? null : rangeWidth({ msb: Number(m), lsb: Number(l) }) };
  });
}

export function lowerInstances(b: ModelBuilder): void {
  b.ast.instances.forEach((inst, i) => {
    const m = b.mark();
    try { lowerInstance(b, inst, i); } catch (err) {
      handleUnsupported(b, err, inst.loc);
      b.rollback(m);
    }
  });
}

function lowerInstance(b: ModelBuilder, inst: Instance, index: number): void {
  const child = b.lib.get(inst.module);
  const nodeId = `inst:${inst.name}`;
  if (b.instances.some((x) => x.name === inst.name)) b.diags.error('declaration', `Instance name '${inst.name}' is used more than once`, inst.loc);

  if (!child) {
    b.diags.error('hierarchy', `Unknown module '${inst.module}' (instance '${inst.name}')`, inst.loc, {
      explanation: 'The module definition is not in the source, so its ports and internals are unknown. It is drawn as a black box without wires.',
      suggestion: `Add a definition of '${inst.module}' to the source.`,
    });
    b.partial = true;
    const names = inst.conns.map((c, k) => c.port ?? `p${k}`);
    b.addNode('instance', 'INSTANCE', {
      id: nodeId, label: inst.module, width: null, loc: inst.loc, pins: names.map((n) => inPin(n, null)),
      props: { instName: inst.name, module: inst.module, known: false }, explain: `Instance '${inst.name}' of unknown module '${inst.module}'.`,
    });
    for (const c of inst.conns) if (c.expr) collectIdentifiers(c.expr).forEach((n) => { b.unmodeled.add(n); b.markUsed(n); });
    b.instances.push({ name: inst.name, module: inst.module, known: false, nodeId });
    return;
  }

  const overrides: ConstEnv = new Map();
  const free = child.params.filter((p) => !p.local);
  inst.params.forEach((p, k) => {
    const target = p.name ?? free[k]?.name;
    const v = evalConst(p.expr, b.params);
    if (!target || !free.some((f) => f.name === target)) b.diags.error('hierarchy', `Module '${child.name}' has no parameter '${target ?? '#' + k}'`, inst.loc);
    else if (v === null) b.diags.error('hierarchy', `Parameter override '${target}' on '${inst.name}' is not constant`, inst.loc);
    else overrides.set(target, v);
  });
  const ports = childPorts(child, overrides);
  const pins: Pin[] = [
    ...ports.filter((p) => p.dir !== 'output').map((p) => inPin(p.name, p.width)),
    ...ports.filter((p) => p.dir === 'output').map((p) => outPin(p.name, p.width)),
  ];
  const node = b.addNode('instance', 'INSTANCE', {
    id: nodeId, label: child.name, width: null, loc: inst.loc, pins,
    props: { instName: inst.name, module: child.name, known: true, overrides: Object.fromEntries([...overrides].map(([k, v]) => [k, v.toString()])) },
    explain: `Instance '${inst.name}' of module '${child.name}'. Its internal hardware is not expanded here; open the module to inspect it.`,
  });
  b.instances.push({ name: inst.name, module: child.name, known: true, nodeId: node.id });

  const seen = new Set<string>();
  inst.conns.forEach((c, k) => {
    const port = c.port ? ports.find((p) => p.name === c.port) : ports[k];
    if (c.port === null && !port) { b.diags.error('hierarchy', `Too many positional connections on '${inst.name}'`, c.loc); return; }
    if (!port) { b.diags.error('hierarchy', `Module '${child.name}' has no port '${c.port}'`, c.loc); return; }
    if (seen.has(port.name)) { b.diags.error('hierarchy', `Port '${port.name}' of '${inst.name}' is connected more than once`, c.loc); return; }
    seen.add(port.name);
    if (!c.expr) {
      if (port.dir === 'input') b.diags.warn('connectivity', `Input port '${port.name}' of '${inst.name}' is left unconnected`, c.loc);
      return;
    }
    if (port.dir === 'inout') { b.diags.warn('unsupported', `Inout port '${port.name}' of '${inst.name}' is not modeled`, c.loc); return; }
    const sw = selfWidth(c.expr, { widthOf: (n) => b.signals.get(n)?.width ?? null, env: b.params });
    if (port.dir === 'input') {
      if (port.width !== null && sw !== null && sw !== port.width) b.diags.warn('width', `Port '${port.name}' of '${inst.name}' is ${port.width} bits but is connected to ${sw} bits`, c.loc);
      b.connect(buildExpr(b, c.expr, port.width, null), { node: node.id, pin: port.name });
    } else {
      const targets = lvalueTargets(b, c.expr as Expr, true);
      const total = targets.reduce((s, t) => s + t.width, 0);
      if (port.width !== null && port.width !== total) b.diags.warn('width', `Port '${port.name}' of '${inst.name}' is ${port.width} bits but drives ${total} bits`, c.loc);
      const out = { type: 'pin' as const, node: node.id, pin: port.name, width: port.width };
      let hi = total - 1;
      for (const t of targets) {
        const lo = hi - t.width + 1;
        const part = targets.length === 1 ? out : sliceNode(b, out, lo, hi, `[${hi}:${lo}]`, c.loc);
        t.name && drive(b, t.name, part, t.lo, t.hi, 'instance', `inst:${inst.name}:${port.name}:${index}`, c.loc);
        hi = lo - 1;
      }
    }
  });
  for (const p of ports) {
    if (p.dir === 'input' && !seen.has(p.name)) b.diags.warn('connectivity', `Input port '${p.name}' of '${inst.name}' is not connected`, inst.loc, { suggestion: `Connect it: .${p.name}(...)` });
  }
}

export interface HierarchyNode {
  module: string;
  instance: string | null;
  known: boolean;
  recursive: boolean;
  children: HierarchyNode[];
}

export function findRecursion(asts: Map<string, ModuleAst>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const visit = (name: string, path: string[]): void => {
    const idx = path.indexOf(name);
    if (idx >= 0) { const cyc = [...path.slice(idx), name]; for (const m of path.slice(idx)) if (!result.has(m)) result.set(m, cyc); return; }
    const a = asts.get(name);
    if (!a) return;
    for (const i of a.instances) visit(i.module, [...path, name]);
  };
  for (const n of asts.keys()) visit(n, []);
  return result;
}

export function findTopModules(models: Map<string, ModuleModel>): string[] {
  const used = new Set<string>();
  for (const m of models.values()) for (const i of m.ast.instances) used.add(i.module);
  const tops = [...models.keys()].filter((k) => !used.has(k));
  return tops.length ? tops : [...models.keys()].slice(0, 1);
}

export function buildHierarchy(asts: Map<string, ModuleAst>, top: string, instance: string | null = null, path: string[] = []): HierarchyNode {
  const ast = asts.get(top);
  const recursive = path.includes(top);
  const node: HierarchyNode = { module: top, instance, known: !!ast, recursive, children: [] };
  if (!ast || recursive || path.length > 32) return node;
  node.children = ast.instances.map((i) => buildHierarchy(asts, i.module, i.name, [...path, top]));
  return node;
}
