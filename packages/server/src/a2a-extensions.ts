export const A2A_EXTENSIONS_HEADER = 'X-A2A-Extensions';
export const A2A_EXTENSIONS_LEGACY_HEADER = 'A2A-Extensions';

export function parseA2AExtensionsHeader(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    const uri = part.trim();
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    out.push(uri);
  }
  return out;
}
