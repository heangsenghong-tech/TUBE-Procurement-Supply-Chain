import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

export async function runMigrations(url: string) {
  const { db, sql } = createDb(url);
  const here = path.dirname(fileURLToPath(import.meta.url));
  // In the bundled build migrations sit next to dist/index.js; in dev next to this file.
  const folder = process.env.MIGRATIONS_DIR ?? path.join(here, 'migrations');
  await migrate(db, { migrationsFolder: folder });
  await sql.end();
}
