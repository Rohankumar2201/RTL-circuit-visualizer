import { computeStatus, DiagnosticBag, type Diagnostic } from '../parser/diagnostics';
import { parseSource } from '../parser/module-parser';
import type { ModuleAst } from '../parser/types';
import { MAX_MODULES, validateSource } from '../utils/validation';
import {
  checkDrivers, createOutputNodes, createPortNodes, declareSignals, pruneUnusedNodes, resolvePending,
} from './connectivity';
import { lowerCombBlock, lowerContinuous } from './combinational';
import { buildHierarchy, findRecursion, findTopModules, lowerInstances, type HierarchyNode } from './hierarchy';
import { LimitError, ModelBuilder, type ModuleModel } from './hardware-model';
import { lowerSeqBlock } from './sequential';
import { evalParams } from './widths';
import type { AnalysisStatus } from '../parser/diagnostics';

export interface ProjectModel {
  source: string;
  modules: Map<string, ModuleModel>;
  order: string[];
  top: string | null;
  diagnostics: Diagnostic[];
  status: AnalysisStatus;
  hierarchy: HierarchyNode | null;
  empty: boolean;
}

export function analyzeModule(ast: ModuleAst, lib: Map<string, ModuleAst>): ModuleModel {
  const b = new ModelBuilder(ast, lib);
  try {
    b.params = evalParams(ast.params, new Map(), b.diags);
    declareSignals(b);
    createPortNodes(b);
    for (const s of ast.skipped) { b.partial = true; s.assigned.forEach((n) => b.unmodeled.add(n)); }
    lowerContinuous(b);
    ast.always.forEach((blk, i) => {
      if (blk.sens.type === 'edges') lowerSeqBlock(b, blk, i);
      else lowerCombBlock(b, blk, i);
    });
    lowerInstances(b);
    createOutputNodes(b);
    pruneUnusedNodes(b);
    resolvePending(b);
    checkDrivers(b);
  } catch (e) {
    if (!(e instanceof LimitError)) throw e;
    b.diags.error('limits', e.message, ast.loc);
    b.partial = true;
  }
  for (const d of b.drivers) b.signals.get(d.signal)?.drivers.push(d);
  for (const n of b.unmodeled) { const s = b.signals.get(n); if (s) s.unmodeled = true; }
  const diagnostics = b.diags.items.map((d) => ({ ...d, module: ast.name }));
  return {
    name: ast.name, ast, signals: [...b.signals.values()], nodes: b.nodes, connections: b.conns,
    instances: b.instances, diagnostics, partial: b.partial,
    status: computeStatus({ diagnostics, partial: b.partial, modelCount: 1 }),
  };
}

export function analyzeSource(source: string): ProjectModel {
  const bag = new DiagnosticBag();
  const limit = validateSource(source);
  if (limit.length) return { source, modules: new Map(), order: [], top: null, diagnostics: limit, status: 'failed', hierarchy: null, empty: false };
  if (!source.trim()) return { source, modules: new Map(), order: [], top: null, diagnostics: [], status: 'failed', hierarchy: null, empty: true };

  const parsed = parseSource(source);
  bag.items.push(...parsed.diagnostics);
  const lib = new Map<string, ModuleAst>();
  for (const m of parsed.modules) {
    if (lib.has(m.name)) bag.error('declaration', `Module '${m.name}' is defined more than once; the first definition is used`, m.loc);
    else if (lib.size >= MAX_MODULES) bag.error('limits', `More than ${MAX_MODULES} modules; '${m.name}' was ignored`, m.loc);
    else lib.set(m.name, m);
  }
  const modules = new Map<string, ModuleModel>();
  for (const ast of lib.values()) modules.set(ast.name, analyzeModule(ast, lib));

  const rec = findRecursion(lib);
  for (const [name, cycle] of rec) {
    const ast = lib.get(name)!;
    bag.error('hierarchy', `Module '${name}' is part of a recursive instantiation (${cycle.join(' → ')})`, ast.loc, { explanation: 'Recursive hierarchy cannot be built into hardware; instances are shown unexpanded.' });
  }

  const order = [...modules.keys()];
  const top = order.length ? findTopModules(modules)[0] : null;
  const diagnostics = [...bag.items, ...[...modules.values()].flatMap((m) => m.diagnostics)];
  const partial = [...modules.values()].some((m) => m.partial);
  return {
    source, modules, order, top, diagnostics,
    status: computeStatus({ diagnostics, partial, modelCount: modules.size }),
    hierarchy: top ? buildHierarchy(lib, top) : null,
    empty: false,
  };
}
