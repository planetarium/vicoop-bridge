import { createRequire } from 'node:module';

// The deliberately small common surface of bun:sqlite and better-sqlite3.
export interface CallerDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...values: (string | number | null)[]): unknown;
    get(...values: (string | number | null)[]): unknown;
    all(...values: (string | number | null)[]): unknown[];
  };
  close(): void;
}

export async function openCallerDatabase(
  path: string,
): Promise<CallerDatabase> {
  if (process.versions.bun) {
    // Bun ships SQLite in the standalone release binary. No native addon is bundled.
    const moduleName: string = 'bun:sqlite';
    const { Database } = await import(moduleName);
    return new Database(path);
  }
  // Resolve only on Node: preserve Node 20 support without making Bun's
  // cross-platform compiler embed a host-specific better-sqlite3 native addon.
  const Database = createRequire(import.meta.url)('better-sqlite3');
  return new Database(path);
}
