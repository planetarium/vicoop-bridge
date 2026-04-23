export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ...fields, event, ts: new Date().toISOString() }));
}

// Cap caller-controlled strings before logging to bound line size and limit
// inadvertent disclosure. Adds a marker so truncation is visible in logs.
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[+${value.length - max}]`;
}
