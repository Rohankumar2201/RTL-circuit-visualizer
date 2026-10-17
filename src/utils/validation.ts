import type { Diagnostic } from '../parser/diagnostics';

export const MAX_SOURCE_CHARS = 200_000;
export const MAX_MODULES = 100;
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export const isValidIdentifier = (s: string): boolean => IDENT.test(s);

export function validateSource(src: string): Diagnostic[] {
  if (src.length > MAX_SOURCE_CHARS) {
    return [{ severity: 'error', category: 'limits', message: `Source is ${src.length.toLocaleString()} characters; the limit is ${MAX_SOURCE_CHARS.toLocaleString()}` }];
  }
  return [];
}
