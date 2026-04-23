export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ...fields, event, ts: new Date().toISOString() }));
}
