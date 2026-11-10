import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: Db;
  close(): void;
}

/**
 * 打开 SQLite 并跑迁移。
 *
 * 用 `better-sqlite3` 而不是 `node:sqlite`：后者在 Node 22 仍打印
 * ExperimentalWarning，API 也可能变。前者是预编译二进制，`pnpm i` 即装好。
 */
export async function openDatabase(dataDir: string, migrationsDir: string): Promise<DatabaseHandle> {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, 'hongguo.db');

  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });

  return {
    db,
    close: () => {
      sqlite.close();
    },
  };
}
