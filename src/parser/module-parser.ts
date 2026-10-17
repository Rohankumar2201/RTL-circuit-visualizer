import { DiagnosticBag, type Diagnostic } from './diagnostics';
import { ExprParser, ParseError, describeToken, locOf } from './expression-parser';
import { tokenize } from './lexer';
import type {
  AlwaysBlock, CaseItem, Dir, EdgeRef, Expr, Instance, Loc, ModuleAst, NetKind, ParamDecl,
  ParamOverride, PortConn, RangeAst, Sens, Stmt, Token,
} from './types';

const GATE_PRIMS = new Set(['and', 'or', 'nand', 'nor', 'xor', 'xnor', 'not', 'buf', 'bufif0', 'bufif1', 'notif0', 'notif1']);
const ASSIGN_PREV = new Set([';', 'begin', 'else', ')', ':', 'end', 'assign']);

export interface ParseResult { modules: ModuleAst[]; diagnostics: Diagnostic[] }

/** Best-effort scan for names assigned inside a token range that could not be parsed. */
export function scanAssigned(tokens: Token[], from: number, to: number): string[] {
  const out = new Set<string>();
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (t.kind !== 'id') continue;
    let j = i + 1;
    if (tokens[j]?.text === '[') {
      let d = 0;
      for (; j < to; j++) {
        if (tokens[j].text === '[') d++;
        else if (tokens[j].text === ']' && --d === 0) { j++; break; }
      }
    }
    const op = tokens[j];
    const prev = tokens[i - 1];
    if (op && op.kind === 'op' && (op.text === '<=' || op.text === '=') && (i === from || (prev && ASSIGN_PREV.has(prev.text)))) out.add(t.text);
  }
  return [...out];
}

class ModuleParser extends ExprParser {
  diags = new DiagnosticBag();
  modules: ModuleAst[] = [];

  parseAll(): ModuleAst[] {
    while (!this.atEof()) {
      if (this.at('module')) { this.module(); continue; }
      const t = this.peek();
      if (this.at('endmodule')) this.diags.error('syntax', "'endmodule' without a matching 'module'", locOf(t));
      else this.diags.warn('unsupported', `Top-level ${describeToken(t)} is outside a module and was ignored`, locOf(t));
      while (!this.atEof() && !this.at('module')) this.next();
    }
    return this.modules;
  }

  private report(e: ParseError): void {
    this.diags.add(e.unsupported ? 'warning' : 'error', e.unsupported ? 'unsupported' : 'syntax', e.message, locOf(e.tok), { suggestion: e.suggestion });
  }

