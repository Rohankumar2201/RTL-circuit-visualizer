/** Strips control characters so labels are safe to show and to use in file names. */
export function sanitizeLabel(s: string, max = 80): string {
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

export function fileSafeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'circuit';
}
