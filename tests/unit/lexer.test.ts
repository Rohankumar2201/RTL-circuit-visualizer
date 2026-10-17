import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/parser/lexer';

const texts = (s: string): string[] => tokenize(s).tokens.filter((t) => t.kind !== 'eof').map((t) => t.text);

describe('lexer', () => {
  it('tracks line and column positions', () => {
    const { tokens } = tokenize('module m;\n  assign y = a;\nendmodule');
    const assign = tokens.find((t) => t.text === 'assign')!;
    expect([assign.line, assign.col]).toEqual([2, 3]);
    const end = tokens.find((t) => t.text === 'endmodule')!;
    expect([end.line, end.col]).toEqual([3, 1]);
  });

  it('keeps line numbers correct across comments', () => {
    const { tokens } = tokenize('// one\n/* two\nthree */ wire w;');
    const w = tokens.find((t) => t.text === 'wire')!;
    expect(w.line).toBe(3);
    expect(w.col).toBe(10);
  });

  it('lexes based and sized numbers', () => {
    expect(texts("8'hFF 'b1 4'sd3 12_000 4'b10xz")).toEqual(["8'hFF", "'b1", "4'sd3", '12_000', "4'b10xz"]);
    expect(tokenize("8'hFF").tokens[0].kind).toBe('num');
  });

  it('prefers longest operators', () => {
    expect(texts('a <<< b === c ~^ d <= e >> f')).toEqual(['a', '<<<', 'b', '===', 'c', '~^', 'd', '<=', 'e', '>>', 'f']);
  });

  it('separates keywords from identifiers', () => {
    const kinds = tokenize('always_ff my_always').tokens.map((t) => t.kind);
    expect(kinds).toEqual(['kw', 'id', 'eof']);
  });

  it('reports unexpected characters with a location', () => {
    const { diagnostics } = tokenize('wire a;\nwire \\b;');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: 'error', line: 2, col: 6 });
  });

  it('reports unterminated block comments', () => {
    const { diagnostics } = tokenize('wire a; /* never closed');
    expect(diagnostics[0].message).toMatch(/Unterminated block comment/);
  });

  it('ignores compiler directives with an informational note', () => {
    const { tokens, diagnostics } = tokenize('`timescale 1ns/1ps\nwire a;');
    expect(tokens[0].text).toBe('wire');
    expect(diagnostics[0].severity).toBe('info');
  });
});
