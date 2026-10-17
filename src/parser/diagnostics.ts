import type { Loc } from './types';

export type Severity = 'error' | 'warning' | 'info';
export type Category =
  | 'syntax' | 'unsupported' | 'declaration' | 'width' | 'driver'
  | 'connectivity' | 'latch' | 'hierarchy' | 'sequential' | 'limits';

export interface Diagnostic {
  severity: Severity;
  category: Category;
  message: string;
  line?: number;
  col?: number;
  module?: string;
  explanation?: string;
  suggestion?: string;
}
export interface DiagExtra { explanation?: string; suggestion?: string }

export class DiagnosticBag {
  items: Diagnostic[] = [];
  private seen = new Set<string>();

  add(severity: Severity, category: Category, message: string, loc?: Loc | null, extra: DiagExtra = {}): void {
    const key = `${severity}|${category}|${message}|${loc?.line ?? ''}|${loc?.col ?? ''}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const d: Diagnostic = { severity, category, message };
    if (loc) { d.line = loc.line; d.col = loc.col; }
    if (extra.explanation) d.explanation = extra.explanation;
    if (extra.suggestion) d.suggestion = extra.suggestion;
    this.items.push(d);
  }
  error(category: Category, message: string, loc?: Loc | null, extra?: DiagExtra): void { this.add('error', category, message, loc, extra); }
  warn(category: Category, message: string, loc?: Loc | null, extra?: DiagExtra): void { this.add('warning', category, message, loc, extra); }
  info(category: Category, message: string, loc?: Loc | null, extra?: DiagExtra): void { this.add('info', category, message, loc, extra); }
  get errorCount(): number { return this.items.filter((d) => d.severity === 'error').length; }
}

export type AnalysisStatus = 'complete' | 'warnings' | 'partial' | 'failed';

export const STATUS_LABEL: Record<AnalysisStatus, string> = {
  complete: 'Analysis complete for supported constructs',
  warnings: 'Analysis complete with warnings',
  partial: 'Partial visualization',
  failed: 'Analysis failed',
};

export function computeStatus(o: { diagnostics: Diagnostic[]; partial: boolean; modelCount: number }): AnalysisStatus {
  if (o.modelCount === 0) return 'failed';
  if (o.partial || o.diagnostics.some((d) => d.severity === 'error')) return 'partial';
  if (o.diagnostics.some((d) => d.severity === 'warning')) return 'warnings';
  return 'complete';
}

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
export function sortDiagnostics(list: Diagnostic[]): Diagnostic[] {
  return [...list].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.line ?? 1e9) - (b.line ?? 1e9) || (a.col ?? 0) - (b.col ?? 0));
}