  private module(): void {
    const kw = this.next();
    let nameTok: Token;
    try { nameTok = this.ident('a module name'); } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.report(e); this.skipToEndmodule(); return;
    }
    const mod: ModuleAst = {
      name: nameTok.text, loc: locOf(kw), params: [], ports: [], nets: [], assigns: [], always: [], instances: [], skipped: [],
    };
    try {
      if (this.at('#')) { this.next(); this.headerParams(mod); }
      if (this.at('(')) this.ports(mod);
      this.expect(';', 'after the module header');
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.report(e);
      this.diags.error('syntax', `Module '${mod.name}' was skipped because its header could not be parsed`, locOf(kw));
      this.skipToEndmodule();
      return;
    }
    while (!this.at('endmodule')) {
      if (this.atEof()) { this.diags.error('syntax', `Missing 'endmodule' for module '${mod.name}'`, locOf(kw)); break; }
      const start = this.pos;
      try { this.item(mod); } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.report(e);
        if (this.pos === start) this.next();
        while (!this.atEof() && !this.at('endmodule') && !this.at(';')) this.next();
        this.accept(';');
      }
    }
    this.accept('endmodule');
    this.modules.push(mod);
  }

  private skipToEndmodule(): void {
    while (!this.atEof() && !this.at('endmodule')) this.next();
    this.accept('endmodule');
  }

  private range(): RangeAst {
    this.expect('[');
    const msb = this.expr();
    this.expect(':', 'in the range');
    const lsb = this.expr();
    this.expect(']', 'to close the range');
    return { msb, lsb };
  }

  private skipParamType(): void {
    while (this.at('integer') || this.at('signed') || this.at('unsigned') || this.at('real')) this.next();
    if (this.at('[')) this.range();
  }

  private headerParams(mod: ModuleAst): void {
    this.expect('(');
    let local = false;
    while (!this.at(')')) {
      if (this.at('parameter') || this.at('localparam')) local = this.next().text === 'localparam';
      this.skipParamType();
      const name = this.ident('a parameter name');
      this.expect('=', 'in the parameter declaration');
      mod.params.push({ name: name.text, value: this.expr(), local, loc: locOf(name) });
      if (!this.accept(',')) break;
    }
    this.expect(')', 'to close the parameter list');
  }

  private paramDecl(into: ParamDecl[]): void {
    const local = this.next().text === 'localparam';
    this.skipParamType();
    do {
      const name = this.ident('a parameter name');
      this.expect('=', 'in the parameter declaration');
      into.push({ name: name.text, value: this.expr(), local, loc: locOf(name) });
    } while (this.accept(','));
    this.expect(';');
  }

  private ports(mod: ModuleAst): void {
    this.expect('(');
    if (this.accept(')')) return;
    if (!(this.at('input') || this.at('output') || this.at('inout'))) {
      throw new ParseError('Non-ANSI port lists are not supported', this.peek(), true, 'Declare direction and type inside the port list, e.g. module m(input a, output y);');
    }
    let dir: Dir = 'input', kind: NetKind = 'wire', range: RangeAst | null = null, signed = false;
    for (;;) {
      if (this.at('input') || this.at('output') || this.at('inout')) {
        dir = this.next().text as Dir; kind = 'wire'; range = null; signed = false;
        if (this.at('wire') || this.at('reg') || this.at('logic')) kind = this.next().text as NetKind;
        if (this.accept('signed')) signed = true;
        if (this.at('[')) range = this.range();
      }
      const name = this.ident('a port name');
      if (this.at('=')) throw new ParseError('Port default values are not supported', this.peek(), true);
      mod.ports.push({ name: name.text, dir, kind, range, signed, loc: locOf(name) });
      if (!this.accept(',')) break;
    }
    this.expect(')', 'to close the port list');
  }

  private item(mod: ModuleAst): void {
    const t = this.peek();
    if (t.kind === 'kw') {
      switch (t.text) {
        case 'wire': case 'reg': case 'logic': return this.netDecl(mod);
        case 'parameter': case 'localparam': return this.paramDecl(mod.params);
        case 'assign': return this.contAssign(mod);
        case 'always': case 'always_comb': case 'always_ff': case 'always_latch': return this.always(mod);
        case 'input': case 'output': case 'inout':
          throw new ParseError('Port directions must be declared in the module header (non-ANSI declarations are not supported)', t, true);
        case 'initial': case 'for': return this.skipItem(mod, t.text === 'initial' ? 'initial block' : 'for loop', 'statement');
        case 'function': return this.skipItem(mod, 'function', 'endfunction');
        case 'task': return this.skipItem(mod, 'task', 'endtask');
        case 'generate': return this.skipItem(mod, 'generate block', 'endgenerate');
        case 'specify': return this.skipItem(mod, 'specify block', 'endspecify');
        case 'genvar': case 'integer': case 'real': case 'time': case 'defparam':
          return this.skipItem(mod, `'${t.text}' declaration`, ';');
        default: break;
      }
    }
    if (this.accept(';')) return;
    if (t.kind === 'id' && GATE_PRIMS.has(t.text) && this.peek(1).kind === 'id') {
      throw new ParseError(`Gate primitive '${t.text}' is not supported`, t, true, 'Use a continuous assign instead, e.g. assign y = a & b;');
    }
    if (t.kind === 'id' && (this.peek(1).kind === 'id' || this.at('#', 1))) return this.instance(mod);
    throw new ParseError(`Unexpected ${describeToken(t)} in module body`, t);
  }

  private skipItem(mod: ModuleAst, what: string, until: string): void {
    const start = this.pos;
    const first = this.next();
    if (until === 'statement') this.skipStatement();
    else if (until === ';') { while (!this.atEof() && !this.at(';') && !this.at('endmodule')) this.next(); this.accept(';'); }
    else { while (!this.atEof() && !this.at(until) && !this.at('endmodule')) this.next(); this.accept(until); }
    this.diags.warn('unsupported', `Unsupported construct skipped: ${what}`, locOf(first), {
      explanation: 'This construct is not part of the supported RTL subset, so the hardware it describes is not shown.',
    });
    mod.skipped.push({ what, loc: locOf(first), assigned: scanAssigned(this.tokens, start, this.pos) });
  }

  private netDecl(mod: ModuleAst): void {
    const kind = this.next().text as NetKind;
    const signed = this.accept('signed');
    const range = this.at('[') ? this.range() : null;
    do {
      const name = this.ident('a signal name');
      if (this.at('[')) throw new ParseError('Arrays and memories are not supported', this.peek(), true);
      const init = this.accept('=') ? this.expr() : null;
      mod.nets.push({ name: name.text, kind, range, signed, init, loc: locOf(name) });
    } while (this.accept(','));
    this.expect(';', 'after the declaration');
  }

  private lvalue(): Expr {
    if (this.at('{')) {
      const open = this.next();
      const parts = [this.lvalue()];
      while (this.accept(',')) parts.push(this.lvalue());
      this.expect('}', 'to close the concatenation');
      return { k: 'concat', parts, loc: locOf(open) };
    }
    const t = this.ident('an assignment target');
    if (this.at('[')) {
      this.next();
      const msb = this.expr();
      let lsb: Expr | null = null;
      if (this.at('+:') || this.at('-:')) throw new ParseError('Indexed part-selects are not supported', this.peek(), true);
      if (this.accept(':')) lsb = this.expr();
      this.expect(']', 'to close the select');
      return { k: 'index', base: t.text, msb, lsb, loc: locOf(t) };
    }
    return { k: 'id', name: t.text, loc: locOf(t) };
  }

  private contAssign(mod: ModuleAst): void {
    this.next();
    if (this.at('#')) throw new ParseError('Delays on assignments are not supported', this.peek(), true);
    do {
      const lhs = this.lvalue();
      const eq = this.expect('=', 'in the assign statement');
      const rhs = this.expr();
      mod.assigns.push({ lhs, rhs, loc: locOf(eq) });
    } while (this.accept(','));
    this.expect(';', 'after the assign statement');
  }

  private always(mod: ModuleAst): void {
    const kw = this.next();
    const kind = kw.text as AlwaysBlock['kind'];
    const sens = this.sensitivity(kind, kw);
    const bodyStart = this.pos;
    try {
      mod.always.push({ kind, sens, body: this.statement(), loc: locOf(kw) });
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.report(e);
      this.pos = bodyStart;
      this.skipStatement();
      this.diags.warn('unsupported', `Always block skipped because it could not be fully analyzed`, locOf(kw), {
        explanation: 'Signals assigned in this block are not modeled; they are shown as unmodeled rather than undriven.',
      });
      mod.skipped.push({ what: 'always block', loc: locOf(kw), assigned: scanAssigned(this.tokens, bodyStart, this.pos) });
    }
  }

  private sensitivity(kind: AlwaysBlock['kind'], kw: Token): Sens {
    if (!this.accept('@')) {
      if (kind === 'always') throw new ParseError("'always' without an event control (e.g. '#delay') is not supported", this.peek(), true);
      if (kind === 'always_ff') throw new ParseError("'always_ff' requires an event control", this.peek());
      return { type: 'star' };
    }
    if (this.accept('*')) return { type: 'star' };
    this.expect('(', 'after @');
    if (this.accept('*')) { this.expect(')'); return { type: 'star' }; }
    const edges: EdgeRef[] = [];
    const levels: string[] = [];
    do {
      if (this.at('posedge') || this.at('negedge')) {
        const e = this.next();
        edges.push({ edge: e.text as EdgeRef['edge'], signal: this.ident('a signal name').text, loc: locOf(e) });
      } else levels.push(this.ident('a signal name').text);
    } while (this.accept('or') || this.accept(','));
    this.expect(')', 'to close the sensitivity list');
    if (edges.length && levels.length) throw new ParseError('Mixed edge and level sensitivity is not supported', kw, true);
    return edges.length ? { type: 'edges', edges } : { type: 'levels', signals: levels };
  }

  statement(): Stmt[] {
    const t = this.peek();
    if (this.accept(';')) return [];
    if (this.at('begin')) {
      this.next();
      if (this.accept(':')) this.ident('a block label');
      const out: Stmt[] = [];
      while (!this.at('end')) {
        if (this.atEof()) throw new ParseError("Missing 'end' for 'begin'", t);
        out.push(...this.statement());
      }
      this.next();
      if (this.at(':') && this.peek(1).kind === 'id') { this.next(); this.next(); }
      return out;
    }
    if (this.at('if')) {
      this.next();
      this.expect('(', 'after if');
      const cond = this.expr();
      this.expect(')', 'to close the if condition');
      const then = this.statement();
      const els = this.accept('else') ? this.statement() : null;
      return [{ k: 'if', cond, then, else: els, loc: locOf(t) }];
    }
    if (this.at('case') || this.at('casez') || this.at('casex')) return [this.caseStmt()];
    if (t.kind === 'kw' && ['for', 'while', 'repeat', 'forever', 'wait', 'fork', 'disable', 'integer'].includes(t.text)) {
      throw new ParseError(`'${t.text}' statements inside procedural blocks are not supported`, t, true);
    }
    if (t.kind === 'id' && t.text.startsWith('$')) throw new ParseError(`System task '${t.text}' is not supported`, t, true);
    if (this.at('#') || this.at('@')) throw new ParseError('Timing controls inside procedural blocks are not supported', t, true);
    const lhs = this.lvalue();
    if (!this.at('<=') && !this.at('=')) throw new ParseError(`Expected '<=' or '=' but found ${describeToken(this.peek())}`, this.peek());
    const nonblocking = this.next().text === '<=';
    if (this.at('#')) throw new ParseError('Intra-assignment delays are not supported', this.peek(), true);
    const rhs = this.expr();
    this.expect(';', 'after the assignment');
    return [{ k: 'assign', lhs, rhs, nonblocking, loc: locOf(t) }];
  }

  private caseStmt(): Stmt {
    const kw = this.next();
    this.expect('(', 'after case');
    const sel = this.expr();
    this.expect(')', 'to close the case selector');
    const items: CaseItem[] = [];
    while (!this.at('endcase')) {
      if (this.atEof()) throw new ParseError("Missing 'endcase'", kw);
      const loc = locOf(this.peek());
      if (this.accept('default')) {
        this.accept(':');
        items.push({ labels: null, body: this.statement(), loc });
      } else {
        const labels = [this.expr()];
        while (this.accept(',')) labels.push(this.expr());
        this.expect(':', 'after the case label');
        items.push({ labels, body: this.statement(), loc });
      }
    }
    this.next();
    return { k: 'case', kind: kw.text as 'case' | 'casez' | 'casex', sel, items, loc: locOf(kw) };
  }

  private skipParens(): void {
    if (!this.at('(')) return;
    let d = 0;
    do {
      if (this.at('(')) d++;
      else if (this.at(')')) d--;
      this.next();
    } while (d > 0 && !this.atEof());
  }

  /** Token-level skip of one statement; never throws. */
  skipStatement(): void {
    if (this.atEof()) return;
    if (this.at('begin')) {
      this.next();
      let d = 1;
      while (d > 0 && !this.atEof() && !this.at('endmodule')) { if (this.at('begin')) d++; else if (this.at('end')) d--; this.next(); }
    } else if (this.at('case') || this.at('casez') || this.at('casex')) {
      this.next();
      let d = 1;
      while (d > 0 && !this.atEof() && !this.at('endmodule')) {
        if (this.at('case') || this.at('casez') || this.at('casex')) d++; else if (this.at('endcase')) d--;
        this.next();
      }
    } else if (this.at('if')) {
      this.next(); this.skipParens(); this.skipStatement();
      if (this.accept('else')) this.skipStatement();
    } else if (this.at('for') || this.at('while') || this.at('repeat') || this.at('forever')) {
      this.next(); this.skipParens(); this.skipStatement();
    } else if (this.accept(';')) {
      /* empty */
    } else {
      while (!this.atEof() && !this.at(';') && !this.at('endmodule')) this.next();
      this.accept(';');
    }
  }

  private instance(mod: ModuleAst): void {
    const modTok = this.ident();
    const params: ParamOverride[] = [];
    if (this.accept('#')) {
      this.expect('(');
      if (!this.at(')')) {
        do {
          if (this.accept('.')) {
            const n = this.ident('a parameter name');
            this.expect('(');
            const e = this.expr();
            this.expect(')');
            params.push({ name: n.text, expr: e });
          } else params.push({ name: null, expr: this.expr() });
        } while (this.accept(','));
      }
      this.expect(')', 'to close the parameter overrides');
    }
    const nameTok = this.ident('an instance name');
    if (this.at('[')) throw new ParseError('Instance arrays are not supported', this.peek(), true);
    this.expect('(', 'after the instance name');
    const conns: PortConn[] = [];
    if (!this.at(')')) {
      do {
        const loc = locOf(this.peek());
        if (this.accept('.')) {
          if (this.at('*')) throw new ParseError("'.*' implicit port connections are not supported", this.peek(), true);
          const p = this.ident('a port name');
          this.expect('(');
          const expr = this.at(')') ? null : this.expr();
          this.expect(')', 'to close the port connection');
          conns.push({ port: p.text, expr, loc: locOf(p) });
        } else conns.push({ port: null, expr: this.expr(), loc });
      } while (this.accept(','));
    }
    this.expect(')', 'to close the instance port list');
    this.expect(';', 'after the instance');
    const inst: Instance = { module: modTok.text, name: nameTok.text, params, conns, loc: locOf(modTok) };
    mod.instances.push(inst);
  }
}

export function parseSource(src: string): ParseResult {
  const lexed = tokenize(src);
  const parser = new ModuleParser(lexed.tokens);
  const modules = parser.parseAll();
  return { modules, diagnostics: [...lexed.diagnostics, ...parser.diags.items] };
}
