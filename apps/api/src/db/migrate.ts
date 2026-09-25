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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  runMigrations(url).then(() => console.log('Migrations applied.'));
}
