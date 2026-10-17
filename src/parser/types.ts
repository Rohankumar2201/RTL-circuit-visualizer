export interface Loc { line: number; col: number }
export type TokKind = 'id' | 'num' | 'op' | 'kw' | 'str' | 'eof';
export interface Token extends Loc { kind: TokKind; text: string; offset: number }

export type Expr =
  | { k: 'num'; text: string; loc: Loc }
  | { k: 'id'; name: string; loc: Loc }
  | { k: 'index'; base: string; msb: Expr; lsb: Expr | null; loc: Loc }
  | { k: 'unary'; op: string; arg: Expr; loc: Loc }
  | { k: 'binary'; op: string; l: Expr; r: Expr; loc: Loc }
  | { k: 'ternary'; c: Expr; a: Expr; b: Expr; loc: Loc }
  | { k: 'concat'; parts: Expr[]; loc: Loc }
  | { k: 'repl'; count: Expr; parts: Expr[]; loc: Loc }
  | { k: 'call'; name: string; args: Expr[]; loc: Loc };

export interface RangeAst { msb: Expr; lsb: Expr }
export type Dir = 'input' | 'output' | 'inout';
export type NetKind = 'wire' | 'reg' | 'logic';

export interface PortDecl { name: string; dir: Dir; kind: NetKind; range: RangeAst | null; signed: boolean; loc: Loc }
export interface NetDecl { name: string; kind: NetKind; range: RangeAst | null; signed: boolean; init: Expr | null; loc: Loc }
export interface ParamDecl { name: string; value: Expr; local: boolean; loc: Loc }
export interface ContAssign { lhs: Expr; rhs: Expr; loc: Loc }

export interface CaseItem { labels: Expr[] | null; body: Stmt[]; loc: Loc }
export type Stmt =
  | { k: 'assign'; lhs: Expr; rhs: Expr; nonblocking: boolean; loc: Loc }
  | { k: 'if'; cond: Expr; then: Stmt[]; else: Stmt[] | null; loc: Loc }
  | { k: 'case'; kind: 'case' | 'casez' | 'casex'; sel: Expr; items: CaseItem[]; loc: Loc };

export interface EdgeRef { edge: 'posedge' | 'negedge'; signal: string; loc: Loc }
export type Sens = { type: 'star' } | { type: 'edges'; edges: EdgeRef[] } | { type: 'levels'; signals: string[] };
export interface AlwaysBlock { kind: 'always' | 'always_comb' | 'always_ff' | 'always_latch'; sens: Sens; body: Stmt[]; loc: Loc }

export interface PortConn { port: string | null; expr: Expr | null; loc: Loc }
export interface ParamOverride { name: string | null; expr: Expr }
export interface Instance { module: string; name: string; params: ParamOverride[]; conns: PortConn[]; loc: Loc }
export interface SkippedItem { what: string; loc: Loc; assigned: string[] }

export interface ModuleAst {
  name: string;
  loc: Loc;
  params: ParamDecl[];
  ports: PortDecl[];
  nets: NetDecl[];
  assigns: ContAssign[];
  always: AlwaysBlock[];
  instances: Instance[];
  skipped: SkippedItem[];
}
